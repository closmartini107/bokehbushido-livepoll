// ============================================================
//  BokehBushido LivePoll — Google Apps Script Backend
//  1. Go to script.google.com → New Project
//  2. Paste this entire file, replacing the default code
//  3. Set your API key below
//  4. Click Deploy → New Deployment → Web App
//     - Execute as: Me
//     - Who has access: Anyone
//  5. Copy the Web App URL into host.html and overlay.html
// ============================================================

const API_KEY       = 'PASTE_YOUR_YOUTUBE_API_KEY_HERE'; // ← your key
const CHANNEL_HANDLE = '@bokehbushido';

const PROPS = PropertiesService.getScriptProperties();

// ── Entry point ──────────────────────────────────────────────
function doGet(e) {
  const action = (e.parameter.action || 'getState');
  let result;

  try {
    if      (action === 'getState')   result = getState();
    else if (action === 'launchPoll') result = launchPoll(e.parameter);
    else if (action === 'closePoll')  result = closePoll();
    else if (action === 'resetPoll')  result = resetPoll();
    else                              result = { error: 'Unknown action' };
  } catch(err) {
    result = { error: err.toString() };
  }

  return ContentService
    .createTextOutput(JSON.stringify(result))
    .setMimeType(ContentService.MimeType.JSON);
}

// ── State helpers ────────────────────────────────────────────
function getState() {
  const raw = PROPS.getProperty('pollState');
  return raw ? JSON.parse(raw) : defaultState();
}

function setState(s) {
  PROPS.setProperty('pollState', JSON.stringify(s));
}

function defaultState() {
  return {
    active:    false,
    open:      false,
    question:  '',
    options:   { a: '', b: '', c: '', d: '' },
    votes:     { a: 0,  b: 0,  c: 0,  d: 0 },
    voters:    {},       // channelId → 'a'/'b'/'c'/'d'
    chatId:    null,
    pageToken: null
  };
}

// ── Host: Launch poll ────────────────────────────────────────
function launchPoll(params) {
  // Find the active live broadcast for @bokehbushido
  const searchUrl =
    `https://www.googleapis.com/youtube/v3/search` +
    `?part=snippet&channelId=${getChannelId()}&eventType=live` +
    `&type=video&key=${API_KEY}`;

  const searchRes  = UrlFetchApp.fetch(searchUrl, { muteHttpExceptions: true });
  const searchData = JSON.parse(searchRes.getContentText());

  if (!searchData.items || !searchData.items.length) {
    return { error: 'No live stream found for @bokehbushido right now. Make sure you are live on YouTube.' };
  }

  const videoId = searchData.items[0].id.videoId;

  // Get the liveChatId from the video
  const vidUrl =
    `https://www.googleapis.com/youtube/v3/videos` +
    `?part=liveStreamingDetails&id=${videoId}&key=${API_KEY}`;

  const vidRes  = UrlFetchApp.fetch(vidUrl, { muteHttpExceptions: true });
  const vidData = JSON.parse(vidRes.getContentText());

  const chatId = vidData.items?.[0]?.liveStreamingDetails?.activeLiveChatId;
  if (!chatId) return { error: 'Could not get live chat ID. Is your stream live and chat enabled?' };

  // Build new poll state
  const s       = defaultState();
  s.active      = true;
  s.open        = true;
  s.chatId      = chatId;
  s.question    = (params.question || '').trim();
  s.options     = {
    a: (params.optA || '').trim(),
    b: (params.optB || '').trim(),
    c: (params.optC || '').trim(),
    d: (params.optD || '').trim()
  };
  setState(s);

  // Kick off the chat reader trigger (every minute — fastest Apps Script allows)
  deleteTriggers();
  ScriptApp.newTrigger('readChat').timeBased().everyMinutes(1).create();

  return { success: true, chatId, videoId };
}

// ── Host: Close poll ─────────────────────────────────────────
function closePoll() {
  const s  = getState();
  s.open   = false;
  setState(s);
  deleteTriggers();
  return { success: true };
}

// ── Host: Reset poll ─────────────────────────────────────────
function resetPoll() {
  setState(defaultState());
  deleteTriggers();
  return { success: true };
}

// ── Chat reader (runs on 1-minute trigger) ───────────────────
function readChat() {
  const s = getState();
  if (!s.active || !s.open || !s.chatId) return;

  const filledOpts = ['a','b','c','d'].filter(l => s.options[l]);
  let url =
    `https://www.googleapis.com/youtube/v3/liveChatMessages` +
    `?liveChatId=${s.chatId}&part=snippet,authorDetails` +
    `&key=${API_KEY}&maxResults=200`;
  if (s.pageToken) url += `&pageToken=${s.pageToken}`;

  try {
    const res  = UrlFetchApp.fetch(url, { muteHttpExceptions: true });
    const data = JSON.parse(res.getContentText());
    if (data.error) { Logger.log('Chat error: ' + JSON.stringify(data.error)); return; }

    s.pageToken = data.nextPageToken || s.pageToken;

    (data.items || []).forEach(item => {
      const channelId = item.authorDetails?.channelId;
      if (!channelId) return;
      if (s.voters[channelId]) return; // one vote per person

      const msg  = (item.snippet?.displayMessage || '').trim().toUpperCase();
      // Accept: A, B, C, D  — also accept !A !B !C !D for clarity
      const clean = msg.replace(/^!/, '');
      const vote  = ['A','B','C','D'].includes(clean) ? clean.toLowerCase() : null;

      if (!vote || !filledOpts.includes(vote)) return;

      s.votes[vote]++;
      s.voters[channelId] = vote;
    });

    setState(s);
  } catch(err) {
    Logger.log('readChat error: ' + err);
  }
}

// ── Utility: get channel ID from handle ──────────────────────
function getChannelId() {
  const cached = PROPS.getProperty('channelId');
  if (cached) return cached;

  const url =
    `https://www.googleapis.com/youtube/v3/channels` +
    `?part=id&forHandle=${encodeURIComponent(CHANNEL_HANDLE)}&key=${API_KEY}`;
  const res  = UrlFetchApp.fetch(url, { muteHttpExceptions: true });
  const data = JSON.parse(res.getContentText());
  const id   = data.items?.[0]?.id;
  if (id) PROPS.setProperty('channelId', id);
  return id;
}

function deleteTriggers() {
  ScriptApp.getProjectTriggers().forEach(t => ScriptApp.deleteTrigger(t));
}

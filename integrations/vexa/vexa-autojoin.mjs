#!/usr/bin/env node
/**
 * Vexa auto-join orchestration. Two modes:
 *   node vexa-autojoin.mjs dispatch   # poll calendar, send a bot to imminent meetings
 *   node vexa-autojoin.mjs collect    # pull finished transcripts -> gbrain meeting pages
 *
 * Calendar is read through Composio (GOOGLECALENDAR_EVENTS_LIST, project key,
 * user_id auto-resolved from the connected googlecalendar account). The bot is
 * dispatched to Vexa cloud (POST /bots). Transcripts are written as `meeting`-typed
 * pages into an isolated gbrain source (vexa-meetings) so facts extraction can run.
 *
 * Secrets (env, or read from 1Password if absent):
 *   COMPOSIO_API_KEY  (1P: "composio project api key" / credential)
 *   VEXA_API_KEY      (1P: "vexa.ai meeting bot" / credential)
 *
 * State (dedupe): ~/.gbrain/state/vexa-dispatched.json
 */
import { execSync } from 'child_process';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join } from 'path';
import os from 'os';

const COMPOSIO_BASE = 'https://backend.composio.dev/api/v3';
const VEXA_BASE = 'https://api.cloud.vexa.ai';
const STATE_DIR = join(os.homedir(), '.gbrain', 'state');
const DISPATCH_STATE = join(STATE_DIR, 'vexa-dispatched.json');
const MEETINGS_SRC = join(os.homedir(), '.gbrain', 'sources', 'vexa-meetings');
const JOIN_WINDOW_MIN = 10;    // dispatch a bot when a meeting starts within this forward window
const LOOKBACK_MIN = 10;       // also catch meetings already underway (started up to this many min ago)
const op = (item) => { try { return execSync(`/home/claude/bin/op read 'op://api keys/${item}/credential'`, { encoding: 'utf8' }).trim(); } catch { return ''; } };
const COMPOSIO_API_KEY = process.env.COMPOSIO_API_KEY || op('composio project api key');
const VEXA_API_KEY = process.env.VEXA_API_KEY || op('vexa.ai meeting bot');

// C3 2026-07-16 (operator msg 20328): a Vexa bot joins Google Meet as an ANONYMOUS browser guest
// (no Google account, no invitable email — so "invite the bot as a calendar guest" is impossible;
// admission is host-controlled from the Meet lobby). The one lever the API exposes is bot_name, a
// cosmetic display label (defaults to "Vexa"/"VexaBot-xxxxx"). A host is far likelier to admit a
// recognizable, clearly-labeled notetaker than an anonymous "VexaBot-", so we name it. This does
// NOT bypass the lobby; the Fathom hourly sync remains the guaranteed capture net.
const BOT_NAME = process.env.VEXA_BOT_NAME || 'King of Automation Notetaker';
const botBody = (meet) => JSON.stringify(
  meet.passcode
    ? { platform: meet.platform, native_meeting_id: meet.native_meeting_id, passcode: meet.passcode, bot_name: BOT_NAME }
    : { platform: meet.platform, native_meeting_id: meet.native_meeting_id, bot_name: BOT_NAME }
);

async function composio(path, opts = {}) {
  const r = await fetch(COMPOSIO_BASE + path, { ...opts, headers: { 'x-api-key': COMPOSIO_API_KEY, 'Content-Type': 'application/json', ...(opts.headers || {}) } });
  return { status: r.status, json: await r.json().catch(() => null) };
}
async function vexa(path, opts = {}) {
  const r = await fetch(VEXA_BASE + path, { ...opts, headers: { 'X-API-Key': VEXA_API_KEY, 'Content-Type': 'application/json', ...(opts.headers || {}) } });
  return { status: r.status, json: await r.json().catch(() => null) };
}
function loadState() { try { return JSON.parse(readFileSync(DISPATCH_STATE, 'utf8')); } catch { return { dispatched: {}, ingested: {} }; } }
function saveState(s) { if (!existsSync(STATE_DIR)) mkdirSync(STATE_DIR, { recursive: true }); writeFileSync(DISPATCH_STATE, JSON.stringify(s, null, 2)); }

// Resolve ALL active googlecalendar CONNECTIONS. The operator connected several Google
// accounts (gmail x2 + kingofautomation) under the SAME entity user_id "koa"; deduping by
// user_id made Composio resolve to a single default connection and silently miss the others
// (root cause of the 2026-06-07 "scheduled meeting not joined" bug). Keep each connection.
async function calendarConnections() {
  const { json } = await composio('/connected_accounts?limit=200');
  const items = json?.items || json?.data || [];
  return items
    .filter(a => String(a.toolkit?.slug || '').toLowerCase() === 'googlecalendar' && a.status === 'ACTIVE')
    .map(a => ({ id: a.id, user_id: a.user_id }))
    .filter(a => a.id && a.user_id);
}

// All calendars the operator can write on for a connection (skip read-only holiday calendars).
async function ownedCalendarIds(user_id, connected_account_id) {
  const { json } = await composio('/tools/execute/GOOGLECALENDAR_LIST_CALENDARS', {
    method: 'POST', body: JSON.stringify({ user_id, connected_account_id, arguments: {} }),
  });
  // Composio's GOOGLECALENDAR_LIST_CALENDARS returns the list under data.calendars (schema drift
  // seen 2026-07-10; it was data.items). Read the current key first, keep the old keys as fallback
  // so a future upstream revert can't silently re-break us. Without this the filter below always
  // emptied -> silent ['primary'] fallback, so every non-primary OWNED calendar was skipped.
  const items = json?.data?.calendars || json?.data?.items || json?.response_data?.items || json?.items || [];
  const ids = items.filter(c => ['owner', 'writer'].includes(c.accessRole)).map(c => c.id);
  return ids.length ? ids : ['primary'];
}

// Pull platform + native_meeting_id from an event's conferencing data.
function extractMeeting(ev) {
  const link = ev.hangoutLink || (ev.conferenceData?.entryPoints || []).find(e => e.entryPointType === 'video')?.uri || '';
  let m;
  if ((m = link.match(/meet\.google\.com\/([a-z]+-[a-z]+-[a-z]+)/i))) return { platform: 'google_meet', native_meeting_id: m[1], link };
  if ((m = link.match(/zoom\.us\/j\/(\d+)/i))) {
    const pwd = (link.match(/[?&]pwd=([^&\s]+)/i) || [])[1] || '';   // Zoom NEEDS the pwd token as passcode, else the bot stalls in needs_human_help
    return { platform: 'zoom', native_meeting_id: m[1], link, passcode: pwd };
  }
  if (/teams\.microsoft\.com/i.test(link)) return { platform: 'teams', native_meeting_id: link, link };
  return null;
}

async function dispatch() {
  const state = loadState();
  const conns = await calendarConnections();
  if (!conns.length) { console.log(JSON.stringify({ error: 'no active googlecalendar account' })); return; }
  const now = new Date();
  // Look BACK as well as forward: a meeting already underway (or first seen a few minutes late) must
  // still get a bot, not be excluded because timeMin==now. Google filters by event END time > timeMin,
  // so a meeting that already finished stays excluded; dedup by dispKey prevents any double-join.
  const timeMin = new Date(now.getTime() - LOOKBACK_MIN * 60000);
  const timeMax = new Date(now.getTime() + JOIN_WINDOW_MIN * 60000);
  // Poll EVERY connection and EVERY owned calendar within it; merge events (tagged with connId).
  const events = [];
  for (const conn of conns) {
    let calIds;
    try { calIds = await ownedCalendarIds(conn.user_id, conn.id); } catch { calIds = ['primary']; }
    for (const calendarId of calIds) {
      const { json } = await composio('/tools/execute/GOOGLECALENDAR_EVENTS_LIST', {
        method: 'POST',
        body: JSON.stringify({ user_id: conn.user_id, connected_account_id: conn.id, arguments: { calendarId, timeMin: timeMin.toISOString(), timeMax: timeMax.toISOString(), singleEvents: true, orderBy: 'startTime', maxResults: 20 } }),
      });
      const evs = json?.data?.items || json?.response_data?.items || json?.items || [];
      for (const e of evs) events.push({ ev: e, connId: conn.id });
    }
  }
  const acted = [];
  for (const { ev, connId } of events) {
    // Policy: only join meetings the operator is attending (organizer or accepted).
    const self = (ev.attendees || []).find(a => a.self);
    const attending = ev.organizer?.self || (self && self.responseStatus === 'accepted') || !ev.attendees;
    const meet = extractMeeting(ev);
    if (!attending || !meet) continue;
    const dispKey = `${connId}:${ev.id}`;                 // event ids are per-calendar; namespace by connection
    if (state.dispatched[dispKey]) continue;
    const res = await vexa('/bots', { method: 'POST', body: botBody(meet) });
    state.dispatched[dispKey] = { at: now.toISOString(), platform: meet.platform, native_meeting_id: meet.native_meeting_id, title: ev.summary || '', vexa_status: res.status };
    acted.push({ title: ev.summary, ...meet, vexa_status: res.status });
  }
  saveState(state);
  console.log(JSON.stringify({ mode: 'dispatch', connections: conns.length, events: events.length, dispatched: acted }, null, 2));
}

async function collect() {
  const state = loadState();
  if (!existsSync(MEETINGS_SRC)) mkdirSync(MEETINGS_SRC, { recursive: true });
  const { status, json } = await vexa('/meetings');
  // C3 2026-07-16: a non-200 here (expired/rotated key) used to be indistinguishable from
  // "no meetings" - total:0 forever with zero failure signal. Surface it loudly.
  if (status !== 200) console.error(`[vexa-collect] GET /meetings HTTP ${status} - auth/API failure, transcript collection is BLIND until fixed`);
  const meetings = json?.meetings || [];
  const written = [];
  for (const mtg of meetings) {
    const id = String(mtg.id || mtg.native_meeting_id || `${mtg.platform}_${mtg.start_time}`);
    if (state.ingested[id]) continue;
    // fetch transcript. segments live at /transcripts/{platform}/{id}; /meetings/{p}/{id} returns 405 (fixed 2026-06-06).
    const { json: t } = await vexa(`/transcripts/${mtg.platform}/${mtg.native_meeting_id || id}`);
    const segs = t?.segments || t?.transcript || [];
    if (!segs.length) continue;   // not finished yet; try again next run
    const date = (mtg.start_time || '').slice(0, 10);
    const speakers = [...new Set(segs.map(s => s.speaker).filter(Boolean))];
    const fm = ['---', 'type: meeting', `source_id: vexa_${id}`, 'source_type: vexa',
      `title: ${JSON.stringify(mtg.title || mtg.summary || 'Meeting')}`, `date: ${date}`,
      `location: ${mtg.platform}`, `participants: [${speakers.join(', ')}]`, '---', '', `# ${mtg.title || 'Meeting'}`, '', '## Transcript'].join('\n');
    const body = segs.map(s => {
      const tm = (s.start || s.timestamp || '').toString();
      const hhmm = (tm.match(/(\d{1,2}):(\d{2})/) || [,'00','00']).slice(1, 3).join(':');
      return `**${s.speaker || 'Speaker'}** (${date} ${hhmm}): ${(s.text || '').trim()}`;
    }).join('\n\n');
    writeFileSync(join(MEETINGS_SRC, `${id}.md`), fm + '\n' + body + '\n');
    state.ingested[id] = { at: new Date().toISOString(), title: mtg.title };
    written.push(id);
  }
  saveState(state);
  console.log(JSON.stringify({ mode: 'collect', http: status, total: meetings.length, written }, null, 2));
}

// Impromptu: join a meeting on the spot from a pasted URL (no calendar event needed).
//   node vexa-autojoin.mjs join "https://meet.google.com/abc-defg-hij"
async function joinMeeting(url) {
  if (!url) { console.log(JSON.stringify({ error: 'usage: join <meeting-url>' })); return; }
  const meet = extractMeeting({ hangoutLink: url });
  if (!meet) { console.log(JSON.stringify({ error: 'unrecognized meeting URL', url })); return; }
  const res = await vexa('/bots', { method: 'POST', body: botBody(meet) });
  const state = loadState();
  const key = `impromptu_${meet.platform}_${meet.native_meeting_id}`;
  state.dispatched[key] = { at: new Date().toISOString(), platform: meet.platform, native_meeting_id: meet.native_meeting_id, title: 'impromptu', vexa_status: res.status };
  saveState(state);
  console.log(JSON.stringify({ mode: 'join', ...meet, vexa_status: res.status, vexa_response: res.json }, null, 2));
}

// Scan a designated Telegram topic JSON for meeting links and join any not yet dispatched.
//   node vexa-autojoin.mjs watch-topic /home/claude/sessions/shared/topics/mXXXX_YYY.json
async function watchTopic(file) {
  if (!file || !existsSync(file)) { console.log(JSON.stringify({ error: 'topic file not found', file })); return; }
  const state = loadState();
  const data = JSON.parse(readFileSync(file, 'utf8'));
  const msgs = Array.isArray(data) ? data : (data.messages || data.history || []);
  const rx = /(https?:\/\/[^\s]*(?:meet\.google\.com|zoom\.us\/j\/|teams\.microsoft\.com)[^\s]*)/ig;
  const acted = [];
  for (const m of msgs) {
    const text = (m.text || m.content || '') + '';
    let match;
    while ((match = rx.exec(text))) {
      const meet = extractMeeting({ hangoutLink: match[1] });
      if (!meet) continue;
      const key = `topic_${meet.platform}_${meet.native_meeting_id}`;
      if (state.dispatched[key]) continue;
      const res = await vexa('/bots', { method: 'POST', body: botBody(meet) });
      state.dispatched[key] = { at: new Date().toISOString(), ...meet, title: 'from-topic', vexa_status: res.status };
      acted.push({ ...meet, vexa_status: res.status });
    }
  }
  saveState(state);
  console.log(JSON.stringify({ mode: 'watch-topic', joined: acted }, null, 2));
}

const mode = process.argv[2];
if (mode === 'dispatch') await dispatch();
else if (mode === 'collect') await collect();
else if (mode === "join") await joinMeeting(process.argv[3]);
else if (mode === 'watch-topic') await watchTopic(process.argv[3]);
else { console.log('usage: vexa-autojoin.mjs dispatch|collect|join <url>|watch-topic <file>'); process.exit(1); }

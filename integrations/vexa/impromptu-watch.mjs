#!/usr/bin/env node
/**
 * impromptu-watch — gateway-independent Vexa impromptu join.
 *
 * Scans a Telegram topic JSON for operator messages that say /join|/vexa + a
 * meeting link, and dispatches a Vexa bot for any NEW meeting. Reads the topic
 * file directly, so it does NOT depend on the gateway message:received hook,
 * the mention gate, or gateway stability. Idempotent: dedup by meeting id,
 * seeded on first run so historical/dead links are never (re)joined.
 *
 * Usage: node impromptu-watch.mjs <topic-json-path>
 * Run from cron every minute. OP_SERVICE_ACCOUNT_TOKEN must be in env so the
 * child `vexa-autojoin.mjs join` can read the Vexa API key from 1Password.
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { execFileSync } from 'child_process';
import { homedir } from 'os';
import { join } from 'path';

const TOPIC = process.argv[2];
if (!TOPIC || !existsSync(TOPIC)) { console.log(JSON.stringify({ error: 'topic file not found', TOPIC })); process.exit(0); }

const STATE_DIR = join(homedir(), '.gbrain', 'state');
const STATE     = join(STATE_DIR, 'vexa-impromptu-seen.json');
const AUTOJOIN  = join(homedir(), 'gbrain', 'integrations', 'vexa', 'vexa-autojoin.mjs');

const INTENT = /(?:^|\s|\/)(?:join|vexa)\b/i;                 // operator must signal intent
const LINK   = /(https?:\/\/[^\s\]"']*(?:meet\.google\.com|zoom\.us\/j\/|teams\.microsoft\.com|teams\.live\.com)[^\s\]"']*)/ig;

function loadState(){ try { return JSON.parse(readFileSync(STATE,'utf8')); } catch { return { seeded:false, seen:[] }; } }
function saveState(s){ if(!existsSync(STATE_DIR)) mkdirSync(STATE_DIR,{recursive:true}); writeFileSync(STATE, JSON.stringify(s,null,2)); }

function meetingId(raw){
  const u = raw.replace(/[\].,)]+$/,'');
  let m;
  if ((m=u.match(/meet\.google\.com\/([a-z0-9-]+)/i)))   return 'gmeet_'+m[1].toLowerCase();
  if ((m=u.match(/zoom\.us\/j\/(\d+)/i)))                 return 'zoom_'+m[1];
  if ((m=u.match(/teams\.(?:microsoft|live)\.com\/(\S+)/i))) return 'teams_'+m[1].slice(0,40);
  return null;
}

const data = JSON.parse(readFileSync(TOPIC,'utf8'));
const msgs = Array.isArray(data) ? data : (data.messages || data.history || []);
const state = loadState();
const seen = new Set(state.seen || []);

const found = []; // {id,url}
for (const mm of msgs){
  if (String(mm.role||'') !== 'user') continue;            // operator only; skip assistant/system
  const text = String(mm.text || mm.content || '');
  if (!INTENT.test(text)) continue;                         // require /join or /vexa intent
  let match; LINK.lastIndex = 0;
  while ((match = LINK.exec(text))){
    const url = match[1].replace(/[\].,)]+$/,'');
    const id = meetingId(url);
    if (id) found.push({ id, url });
  }
}

if (!state.seeded){                                          // first run: remember history, join nothing
  for (const f of found) seen.add(f.id);
  saveState({ seeded:true, seen:[...seen] });
  console.log(JSON.stringify({ mode:'impromptu-watch', action:'seeded', count:seen.size }));
  process.exit(0);
}

const joined = [], failed = [];
for (const f of found){
  if (seen.has(f.id)) continue;
  try { execFileSync('node',[AUTOJOIN,'join',f.url],{ stdio:'ignore', timeout:60000 }); joined.push(f.url); }
  catch(e){ failed.push({ url:f.url, err:String(e.message||e).slice(0,120) }); }
  seen.add(f.id);                                           // mark seen even on failure (avoid retry storm)
}
saveState({ seeded:true, seen:[...seen] });
console.log(JSON.stringify({ mode:'impromptu-watch', joined, failed }));

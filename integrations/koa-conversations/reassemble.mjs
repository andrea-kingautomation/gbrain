#!/usr/bin/env node
// Reassemble the 1470 per-turn `conversation_turn` shards into full `conversation`
// pages (one per parent_file), so gbrain's facts extractor (which reads whole
// conversations) can produce facts. Isolated source -> no pollution of `default`.
import { readFileSync, writeFileSync, readdirSync, mkdirSync, existsSync } from 'fs';
import { join } from 'path';

const SRC = '/home/claude/.gbrain/sources/koa-conversations';
const OUT = '/home/claude/.gbrain/sources/koa-conversations-assembled';
if (!existsSync(OUT)) mkdirSync(OUT, { recursive: true });

function parseFrontmatter(text) {
  const m = text.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!m) return { fm: {}, body: text };
  const fm = {};
  for (const line of m[1].split('\n')) {
    const mm = line.match(/^([a-z_]+):\s*(.*)$/i);
    if (mm) fm[mm[1]] = mm[2].replace(/^"(.*)"$/, '$1').trim();
  }
  return { fm, body: m[2] };
}

// body of a shard: an H1 line then `**[ts] author** (role):` + message.
// Strip the H1; keep the rest as the rendered turn.
function turnBlock(body) {
  // strip the shard's leading H1, then its "**[ts] author** (role):" prefix line
  let b = body.replace(/^\s*#\s.*?(?:\n|$)/, '');
  b = b.replace(/^\s*\*\*\[[^\]]*\][^\n]*:\s*/, '');
  return b.trim();
}
// Render a speaker line that matches gbrain conversation-parser builtin
// `**Speaker** (YYYY-MM-DD HH:MM): text` (builtins.ts:65) so messages parse.
function speakerLine(author, ts, fallbackDate, msg) {
  const m = (ts || '').match(/(\d{4}-\d{2}-\d{2})\s+(\d{1,2}):(\d{2})/);
  const stamp = m ? `${m[1]} ${m[2]}:${m[3]}` : `${fallbackDate || '1970-01-01'} 00:00`;
  return `**${author}** (${stamp}): ${msg}`;
}

const files = readdirSync(SRC).filter(f => f.endsWith('.md'));
const groups = new Map(); // parent_file -> [{turn_number, fm, block}]
for (const f of files) {
  const { fm, body } = parseFrontmatter(readFileSync(join(SRC, f), 'utf8'));
  const parent = fm.parent_file || f;
  if (!groups.has(parent)) groups.set(parent, []);
  groups.get(parent).push({
    turn: parseInt(fm.turn_number || '0', 10),
    ts: fm.timestamp || fm.date || '',
    author: fm.author || 'unknown',
    role: fm.role || '',
    chat_id: fm.chat_id || '',
    topic_id: fm.topic_id || '',
    seat: fm.seat || '',
    title: fm.title || '',
    block: turnBlock(body),
  });
}

let written = 0;
for (const [parent, turns] of groups) {
  turns.sort((a, b) => (a.turn - b.turn) || a.ts.localeCompare(b.ts));
  const first = turns[0];
  const chat = first.chat_id, topic = first.topic_id;
  const participants = [...new Set(turns.map(t => t.author).filter(Boolean))];
  const dates = turns.map(t => t.ts).filter(Boolean).sort();
  const date = (dates[0] || '').slice(0, 10);
  // Title: prefer a clean "Topic NNNN" label from the parent shard titles.
  const titleBase = (first.title || `Topic ${topic}`).replace(/\s*[—-]\s*\S.*turn\s*\d+.*$/i, '').trim()
                    || `Topic ${topic}`;
  const sourceId = `koa_conv_${chat}_${topic}`.replace(/[^a-zA-Z0-9_]/g, '');

  const fm = [
    '---',
    'type: conversation',
    `source_id: ${sourceId}`,
    'source_type: telegram_backfill',
    `title: ${JSON.stringify(titleBase)}`,
    `date: ${date}`,
    `chat_id: ${JSON.stringify(chat)}`,
    `topic_id: ${JSON.stringify(topic)}`,
    `seat: ${first.seat}`,
    `participants: [${participants.join(', ')}]`,
    `turns: ${turns.length}`,
    '---',
    '',
    `# ${titleBase}`,
    '',
  ].join('\n');

  const bodyText = turns.filter(t => t.block).map(t => speakerLine(t.author, t.ts, date, t.block)).join('\n\n');
  const outName = parent.replace(/\.md$/, '') + '.md';
  writeFileSync(join(OUT, outName), fm + bodyText + '\n', 'utf8');
  written++;
}

console.log(JSON.stringify({ shards: files.length, conversations: groups.size, written, out: OUT }));

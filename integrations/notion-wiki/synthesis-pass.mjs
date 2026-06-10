#!/usr/bin/env node
/**
 * synthesis-pass.mjs - a controlled, source-scoped elaboration pass.
 *
 * WHY THIS EXISTS (not the native dream cycle):
 *   The native `gbrain dream` synthesize phase reads ONE global corpus
 *   (dream.synthesize.session_corpus_dir, currently the business corpus) and
 *   its subagent put_page is hardcoded to write into the FEDERATED `default`
 *   source (src/core/minions/tools/brain-allowlist.ts:215). `default` is
 *   readable by every agent, so routing personal content through it would
 *   breach the personal/business wall. This pass instead reads a chosen
 *   corpus and writes its elaborated pages through the blessed, idempotent
 *   `gbrain import --source-id <id>` path with an EXPLICIT source, so personal
 *   reflections land in the ACL-walled `personal-synthesis` source and nowhere
 *   else. It is the per-source synthesis the operator's pipeline calls for:
 *     personal-conversations -> personal-synthesis
 *     koa-conversations      -> business-synthesis   (same tool, --source business-synthesis)
 *
 * WHAT IT DOES, per corpus transcript:
 *   1. content-hash the transcript (sha256, 6-hex suffix) for stable identity,
 *   2. skip if a page for that hash already exists in the target source (idempotent),
 *   3. ask the brain's own reasoning combo (OmniRoute koa-gbrain-reasoning) to
 *      distill reflections + original ideas, grounded and quoting the user
 *      verbatim, in our content-generation voice (no jargon, no em-dash),
 *   4. write each as a gbrain page markdown into the target source's brain dir,
 *   5. `gbrain import <dir> --source-id <target>` to upsert into the DB.
 *
 * USAGE
 *   node synthesis-pass.mjs --source personal-synthesis \
 *       --corpus /home/claude/.gbrain/sources/personal-conversations-assembled
 *   node synthesis-pass.mjs --source personal-synthesis --corpus <dir> --dry-run
 *   node synthesis-pass.mjs --source personal-synthesis --corpus <dir> --limit 1
 *
 * Run with the sandbox disabled (it calls localhost OmniRoute).
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";

const HOME = os.homedir();
const OMNI_URL = process.env.OMNIROUTE_URL || "http://127.0.0.1:20128/v1/chat/completions";
const OMNI_MODEL = process.env.OMNIROUTE_COMBO || "koa-gbrain-reasoning";
const GB_BIN = process.env.GBRAIN_BIN || "/home/claude/.bun/install/global/node_modules/gbrain/src/cli.ts";
const BUN = process.env.BUN_BIN || "/home/claude/.bun/bin/bun";

const argv = process.argv.slice(2);
const arg = (k, d = null) => { const i = argv.indexOf(k); return i >= 0 && i + 1 < argv.length ? argv[i + 1] : d; };
const DRY = argv.includes("--dry-run");
const SOURCE = arg("--source");
const CORPUS = arg("--corpus");
const OUT = arg("--out", SOURCE ? path.join(HOME, `.gbrain/sources/${SOURCE}-brain`) : null);
const LIMIT = parseInt(arg("--limit", "0"), 10) || 0;
const MIN_CHARS = parseInt(arg("--min-chars", "1500"), 10);

if (!SOURCE || !CORPUS) {
  console.error("usage: synthesis-pass.mjs --source <id> --corpus <dir> [--out <dir>] [--dry-run] [--limit N]");
  process.exit(2);
}

function dbUrl() { return JSON.parse(fs.readFileSync(path.join(HOME, ".gbrain/config.json"), "utf8")).database_url; }
function psql(sql) {
  return execFileSync("psql", [dbUrl(), "-At", "-F", "\x1f", "-c", sql], { encoding: "utf8" })
    .split("\n").filter(Boolean).map((r) => r.split("\x1f"));
}
const lit = (s) => "'" + String(s).replace(/'/g, "''") + "'";

function omniKey() {
  try {
    const env = fs.readFileSync(path.join(HOME, ".omniroute/.env"), "utf8");
    const m = env.match(/OMNIROUTE_API_KEY\s*=\s*(.+)/);
    return m ? m[1].trim() : process.env.OMNIROUTE_API_KEY;
  } catch { return process.env.OMNIROUTE_API_KEY; }
}

// Anti-jargon prose contract, same standard the topic pages use.
const WRITING_STANDARD = `WRITING STANDARD (follow exactly):
- Concrete before abstract. Open on the specific thing said or done, not a thesis statement.
- Quote the person verbatim where the phrasing is theirs and memorable. Use straight quotes.
- Plain language. Define any term that is not common English.
- BANNED words: seamless, game-changer, revolutionary, disruptive, empower, supercharge, unleash, elevate, robust, holistic, cutting-edge, unlock, leverage, synergy, paradigm.
- No em-dash and no en-dash anywhere. Use a comma or a full stop.
- Vary sentence openings and length. Honest, grounded, first-person-aware copy. No filler.`;

function synthPrompt(basename, hash6, dateHint, content) {
  return `You distill one conversation transcript into a person's private knowledge brain. Return ONLY JSON, no prose around it.

${WRITING_STANDARD}

OUTPUT: a JSON object {"pages": [ ... ]}. Each page is one of:
  - a REFLECTION (self-knowledge, a pattern the person names, how they think or decide, something they processed), OR
  - an ORIGINAL (a new idea, frame, thesis, or mental model the person articulated), OR
  - a PREFERENCE (a durable standard, taste, like or dislike, or rule the person holds, e.g. how they want work done, what they value, what they reject), OR
  - a DECISION (a specific choice the person made and the reason behind it, worth remembering).
This is a working channel, so the person mostly directs and decides rather than journals. Capture what is durable and true about THEM: how they think, what they want, what they decided and why. Skip pure logistics, scheduling, status pings, and one-off task chatter that says nothing lasting about the person. If a transcript genuinely holds nothing durable, return {"pages": []}, but do not set the bar so high that a real preference or decision is dropped.

Each page object:
{
  "kind": "reflection" | "original" | "preference" | "decision",
  "title": "short, concrete, no buzzwords",
  "topic_slug": "lowercase-hyphenated-3-to-6-words",
  "tags": ["1-4 lowercase-hyphen tags naming the SUBJECT"],
  "compiled_truth": "2-5 grounded paragraphs in the writing standard above. Quote the person verbatim at least once. Markdown allowed (no headings above ##)."
}

CONTEXT
- Today: ${dateHint}
- Transcript: ${basename}
- Use this exact hash suffix when asked: ${hash6}

TRANSCRIPT
---
${content}
---

Return the JSON object now.`;
}

async function callOmni(prompt) {
  const res = await fetch(OMNI_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${omniKey()}` },
    body: JSON.stringify({ model: OMNI_MODEL, messages: [{ role: "user", content: prompt }], temperature: 0.4, stream: false, max_tokens: 8000 }),
  });
  const raw = await res.text();
  if (!res.ok) throw new Error(`OmniRoute ${res.status}: ${raw.slice(0, 240)}`);
  let text = "";
  if (raw.trimStart().startsWith("data:")) {
    for (const line of raw.split("\n")) {
      const s = line.trim();
      if (!s.startsWith("data:")) continue;
      const payload = s.slice(5).trim();
      if (payload === "[DONE]") break;
      try { const d = JSON.parse(payload); text += d.choices?.[0]?.delta?.content || d.choices?.[0]?.message?.content || ""; } catch { /* skip */ }
    }
  } else {
    text = JSON.parse(raw).choices?.[0]?.message?.content || "";
  }
  return text;
}

const noDash = (s) => String(s)
  .replace(/\s*(?:—|&mdash;|&#8212;|&#x2014;)\s*/g, ", ")
  .replace(/(?:–|&ndash;|&#8211;|&#x2013;)/g, "-");

function parsePages(text) {
  let t = text.replace(/^[\s\S]*?```(?:json)?\s*/i, "").replace(/```[\s\S]*$/i, "").trim();
  const a = t.indexOf("{"); const b = t.lastIndexOf("}");
  if (a >= 0 && b > a) t = t.slice(a, b + 1);
  const obj = JSON.parse(t);
  return Array.isArray(obj.pages) ? obj.pages : [];
}

const slugify = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60);

function inferDate(content, fallback) {
  const m = content.match(/\b(20\d{2}-\d{2}-\d{2})\b/);
  return m ? m[1] : fallback;
}

// kind -> { gbrain page type (schema-valid), slug namespace }
const KIND_MAP = {
  reflection: { type: "reflection", ns: "wiki/personal/reflections" },
  original:   { type: "original",   ns: "wiki/originals/ideas" },
  preference: { type: "note",       ns: "wiki/personal/preferences" },
  decision:   { type: "note",       ns: "wiki/personal/decisions" },
};
const kindOf = (p) => KIND_MAP[p.kind] ? p.kind : "reflection";

const isHexNoise = (t) => /^[0-9a-f]{6}$/.test(t);

function pageMarkdown(p, { dateHint, provenance, hash6 }) {
  const k = kindOf(p);
  const { type } = KIND_MAP[k];
  const tags = (Array.isArray(p.tags) ? p.tags : []).map(slugify)
    .filter((t) => t && !isHexNoise(t)).slice(0, 4);
  const fm = [
    "---",
    `title: ${JSON.stringify(noDash(p.title || "Untitled"))}`,
    `type: ${type}`,
    `kind: ${k}`,
    `tags: [${tags.map((t) => JSON.stringify(t)).join(", ")}]`,
    `date: ${dateHint}`,
    `effective_date: ${dateHint}`,
    `source: ${JSON.stringify(provenance)}`,
    `transcript_hash_suffix: ${JSON.stringify(hash6)}`,
    "synthesis_pass: true",
    "---",
    "",
  ].join("\n");
  return fm + noDash(p.compiled_truth || "").trim() + "\n";
}

function pageSlug(p, dateHint, hash6) {
  const { ns } = KIND_MAP[kindOf(p)];
  // strip any hash the model echoed into topic_slug so we don't double-suffix
  const topic = slugify(p.topic_slug || p.title || "note").replace(new RegExp(`-?${hash6}$`), "");
  return `${ns}/${dateHint}-${topic}-${hash6}`;
}

// Already-synthesized? A page whose slug ends in -<hash6> in the target source.
function alreadyDone(hash6) {
  const rows = psql(`select count(*) from pages where source_id=${lit(SOURCE)} and deleted_at is null and slug like ${lit("%-" + hash6)};`);
  return Number(rows[0]?.[0] || 0) > 0;
}

async function main() {
  const files = fs.readdirSync(CORPUS).filter((f) => f.endsWith(".md")).sort();
  const todo = LIMIT ? files.slice(0, LIMIT) : files;
  fs.mkdirSync(OUT, { recursive: true });
  console.log(`[pass] source=${SOURCE} corpus=${CORPUS} files=${todo.length} out=${OUT}${DRY ? " (dry-run)" : ""}`);

  let written = 0, skipped = 0, processed = 0;
  for (const f of todo) {
    const full = path.join(CORPUS, f);
    const content = fs.readFileSync(full, "utf8");
    if (content.length < MIN_CHARS) { console.log(`[skip ] ${f} (${content.length} chars < ${MIN_CHARS})`); skipped++; continue; }
    const hash6 = crypto.createHash("sha256").update(content).digest("hex").slice(0, 6);
    if (alreadyDone(hash6)) { console.log(`[skip ] ${f} (hash ${hash6} already synthesized)`); skipped++; continue; }
    const basename = f.replace(/\.md$/, "");
    const provenance = basename.replace(/^m/, "m").replace(/_/g, "-");
    const dateHint = inferDate(content, new Date().toISOString().slice(0, 10));
    processed++;
    if (DRY) { console.log(`[dry  ] ${f} hash=${hash6} would synthesize`); continue; }

    let pages;
    try { pages = parsePages(await callOmni(synthPrompt(basename, hash6, dateHint, content.slice(0, 60000)))); }
    catch (e) { console.error(`[ERR  ] ${f}: ${e.message}`); continue; }
    if (!pages.length) { console.log(`[empty] ${f} (nothing cleared the bar)`); continue; }

    for (const p of pages) {
      const slug = pageSlug(p, dateHint, hash6);
      const dest = path.join(OUT, `${slug}.md`);
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.writeFileSync(dest, pageMarkdown(p, { dateHint, provenance, hash6 }));
      written++;
      console.log(`[write] ${slug} (${p.kind})`);
    }
  }

  console.log(`[pass] processed=${processed} pages_written=${written} skipped=${skipped}`);
  if (!DRY && written > 0) {
    console.log(`[import] gbrain import ${OUT} --source-id ${SOURCE}`);
    execFileSync(BUN, [GB_BIN, "import", OUT, "--source-id", SOURCE], { stdio: "inherit" });
  } else if (!DRY) {
    console.log("[import] nothing new to import");
  }
}
main().catch((e) => { console.error("[FATAL]", e.message); process.exit(1); });

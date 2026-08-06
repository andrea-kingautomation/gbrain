#!/usr/bin/env node
/**
 * gbrain -> Notion Wiki Publisher  (reflex: brain-to-notion)
 *
 * Publishes gbrain's LLM-maintained wiki pages into a dedicated, navigable
 * Notion database ("🧠 G-Brain Wiki"). One Notion page per wiki entry, with
 * Type / Category / Topics / Date / Source properties so the operator can
 * filter, group and scroll visually instead of guessing.
 *
 * Design principle (gbrain house style): "code for data, LLMs for judgment".
 * The LLM (gbrain dream/autopilot) maintains the *content*; this script does
 * the deterministic transport + structure. Categorisation is a cheap heuristic
 * by default, with an optional --categorize LLM pass via omniroute.
 *
 * Transport: Notion REST API (api.notion.com) with an Internal Integration
 * token. A headless daemon CANNOT drive an interactive-OAuth MCP, so a token
 * is the correct durable transport for a scheduled reflex.
 *
 * Token resolution order:
 *   1. $NOTION_API_KEY
 *   2. NOTION_API_KEY=... line in ~/.gbrain/secrets/notion-wiki.env
 *
 * Usage:
 *   node publish.mjs --dry-run            # parse + build payloads, no network
 *   node publish.mjs                      # incremental publish (changed only)
 *   node publish.mjs --full               # republish every page
 *   node publish.mjs --limit 5            # cap pages (testing)
 *   node publish.mjs --categorize         # LLM category pass via omniroute
 *   node publish.mjs --parent <page_id>   # parent page to host the DB
 *
 * State (db id + per-page mapping + content hashes):
 *   ~/.gbrain/integrations/notion-wiki/state.json
 */

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";

// ----------------------------------------------------------------------------
// config
// ----------------------------------------------------------------------------
const HOME = os.homedir();
const WIKI_DIR =
  process.env.GBRAIN_WIKI_DIR ||
  path.join(HOME, ".gbrain/sources/personal-conversations/wiki");
const STATE_DIR = path.join(HOME, ".gbrain/integrations/notion-wiki");
const STATE_FILE = path.join(STATE_DIR, "state.json");
const SECRET_FILE = path.join(HOME, ".gbrain/secrets/notion-wiki.env");

const NOTION_VERSION = "2022-06-28";
const NOTION_BASE = "https://api.notion.com/v1";

// omniroute (for optional --categorize)
const OMNIROUTE_BASE = process.env.OPENAI_BASE_URL || "http://127.0.0.1:20128/v1";
const OMNIROUTE_KEY = process.env.OPENAI_API_KEY || "omniroute-local";
const CATEGORIZE_MODEL = process.env.NOTION_WIKI_MODEL || "koa-default";

const DB_TITLE = "🧠 G-Brain Wiki";

// High-level categories for nav grouping. Pages always get exactly one.
const CATEGORIES = [
  "Business",
  "Product & Engineering",
  "Strategy & Ops",
  "Personal & Reflection",
  "Knowledge",
];

// args
const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);
const val = (f, d) => {
  const i = argv.indexOf(f);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : d;
};
const DRY_RUN = has("--dry-run");
const FULL = has("--full");
const CATEGORIZE = has("--categorize");
const LIMIT = parseInt(val("--limit", "0"), 10) || 0;
const PARENT_OVERRIDE = val("--parent", process.env.NOTION_PARENT_PAGE_ID || "");

// ----------------------------------------------------------------------------
// small utils
// ----------------------------------------------------------------------------
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sha = (s) => crypto.createHash("sha256").update(s).digest("hex").slice(0, 16);
const titleCase = (s) =>
  s.replace(/[-_]/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());

function loadState() {
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
  } catch {
    return { databaseId: null, parentPageId: null, pages: {} };
  }
}
function saveState(state) {
  fs.mkdirSync(STATE_DIR, { recursive: true });
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

function resolveToken() {
  if (process.env.NOTION_API_KEY) return process.env.NOTION_API_KEY.trim();
  try {
    const env = fs.readFileSync(SECRET_FILE, "utf8");
    const m = env.match(/^\s*NOTION_API_KEY\s*=\s*(.+)\s*$/m);
    if (m) return m[1].trim().replace(/^["']|["']$/g, "");
  } catch {}
  return null;
}

// ----------------------------------------------------------------------------
// frontmatter + markdown parsing
// ----------------------------------------------------------------------------
function parseFrontmatter(raw) {
  // returns { meta, body }
  if (!raw.startsWith("---")) return { meta: {}, body: raw };
  const end = raw.indexOf("\n---", 3);
  if (end < 0) return { meta: {}, body: raw };
  const fm = raw.slice(3, end).trim();
  const body = raw.slice(end + 4).replace(/^\s*\n/, "");
  const meta = {};
  let curKey = null;
  for (const line of fm.split("\n")) {
    const listItem = line.match(/^\s*-\s+(.*)$/);
    if (listItem && curKey) {
      (meta[curKey] = meta[curKey] || []).push(stripQuotes(listItem[1].trim()));
      continue;
    }
    const kv = line.match(/^([A-Za-z0-9_]+):\s*(.*)$/);
    if (kv) {
      const key = kv[1];
      const v = kv[2].trim();
      if (v === "") {
        meta[key] = []; // expecting a list to follow
        curKey = key;
      } else {
        meta[key] = stripQuotes(v);
        curKey = null;
      }
    }
  }
  return { meta, body };
}
function stripQuotes(s) {
  return s.replace(/^['"]|['"]$/g, "");
}

// Inline markdown -> Notion rich_text array.
// Handles **bold**, *italic*/_italic_, `code`, [text](url), [[wikilink]].
function inlineRichText(text) {
  // Normalise wikilinks [[slug]] -> their readable form (drop brackets).
  // gbrain wikilinks are page-internal; we keep them as plain emphasised text.
  const out = [];
  // tokenizer over a handful of markdown inline constructs
  const re =
    /(\*\*([^*]+)\*\*)|(`([^`]+)`)|(\[\[([^\]]+)\]\])|(\[([^\]]+)\]\(([^)]+)\))|(\*([^*]+)\*)|(_([^_]+)_)/g;
  let last = 0;
  let m;
  const push = (content, ann = {}, link = null) => {
    if (content === "") return;
    // Notion hard limit 2000 chars per rich_text content
    for (let i = 0; i < content.length; i += 1900) {
      const slice = content.slice(i, i + 1900);
      const rt = { type: "text", text: { content: slice } };
      if (link) rt.text.link = { url: link };
      if (Object.keys(ann).length) rt.annotations = ann;
      out.push(rt);
    }
  };
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) push(text.slice(last, m.index));
    if (m[1]) push(m[2], { bold: true });
    else if (m[3]) push(m[4], { code: true });
    else if (m[5]) push(m[6], { italic: true }); // wikilink -> italic readable
    else if (m[7]) push(m[8], {}, m[9]); // [text](url)
    else if (m[10]) push(m[11], { italic: true });
    else if (m[12]) push(m[13], { italic: true });
    last = re.lastIndex;
  }
  if (last < text.length) push(text.slice(last));
  if (out.length === 0) push(" ");
  return out.slice(0, 100); // Notion: max 100 rich_text per block
}

// Block-level markdown -> Notion block objects.
function markdownToBlocks(body) {
  const lines = body.replace(/\r/g, "").split("\n");
  const blocks = [];
  let para = [];
  const flushPara = () => {
    if (!para.length) return;
    const text = para.join(" ").trim();
    para = [];
    if (text)
      blocks.push({
        object: "block",
        type: "paragraph",
        paragraph: { rich_text: inlineRichText(text) },
      });
  };
  for (let raw of lines) {
    const line = raw.replace(/\s+$/, "");
    if (line.trim() === "") {
      flushPara();
      continue;
    }
    let m;
    if ((m = line.match(/^(#{1,3})\s+(.*)$/))) {
      flushPara();
      const lvl = m[1].length;
      const t = `heading_${lvl}`;
      blocks.push({
        object: "block",
        type: t,
        [t]: { rich_text: inlineRichText(m[2].trim()) },
      });
    } else if ((m = line.match(/^>\s?(.*)$/))) {
      flushPara();
      blocks.push({
        object: "block",
        type: "quote",
        quote: { rich_text: inlineRichText(m[1].trim() || " ") },
      });
    } else if ((m = line.match(/^\s*[-*]\s+(.*)$/))) {
      flushPara();
      blocks.push({
        object: "block",
        type: "bulleted_list_item",
        bulleted_list_item: { rich_text: inlineRichText(m[1].trim()) },
      });
    } else if ((m = line.match(/^\s*\d+\.\s+(.*)$/))) {
      flushPara();
      blocks.push({
        object: "block",
        type: "numbered_list_item",
        numbered_list_item: { rich_text: inlineRichText(m[1].trim()) },
      });
    } else if (line.match(/^\s*```/)) {
      // toggle code fence: collect until next fence
      flushPara();
      // handled inline below by simple skip-accumulate
      blocks.push({ __fence: true });
    } else {
      para.push(line.trim());
    }
  }
  flushPara();

  // collapse code fences (pairs of __fence markers) into code blocks
  const final = [];
  for (let i = 0; i < blocks.length; i++) {
    if (blocks[i].__fence) {
      const buf = [];
      i++;
      while (i < blocks.length && !blocks[i].__fence) {
        const b = blocks[i];
        const rt =
          b[b.type]?.rich_text?.map((r) => r.text?.content || "").join("") || "";
        buf.push(rt);
        i++;
      }
      final.push({
        object: "block",
        type: "code",
        code: {
          language: "plain text",
          rich_text: inlineRichText(buf.join("\n").slice(0, 1900) || " "),
        },
      });
    } else {
      final.push(blocks[i]);
    }
  }
  return final;
}

// ----------------------------------------------------------------------------
// categorisation
// ----------------------------------------------------------------------------
function deriveCategory(type, tags) {
  // Fast, balanced fallback. The refined path is the optional --categorize LLM
  // pass; this just gives a sane coarse split when that is not run. Tags like
  // "agents"/"koa"/"automation" are ambient (almost everything has them), so we
  // match on SPECIFIC signals first and only fall back to the broad eng bucket.
  const t = (tags || []).map((x) => x.toLowerCase());
  const any = (...keys) => keys.some((k) => t.some((tag) => tag.includes(k)));

  // 1. Business: revenue-facing work
  if (any("business", "sales", "proposal", "upwork", "lead", "marketing", "client", "revenue", "pricing", "outreach", "brand", "content-strategy"))
    return "Business";
  // 2. Strategy & Ops: how the operation runs / operator load / process
  if (any("strategy", "operator", "workflow", "process", "delegation", "scaling", "prioritization", "decision", "planning", "coordination", "ops"))
    return "Strategy & Ops";
  // 3. Personal & Reflection: reflections and self/identity unless clearly the above
  if (type === "reflection" || any("personal", "mindset", "philosophy", "identity", "emotion", "values", "self-awareness", "psychology"))
    return "Personal & Reflection";
  // 4. Product & Engineering: concrete build/system signals (narrow)
  if (any("openclaw", "chakra", "gbrain", "infra", "code", "model", "routing", "mcp", "deployment", "architecture", "api", "schema", "pipeline", "tooling"))
    return "Product & Engineering";
  // 5. everything else
  return "Knowledge";
}

async function llmCategory(title, body, tags) {
  const prompt =
    `Classify this note into EXACTLY ONE category from: ${CATEGORIES.join(", ")}.\n` +
    `Reply with only the category name, nothing else.\n\n` +
    `Title: ${title}\nTags: ${(tags || []).join(", ")}\n\n` +
    `${body.slice(0, 1500)}`;
  try {
    const res = await fetch(`${OMNIROUTE_BASE}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${OMNIROUTE_KEY}`,
        // KOA STOPGAP PATCH (AI request correlation)
        ...(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(
          String(process.env.AI_ROUTE_REQUEST_ID || "").trim(),
        ) ? { "X-Request-Id": String(process.env.AI_ROUTE_REQUEST_ID).trim() } : {}),
      },
      body: JSON.stringify({
        model: CATEGORIZE_MODEL,
        messages: [{ role: "user", content: prompt }],
        stream: false,
        max_tokens: 20,
      }),
    });
    const j = await res.json();
    const out = (j.choices?.[0]?.message?.content || "").trim();
    const hit = CATEGORIES.find((c) => out.toLowerCase().includes(c.toLowerCase().split(" ")[0]));
    return hit || null;
  } catch {
    return null;
  }
}

// ----------------------------------------------------------------------------
// notion api
// ----------------------------------------------------------------------------
let TOKEN = null;
async function notion(method, endpoint, body) {
  const res = await fetch(`${NOTION_BASE}${endpoint}`, {
    method,
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      "Notion-Version": NOTION_VERSION,
      "Content-Type": "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  await sleep(350); // stay under ~3 req/s
  const text = await res.text();
  let json;
  try {
    json = text ? JSON.parse(text) : {};
  } catch {
    json = { raw: text };
  }
  if (!res.ok) {
    const err = new Error(`Notion ${method} ${endpoint} -> ${res.status}: ${json.message || text}`);
    err.status = res.status;
    err.body = json;
    throw err;
  }
  return json;
}

async function findParentPage() {
  if (PARENT_OVERRIDE) return PARENT_OVERRIDE;
  const r = await notion("POST", "/search", {
    filter: { value: "page", property: "object" },
    page_size: 25,
  });
  const page = (r.results || []).find((x) => x.object === "page");
  if (!page)
    throw new Error(
      "No Notion page is shared with the integration. Share one page (… -> Connections -> gbrain-wiki) or pass --parent <page_id>."
    );
  return page.id;
}

function dbSchema() {
  return {
    Name: { title: {} },
    Type: {
      select: {
        options: [
          { name: "Idea", color: "yellow" },
          { name: "Reflection", color: "blue" },
          { name: "Concept", color: "green" },
          { name: "Project", color: "orange" },
          { name: "Company", color: "purple" },
          { name: "Person", color: "pink" },
          { name: "Note", color: "gray" },
        ],
      },
    },
    Category: {
      select: { options: CATEGORIES.map((c, i) => ({ name: c, color: ["blue","green","orange","pink","gray"][i % 5] })) },
    },
    Topics: { multi_select: {} },
    Date: { date: {} },
    Source: { rich_text: {} },
    Slug: { rich_text: {} },
    Updated: { date: {} },
  };
}

async function ensureDatabase(state) {
  if (state.databaseId) {
    // verify still reachable
    try {
      await notion("GET", `/databases/${state.databaseId}`);
      return state.databaseId;
    } catch (e) {
      if (e.status !== 404) throw e;
    }
  }
  const parent = state.parentPageId || (await findParentPage());
  state.parentPageId = parent;
  const db = await notion("POST", "/databases", {
    parent: { type: "page_id", page_id: parent },
    icon: { type: "emoji", emoji: "🧠" },
    title: [{ type: "text", text: { content: DB_TITLE } }],
    description: [
      {
        type: "text",
        text: {
          content:
            "Auto-maintained by gbrain. Each page is a distilled idea or reflection from Andrea's conversations. Filter by Category or Topics; group by Type.",
        },
      },
    ],
    properties: dbSchema(),
  });
  state.databaseId = db.id;
  return db.id;
}

function typeLabel(metaType) {
  const map = {
    original: "Idea",
    original_idea: "Idea",
    idea: "Idea",
    reflection: "Reflection",
    concept: "Concept",
    project: "Project",
    company: "Company",
    person: "Person",
  };
  return map[(metaType || "").toLowerCase()] || "Note";
}

function pageProperties(entry) {
  const props = {
    Name: { title: [{ type: "text", text: { content: entry.title.slice(0, 1990) } }] },
    Type: { select: { name: entry.typeLabel } },
    Category: { select: { name: entry.category } },
    Topics: { multi_select: entry.tags.slice(0, 25).map((t) => ({ name: t.slice(0, 95) })) },
    Slug: { rich_text: [{ type: "text", text: { content: entry.slug } }] },
    Source: { rich_text: [{ type: "text", text: { content: (entry.source || "").slice(0, 1990) } }] },
    Updated: { date: { start: new Date().toISOString() } },
  };
  if (entry.date) props.Date = { date: { start: entry.date } };
  return props;
}

const ICON = { Idea: "💡", Reflection: "🪞", Concept: "🧩", Project: "📦", Company: "🏢", Person: "👤", Note: "📝" };

async function appendChildren(pageId, blocks) {
  for (let i = 0; i < blocks.length; i += 100) {
    await notion("PATCH", `/blocks/${pageId}/children`, {
      children: blocks.slice(i, i + 100),
    });
  }
}

async function clearChildren(pageId) {
  let cursor;
  do {
    const q = cursor ? `?start_cursor=${cursor}&page_size=100` : "?page_size=100";
    const r = await notion("GET", `/blocks/${pageId}/children${q}`);
    for (const b of r.results || []) {
      await notion("PATCH", `/blocks/${b.id}`, { archived: true });
    }
    cursor = r.has_more ? r.next_cursor : null;
  } while (cursor);
}

// ----------------------------------------------------------------------------
// load wiki entries
// ----------------------------------------------------------------------------
function walkMd(dir) {
  const out = [];
  for (const name of fs.existsSync(dir) ? fs.readdirSync(dir) : []) {
    const p = path.join(dir, name);
    const st = fs.statSync(p);
    if (st.isDirectory()) out.push(...walkMd(p));
    else if (name.endsWith(".md")) out.push(p);
  }
  return out;
}

function loadEntries() {
  const files = walkMd(WIKI_DIR);
  const entries = [];
  for (const file of files) {
    const raw = fs.readFileSync(file, "utf8");
    const { meta, body } = parseFrontmatter(raw);
    const slug = path.basename(file, ".md");
    const title = meta.title || titleCase(slug.replace(/^\d{4}-\d{2}-\d{2}-/, "").replace(/-[0-9a-f]{6}$/, ""));
    const tags = Array.isArray(meta.tags) ? meta.tags : meta.tags ? [meta.tags] : [];
    const date = (meta.effective_date || meta.date || "").slice(0, 10) || null;
    entries.push({
      file,
      slug,
      title,
      typeLabel: typeLabel(meta.type),
      rawType: meta.type || "",
      tags,
      date,
      source: meta.source || "",
      body,
    });
  }
  entries.sort((a, b) => (b.date || "").localeCompare(a.date || ""));
  return entries;
}

// ----------------------------------------------------------------------------
// main
// ----------------------------------------------------------------------------
async function main() {
  const state = loadState();
  let entries = loadEntries();
  if (LIMIT) entries = entries.slice(0, LIMIT);

  console.log(`[notion-wiki] ${entries.length} wiki page(s) from ${WIKI_DIR}`);
  console.log(`[notion-wiki] mode=${DRY_RUN ? "DRY-RUN" : FULL ? "FULL" : "incremental"} categorize=${CATEGORIZE}`);

  // assign categories
  for (const e of entries) {
    e.category = deriveCategory(e.rawType, e.tags);
  }
  if (CATEGORIZE && !DRY_RUN) {
    let n = 0;
    for (const e of entries) {
      const c = await llmCategory(e.title, e.body, e.tags);
      if (c) e.category = c;
      if (++n % 25 === 0) console.log(`[notion-wiki] categorized ${n}/${entries.length}`);
    }
  }

  // build blocks + hash
  for (const e of entries) {
    e.blocks = markdownToBlocks(e.body);
    e.hash = sha(JSON.stringify([e.title, e.typeLabel, e.category, e.tags, e.body]));
  }

  // distribution report
  const byType = {}, byCat = {};
  for (const e of entries) {
    byType[e.typeLabel] = (byType[e.typeLabel] || 0) + 1;
    byCat[e.category] = (byCat[e.category] || 0) + 1;
  }
  console.log("[notion-wiki] by type:", JSON.stringify(byType));
  console.log("[notion-wiki] by category:", JSON.stringify(byCat));

  if (DRY_RUN) {
    const sample = entries[0];
    console.log("[notion-wiki] sample entry:", {
      slug: sample.slug,
      title: sample.title,
      type: sample.typeLabel,
      category: sample.category,
      topics: sample.tags,
      blocks: sample.blocks.length,
    });
    const totalBlocks = entries.reduce((s, e) => s + e.blocks.length, 0);
    console.log(`[notion-wiki] total blocks to publish: ${totalBlocks}`);
    // validate every block has a recognised type
    let bad = 0;
    for (const e of entries)
      for (const b of e.blocks)
        if (!b.type || !b[b.type]) bad++;
    console.log(`[notion-wiki] malformed blocks: ${bad}`);
    console.log("[notion-wiki] DRY-RUN ok, no network calls made.");
    return;
  }

  TOKEN = resolveToken();
  if (!TOKEN) {
    console.error(
      `[notion-wiki] NO TOKEN. Set $NOTION_API_KEY or add NOTION_API_KEY=... to ${SECRET_FILE}\n` +
        `Create one at notion.so -> Settings -> Connections -> integrations (Internal, workspace=King of Automation), then share a page with it.`
    );
    process.exit(2);
  }

  const dbId = await ensureDatabase(state);
  saveState(state);
  console.log(`[notion-wiki] database: ${dbId} (parent ${state.parentPageId})`);

  let created = 0, updated = 0, skipped = 0, failed = 0;
  for (const e of entries) {
    const prev = state.pages[e.slug];
    if (!FULL && prev && prev.hash === e.hash) {
      skipped++;
      continue;
    }
    try {
      if (prev && prev.pageId) {
        await notion("PATCH", `/pages/${prev.pageId}`, {
          properties: pageProperties(e),
          icon: { type: "emoji", emoji: ICON[e.typeLabel] || "📝" },
        });
        await clearChildren(prev.pageId);
        await appendChildren(prev.pageId, e.blocks);
        state.pages[e.slug] = { pageId: prev.pageId, hash: e.hash };
        updated++;
      } else {
        const page = await notion("POST", "/pages", {
          parent: { database_id: dbId },
          icon: { type: "emoji", emoji: ICON[e.typeLabel] || "📝" },
          properties: pageProperties(e),
          children: e.blocks.slice(0, 100),
        });
        if (e.blocks.length > 100) await appendChildren(page.id, e.blocks.slice(100));
        state.pages[e.slug] = { pageId: page.id, hash: e.hash };
        created++;
      }
      if ((created + updated) % 20 === 0) {
        saveState(state);
        console.log(`[notion-wiki] progress: +${created} ~${updated} (skip ${skipped})`);
      }
    } catch (err) {
      failed++;
      console.error(`[notion-wiki] FAIL ${e.slug}: ${err.message}`);
      if (err.status === 401) {
        console.error("[notion-wiki] token rejected, aborting.");
        break;
      }
    }
  }
  saveState(state);
  console.log(
    `[notion-wiki] done. created=${created} updated=${updated} skipped=${skipped} failed=${failed} db=${dbId}`
  );
}

main().catch((e) => {
  console.error("[notion-wiki] fatal:", e.message);
  process.exit(1);
});

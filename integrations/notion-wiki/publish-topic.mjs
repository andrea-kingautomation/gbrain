#!/usr/bin/env node
/**
 * publish-topic.mjs - Tier-2 go-live for the self-building knowledge base.
 *
 * Takes a rendered topic page (build-topic-page.mjs output) and makes it LIVE as a
 * PRIVATE Notion embed, exactly per HOSTING-AND-PROMOTION.md:
 *   1. host the self-contained HTML on our own VPS at an unguessable, noindex path
 *      (/srv/brain-assets/<rand>/<id>.html  ->  https://notebooklm.kingofautomation.com/brain/<rand>/<id>.html)
 *   2. create/update a row in the "Knowledge Base" Notion DB whose FIRST block is an
 *      embed of that URL (the HTML IS the page), with Realm + Visibility selects.
 *
 * Visibility defaults to "Private" (Tier-2 VPS embed). Flipping a row to "Published"
 * in Notion is the operator's gate to graduate it to a public Ghost post (Tier-1),
 * which runs from a fresh OpenClaw session (the Ghost MCPs are not loaded in CC).
 *
 * This NEVER publishes to Ghost and never sets Visibility=Published itself.
 *
 * USAGE
 *   node publish-topic.mjs <topic-id>        # publish one rendered topic (Private)
 *   node publish-topic.mjs --all             # publish every topic with a rendered file
 *   node publish-topic.mjs <id> --dry-run    # host the asset, print the URL, skip Notion
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";

const HOME = os.homedir();
const HERE = path.dirname(new URL(import.meta.url).pathname);
const REGISTRY = path.join(HERE, "topics.json");
const OUT_DIR = "/home/claude/outputs";
const ASSET_ROOT = "/srv/brain-assets";
const BASE_URL = "https://notebooklm.kingofautomation.com/brain";
const SECRET_FILE = path.join(HOME, ".gbrain/secrets/notion-wiki.env");
const STATE_FILE = path.join(HOME, ".gbrain/integrations/notion-wiki/topic-state.json");
const ASSETS_STATE = path.join(HOME, ".gbrain/integrations/notion-wiki/assets-state.json");
const NOTION_VERSION = "2022-06-28";
const NOTION_BASE = "https://api.notion.com/v1";

const argv = process.argv.slice(2);
const DRY = argv.includes("--dry-run");
const ALL = argv.includes("--all");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rt = (s) => [{ type: "text", text: { content: String(s).slice(0, 1990) } }];

function token() {
  if (process.env.NOTION_API_KEY) return process.env.NOTION_API_KEY.trim();
  const m = fs.readFileSync(SECRET_FILE, "utf8").match(/^\s*NOTION_API_KEY\s*=\s*(.+)\s*$/m);
  return m ? m[1].trim() : null;
}
let TOKEN;
async function notion(method, ep, body) {
  const res = await fetch(`${NOTION_BASE}${ep}`, {
    method,
    headers: { Authorization: `Bearer ${TOKEN}`, "Notion-Version": NOTION_VERSION, "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  await sleep(340);
  const j = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`Notion ${method} ${ep} ${res.status}: ${j.message || JSON.stringify(j).slice(0, 200)}`);
  return j;
}
const loadJson = (f, d) => { try { return JSON.parse(fs.readFileSync(f, "utf8")); } catch { return d; } };

// Host the rendered HTML on the VPS under a stable unguessable dir per topic.
function hostAsset(topic, state) {
  const src = path.join(OUT_DIR, `gbrain-topic-${topic.id}.html`);
  if (!fs.existsSync(src)) throw new Error(`no rendered page for '${topic.id}' (run build-topic-page.mjs ${topic.id} first)`);
  const rec = state.topics[topic.id] || {};
  const rand = rec.rand || crypto.randomBytes(16).toString("hex");
  const dir = path.join(ASSET_ROOT, rand);
  fs.mkdirSync(dir, { recursive: true });
  const dest = path.join(dir, `${topic.id}.html`);
  fs.copyFileSync(src, dest);
  fs.chmodSync(dest, 0o644);
  return { rand, url: `${BASE_URL}/${rand}/${topic.id}.html` };
}

const REALM_LABEL = { koa: "KoA", personal: "Personal" };

async function isLivePage(id) {
  if (!id) return false;
  try { const p = await notion("GET", `/pages/${id}`); return p.object === "page" && !p.archived && !p.in_trash; }
  catch { return false; }
}
async function ensureDb(state) {
  if (state.dbId && await isLivePage(state.dbId)) return state.dbId;
  state.dbId = null;
  // co-locate under the "🧠 G-Brain" parent page, but only if it is still live (build-asset's may be trashed).
  let parentPageId = (await isLivePage(state.parentPageId)) ? state.parentPageId
    : (await isLivePage(loadJson(ASSETS_STATE, {}).parentPageId) ? loadJson(ASSETS_STATE, {}).parentPageId : null);
  if (!parentPageId) {
    const search = await notion("POST", "/search", { filter: { value: "page", property: "object" }, page_size: 50 });
    const home = (search.results || []).find((p) => p.parent?.type === "workspace" && !p.archived && !p.in_trash)
      || (search.results || []).find((p) => !p.archived && !p.in_trash);
    if (!home) throw new Error("no accessible, live Notion page to host the Knowledge Base DB");
    const parent = await notion("POST", "/pages", {
      parent: { type: "page_id", page_id: home.id },
      icon: { type: "emoji", emoji: "🧠" },
      properties: { title: { title: rt("G-Brain Knowledge Base") } },
    });
    parentPageId = parent.id;
  }
  state.parentPageId = parentPageId;
  const db = await notion("POST", "/databases", {
    parent: { type: "page_id", page_id: parentPageId },
    icon: { type: "emoji", emoji: "📚" },
    title: rt("Knowledge Base"),
    description: rt("Self-building knowledge base. Each row is a topic the brain discovered in the live corpus, distilled into a grounded, designed page. The embed IS the page. Realm routes the public Ghost site on publish; flip Visibility to Published to graduate a page from the private VPS embed to a public Ghost post."),
    properties: {
      Name: { title: {} },
      Realm: { select: { options: [{ name: "KoA", color: "blue" }, { name: "Personal", color: "purple" }] } },
      Visibility: { select: { options: [{ name: "Private", color: "gray" }, { name: "Published", color: "green" }] } },
      "Cluster size": { number: {} },
      Updated: { date: {} },
      "Source URL": { url: {} },
    },
  });
  state.dbId = db.id;
  return state.dbId;
}

function pageBlocks(topic, url, provenance) {
  return [
    { object: "block", type: "embed", embed: { url } },
    { object: "block", type: "paragraph", paragraph: { rich_text: [
      { type: "text", text: { content: `${topic.title} - distilled by the brain from the live ${REALM_LABEL[topic.realm]} corpus. Private VPS embed (noindex). Flip Visibility to Published to graduate this to a Ghost post.` }, annotations: { italic: true, color: "gray" } },
    ] } },
    { object: "block", type: "paragraph", paragraph: { rich_text: [
      { type: "text", text: { content: `Grounded in ${topic.cluster_pages || "the"} source pages. Provenance: ${provenance || "see page footer"}`.slice(0, 1990) }, annotations: { color: "gray" } },
    ] } },
  ];
}

async function publishTopic(topic, state) {
  const { rand, url } = hostAsset(topic, state);
  console.log(`[host]   ${topic.id} -> ${url}`);
  if (DRY) { state.topics[topic.id] = { ...(state.topics[topic.id] || {}), rand }; return; }

  const dbId = await ensureDb(state);
  const provenance = ""; // grounding refs are rendered in the page footer; keep the row caption short
  const props = {
    Name: { title: rt(topic.title) },
    Realm: { select: { name: REALM_LABEL[topic.realm] || "KoA" } },
    Visibility: { select: { name: (state.topics[topic.id]?.visibility) || "Private" } },
    "Cluster size": { number: topic.cluster_pages || null },
    Updated: { date: { start: new Date().toISOString() } },
    "Source URL": { url },
  };
  const blocks = pageBlocks(topic, url, provenance);
  const existing = state.topics[topic.id]?.pageId;
  let pageId;
  if (existing) {
    await notion("PATCH", `/pages/${existing}`, { properties: props });
    const r = await notion("GET", `/blocks/${existing}/children?page_size=100`);
    for (const b of r.results || []) await notion("PATCH", `/blocks/${b.id}`, { archived: true });
    await notion("PATCH", `/blocks/${existing}/children`, { children: blocks });
    pageId = existing;
    console.log(`[notion] updated row ${pageId}`);
  } else {
    const page = await notion("POST", "/pages", { parent: { database_id: dbId }, icon: { type: "emoji", emoji: topic.realm === "personal" ? "📓" : "🧭" }, properties: props, children: blocks });
    pageId = page.id;
    console.log(`[notion] created row ${pageId}`);
  }
  state.topics[topic.id] = { rand, pageId, url, visibility: state.topics[topic.id]?.visibility || "Private", updated: new Date().toISOString() };
}

async function main() {
  const reg = loadJson(REGISTRY, null);
  if (!reg) throw new Error("topics.json not found");
  const ids = ALL
    ? reg.topics.filter((t) => fs.existsSync(path.join(OUT_DIR, `gbrain-topic-${t.id}.html`))).map((t) => t.id)
    : argv.filter((a) => !a.startsWith("--"));
  if (!ids.length) throw new Error("nothing to publish (pass a topic-id or --all; --all needs rendered files in /home/claude/outputs)");

  TOKEN = DRY ? null : token();
  if (!DRY && !TOKEN) throw new Error("no NOTION_API_KEY (env or ~/.gbrain/secrets/notion-wiki.env)");

  const state = loadJson(STATE_FILE, { topics: {} });
  state.topics = state.topics || {};
  for (const id of ids) {
    const topic = reg.topics.find((t) => t.id === id);
    if (!topic) { console.error(`[skip] unknown topic '${id}'`); continue; }
    await publishTopic(topic, state);
  }
  fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
  if (!DRY && state.dbId) console.log(`[done]   Knowledge Base DB: https://www.notion.so/${state.dbId.replace(/-/g, "")}`);
  console.log(`[done]   ${ids.length} topic(s) processed${DRY ? " (dry-run, no Notion writes)" : ""}.`);
}
main().catch((e) => { console.error("[FATAL]", e.message); process.exit(1); });

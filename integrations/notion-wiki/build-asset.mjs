#!/usr/bin/env node
/**
 * build-asset.mjs — publish ONE consolidated G-Brain asset to Notion + render HTML.
 *
 * This is the proof of the "brain organizer" direction: a cross-source asset
 * (e.g. Operating Principles distilled from 149 conversations), not 475 atomic
 * pages. Creates a dedicated "🧠 G-Brain" parent page + a "Knowledge Assets"
 * database under Home, publishes the asset as a richly-formatted Notion page,
 * and writes a polished self-contained HTML file.
 *
 * Usage:
 *   node build-asset.mjs asset-operating-principles.json
 *   node build-asset.mjs asset-operating-principles.json --html-only
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const NOTION_VERSION = "2022-06-28";
const NOTION_BASE = "https://api.notion.com/v1";
const HOME = os.homedir();
const SECRET_FILE = path.join(HOME, ".gbrain/secrets/notion-wiki.env");
const STATE_FILE = path.join(HOME, ".gbrain/integrations/notion-wiki/assets-state.json");
const OUT_DIR = "/home/claude/outputs";

const assetFile = process.argv[2];
const HTML_ONLY = process.argv.includes("--html-only");
if (!assetFile) {
  console.error("usage: node build-asset.mjs <asset.json> [--html-only]");
  process.exit(1);
}
const asset = JSON.parse(fs.readFileSync(assetFile, "utf8"));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function token() {
  if (process.env.NOTION_API_KEY) return process.env.NOTION_API_KEY.trim();
  const m = fs.readFileSync(SECRET_FILE, "utf8").match(/^\s*NOTION_API_KEY\s*=\s*(.+)\s*$/m);
  return m ? m[1].trim() : null;
}
let TOKEN;
async function notion(method, ep, body) {
  const res = await fetch(`${NOTION_BASE}${ep}`, {
    method,
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      "Notion-Version": NOTION_VERSION,
      "Content-Type": "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  await sleep(340);
  const j = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`Notion ${method} ${ep} ${res.status}: ${j.message || JSON.stringify(j).slice(0, 200)}`);
  return j;
}
const rt = (s) => [{ type: "text", text: { content: String(s).slice(0, 1990) } }];
const rtb = (s) => [{ type: "text", text: { content: String(s).slice(0, 1990) }, annotations: { bold: true } }];

// ---------- Notion blocks ----------
function assetBlocks(a) {
  const blocks = [];
  blocks.push({
    object: "block", type: "callout",
    callout: { icon: { type: "emoji", emoji: "🧠" }, color: "blue_background", rich_text: rt(a.intro) },
  });
  blocks.push({ object: "block", type: "divider", divider: {} });
  a.principles.forEach((p, i) => {
    blocks.push({ object: "block", type: "heading_2", heading_2: { rich_text: rt(`${i + 1}. ${p.name}`) } });
    blocks.push({ object: "block", type: "paragraph", paragraph: { rich_text: rtb(p.statement) } });
    blocks.push({ object: "block", type: "paragraph", paragraph: { rich_text: rt(p.meaning) } });
    blocks.push({
      object: "block", type: "toggle",
      toggle: {
        rich_text: [{ type: "text", text: { content: "Evidence from your conversations" }, annotations: { italic: true, color: "gray" } }],
        children: p.evidence.map((e) => ({
          object: "block", type: "bulleted_list_item",
          bulleted_list_item: { rich_text: [{ type: "text", text: { content: e }, annotations: { italic: true } }] },
        })),
      },
    });
  });
  blocks.push({ object: "block", type: "divider", divider: {} });
  if (a.craftNote)
    blocks.push({
      object: "block", type: "callout",
      callout: { icon: { type: "emoji", emoji: "✍️" }, color: "gray_background", rich_text: rt(a.craftNote) },
    });
  blocks.push({
    object: "block", type: "callout",
    callout: {
      icon: { type: "emoji", emoji: "🔎" }, color: "yellow_background",
      rich_text: rt(`How G-Brain made this: consolidated from ${a.sources} conversations across themes [${a.themes.join(", ")}]. No single chat stated these; they are recurring patterns surfaced and organised by the brain. This is a living asset and updates as new conversations refine the patterns.`),
    },
  });
  return blocks;
}

// ---------- HTML (magazine-grade, self-contained, zero deps) ----------
function esc(s) { return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;"); }
function slugify(s) { return String(s).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, ""); }
function html(a) {
  const nav = a.principles.map((p, i) => `
        <a class="toc-item" href="#p${i + 1}"><span class="toc-num">${String(i + 1).padStart(2, "0")}</span><span class="toc-text">${esc(p.name)}</span></a>`).join("");
  const cards = a.principles.map((p, i) => `
      <article class="card" id="p${i + 1}">
        <div class="ghost">${String(i + 1).padStart(2, "0")}</div>
        <div class="card-in">
          <div class="rule"></div>
          <h2>${esc(p.name)}</h2>
          <blockquote class="statement">${esc(p.statement)}</blockquote>
          <p class="meaning">${esc(p.meaning)}</p>
          <details class="evidence">
            <summary>Where this shows up <span class="ecount">${p.evidence.length} signals</span></summary>
            <div class="chips">${p.evidence.map((e) => `<span class="chip">${esc(e)}</span>`).join("")}</div>
          </details>
        </div>
      </article>`).join("");
  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(a.title)} · G-Brain</title>
<style>
  :root{
    --bg:#0b0d12;--bg2:#10131b;--card:#141823;--ink:#eef2f8;--ink2:#cdd6e3;--muted:#8b95a7;
    --accent:#8fb0ff;--accent2:#c9a6ff;--gold:#e8c07a;--line:#222838;--line2:#2c3344;--chip:#1a1f2c;
  }
  *{box-sizing:border-box}
  html{scroll-behavior:smooth}
  body{margin:0;color:var(--ink);
    background:
      radial-gradient(1100px 520px at 78% -8%,rgba(143,176,255,.16),transparent 60%),
      radial-gradient(900px 460px at 8% 4%,rgba(201,166,255,.12),transparent 55%),
      linear-gradient(180deg,#0a0c11,#0b0d12 60%);
    font:16px/1.68 -apple-system,BlinkMacSystemFont,"Segoe UI",Inter,Roboto,Helvetica,Arial,sans-serif;
    -webkit-font-smoothing:antialiased}
  .page{max-width:1180px;margin:0 auto;padding:0 28px}

  /* ---- hero ---- */
  .hero{padding:84px 0 30px;border-bottom:1px solid var(--line)}
  .eyebrow{display:inline-flex;align-items:center;gap:9px;color:var(--accent);font-weight:600;
    letter-spacing:.16em;text-transform:uppercase;font-size:11.5px}
  .eyebrow .dot{width:6px;height:6px;border-radius:50%;background:var(--accent);box-shadow:0 0 12px var(--accent)}
  h1{font-family:Georgia,"Times New Roman",serif;font-weight:600;font-size:clamp(38px,6vw,68px);
    line-height:1.04;letter-spacing:-.02em;margin:16px 0 0;
    background:linear-gradient(180deg,#fff,#c6d2e6);-webkit-background-clip:text;background-clip:text;color:transparent}
  .lede{max-width:760px;color:var(--ink2);font-size:clamp(16px,2.1vw,19px);margin:22px 0 26px}
  .meta{display:flex;gap:10px;flex-wrap:wrap;align-items:center}
  .pill{background:var(--chip);border:1px solid var(--line2);border-radius:999px;padding:5px 13px;
    font-size:12.5px;color:var(--muted)}
  .pill.lead{color:var(--ink);border-color:#3a425a;background:#1d2433}
  .pill b{color:var(--ink)}

  /* ---- layout: contents rail + body ---- */
  .layout{display:grid;grid-template-columns:248px 1fr;gap:54px;padding:46px 0 60px}
  .toc{position:sticky;top:28px;align-self:start;max-height:calc(100vh - 56px);overflow:auto}
  .toc-h{color:var(--muted);font-size:11px;letter-spacing:.16em;text-transform:uppercase;margin:0 0 14px 14px}
  .toc-item{display:flex;gap:12px;align-items:baseline;text-decoration:none;color:var(--ink2);
    padding:8px 14px;border-left:2px solid transparent;border-radius:0 8px 8px 0;transition:.18s}
  .toc-item:hover{color:#fff;background:rgba(143,176,255,.07);border-left-color:var(--accent)}
  .toc-num{color:var(--accent);font-variant-numeric:tabular-nums;font-size:12px;font-weight:700;min-width:18px}
  .toc-text{font-size:13.5px;line-height:1.4}

  /* ---- cards ---- */
  .stream{min-width:0}
  .card{position:relative;background:linear-gradient(180deg,var(--card),#11141d);
    border:1px solid var(--line);border-radius:20px;padding:30px 34px 26px;margin:0 0 22px;
    box-shadow:0 1px 0 rgba(255,255,255,.03),0 30px 60px -40px #000;overflow:hidden;scroll-margin-top:24px}
  .card:hover{border-color:var(--line2)}
  .ghost{position:absolute;top:-18px;right:14px;font-family:Georgia,serif;font-weight:700;
    font-size:128px;line-height:1;color:#fff;opacity:.035;pointer-events:none;letter-spacing:-.04em}
  .card-in{position:relative}
  .rule{width:46px;height:3px;border-radius:3px;margin-bottom:16px;
    background:linear-gradient(90deg,var(--accent),var(--accent2))}
  h2{font-family:Georgia,serif;font-weight:600;font-size:25px;letter-spacing:-.01em;margin:0 0 14px;color:#fff}
  .statement{margin:0 0 14px;padding:0 0 0 16px;border-left:3px solid var(--gold);
    font-size:18px;line-height:1.5;color:#fff;font-weight:500;font-style:normal}
  .meaning{color:var(--ink2);margin:0 0 16px;font-size:15.5px}
  details.evidence{border-top:1px solid var(--line);padding-top:14px}
  details.evidence summary{cursor:pointer;list-style:none;color:var(--muted);font-size:12px;
    letter-spacing:.08em;text-transform:uppercase;display:flex;align-items:center;gap:10px}
  details.evidence summary::-webkit-details-marker{display:none}
  details.evidence summary::before{content:"▸";color:var(--accent);transition:.2s;font-size:11px}
  details.evidence[open] summary::before{transform:rotate(90deg)}
  .ecount{color:#69728a;text-transform:none;letter-spacing:0}
  .chips{display:flex;flex-wrap:wrap;gap:8px;margin-top:14px}
  .chip{background:var(--chip);border:1px solid var(--line2);border-radius:8px;padding:6px 11px;
    font-size:12.5px;color:#aab4c4;line-height:1.35}

  /* ---- closing panels ---- */
  .panel{border-radius:18px;padding:24px 28px;margin:0 0 18px;border:1px solid var(--line2)}
  .panel.voice{background:linear-gradient(180deg,#16131f,#120f1a);border-color:#2e2740}
  .panel.prov{background:linear-gradient(180deg,#121a16,#0f1612);border-color:#243528}
  .panel h3{margin:0 0 8px;font-size:13px;letter-spacing:.1em;text-transform:uppercase;color:var(--muted)}
  .panel.voice h3{color:var(--accent2)} .panel.prov h3{color:#8fd6a6}
  .panel p{margin:0;color:var(--ink2);font-size:15px}
  footer{color:#69728a;font-size:12.5px;padding:22px 0 60px;border-top:1px solid var(--line);margin-top:8px}
  a{color:var(--accent)}

  @media (max-width:880px){
    .layout{grid-template-columns:1fr;gap:0}
    .toc{display:none}
    .card{padding:26px 22px 22px}
    .ghost{font-size:96px}
  }
  @media print{
    body{background:#fff;color:#111} .toc,.ghost{display:none}
    .card,.panel{border-color:#ddd;box-shadow:none;background:#fff}
    h1,h2,.statement{color:#111;-webkit-text-fill-color:#111}
  }
</style></head>
<body>
  <div class="page">
    <header class="hero">
      <span class="eyebrow"><span class="dot"></span>G-Brain · Knowledge Asset</span>
      <h1>${esc(a.title)}</h1>
      <p class="lede">${esc(a.intro)}</p>
      <div class="meta">
        <span class="pill lead"><b>${esc(a.assetType)}</b></span>
        <span class="pill">Compiled from <b>${a.sources}</b> conversations</span>
        <span class="pill"><b>${a.principles.length}</b> principles</span>
        ${a.themes.map((t) => `<span class="pill">#${esc(t)}</span>`).join("")}
      </div>
    </header>

    <div class="layout">
      <nav class="toc" aria-label="Contents">
        <p class="toc-h">The ten</p>
        ${nav}
      </nav>
      <main class="stream">
        ${cards}
        ${a.craftNote ? `<section class="panel voice"><h3>A note on voice</h3><p>${esc(a.craftNote)}</p></section>` : ""}
        <section class="panel prov">
          <h3>How G-Brain made this</h3>
          <p>Consolidated from ${a.sources} conversations across ${a.themes.length} themes. No single chat stated these principles. They are the recurring patterns the brain surfaced and organised into one place. This is a living asset and sharpens as new conversations arrive.</p>
        </section>
        <footer>G-Brain Knowledge Assets · generated ${esc(a.title)} · a brain organizer, not a transcript dump.</footer>
      </main>
    </div>
  </div>
</body></html>`;
}

// ---------- main ----------
async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const slug = asset.title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  const htmlPath = path.join(OUT_DIR, `gbrain-${slug}.html`);
  fs.writeFileSync(htmlPath, html(asset));
  console.log(`[asset] HTML written: ${htmlPath} (${fs.statSync(htmlPath).size} bytes)`);
  if (HTML_ONLY) return;

  TOKEN = token();
  if (!TOKEN) throw new Error("no NOTION_API_KEY");

  let state = {};
  try { state = JSON.parse(fs.readFileSync(STATE_FILE, "utf8")); } catch {}

  // 1. parent page "🧠 G-Brain"
  if (!state.parentPageId) {
    const search = await notion("POST", "/search", { filter: { value: "page", property: "object" }, page_size: 50 });
    const home = (search.results || []).find((p) => p.parent?.type === "workspace") || (search.results || [])[0];
    if (!home) throw new Error("no accessible page to host G-Brain");
    const parent = await notion("POST", "/pages", {
      parent: { type: "page_id", page_id: home.id },
      icon: { type: "emoji", emoji: "🧠" },
      properties: { title: { title: rt("G-Brain") } },
    });
    state.parentPageId = parent.id;
    console.log(`[asset] created parent page G-Brain: ${parent.id} (under "${home.id}")`);
  }

  // 2. assets database
  if (!state.databaseId) {
    const db = await notion("POST", "/databases", {
      parent: { type: "page_id", page_id: state.parentPageId },
      icon: { type: "emoji", emoji: "📚" },
      title: rt("Knowledge Assets"),
      description: rt("Consolidated, cross-source assets compiled by G-Brain: principles, guides, reports, maps. Each page aggregates scattered knowledge across many conversations into one useful, readable document."),
      properties: {
        Name: { title: {} },
        "Asset Type": { select: { options: [
          { name: "Principles", color: "purple" }, { name: "Guide", color: "blue" },
          { name: "Report", color: "green" }, { name: "Top-N", color: "orange" },
          { name: "Map", color: "yellow" }, { name: "Profile", color: "pink" },
        ] } },
        Themes: { multi_select: {} },
        Sources: { number: {} },
        Status: { select: { options: [{ name: "Published", color: "green" }, { name: "Draft", color: "gray" }] } },
        Updated: { date: {} },
        Summary: { rich_text: {} },
      },
    });
    state.databaseId = db.id;
    console.log(`[asset] created database Knowledge Assets: ${db.id}`);
  }

  // 3. asset page
  const blocks = assetBlocks(asset);
  const props = {
    Name: { title: rt(asset.title) },
    "Asset Type": { select: { name: asset.assetType } },
    Themes: { multi_select: asset.themes.slice(0, 20).map((t) => ({ name: t.slice(0, 90) })) },
    Sources: { number: asset.sources },
    Status: { select: { name: "Published" } },
    Updated: { date: { start: new Date().toISOString() } },
    Summary: { rich_text: rt(asset.summary) },
  };
  state.pages = state.pages || {};
  const existing = state.pages[slug];
  let pageId;
  if (existing) {
    await notion("PATCH", `/pages/${existing}`, { properties: props, icon: { type: "emoji", emoji: "⚖️" } });
    // clear + re-append children
    let cursor;
    do {
      const q = cursor ? `?start_cursor=${cursor}&page_size=100` : "?page_size=100";
      const r = await notion("GET", `/blocks/${existing}/children${q}`);
      for (const b of r.results || []) await notion("PATCH", `/blocks/${b.id}`, { archived: true });
      cursor = r.has_more ? r.next_cursor : null;
    } while (cursor);
    for (let i = 0; i < blocks.length; i += 100)
      await notion("PATCH", `/blocks/${existing}/children`, { children: blocks.slice(i, i + 100) });
    pageId = existing;
    console.log(`[asset] updated page ${pageId}`);
  } else {
    const page = await notion("POST", "/pages", {
      parent: { database_id: state.databaseId },
      icon: { type: "emoji", emoji: "⚖️" },
      properties: props,
      children: blocks.slice(0, 100),
    });
    if (blocks.length > 100)
      for (let i = 100; i < blocks.length; i += 100)
        await notion("PATCH", `/blocks/${page.id}/children`, { children: blocks.slice(i, i + 100) });
    pageId = page.id;
    state.pages[slug] = pageId;
    console.log(`[asset] created page ${pageId}`);
  }

  fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
  const url = `https://www.notion.so/${pageId.replace(/-/g, "")}`;
  console.log(`[asset] DONE. Notion page: ${url}`);
  console.log(`[asset] DB url: https://www.notion.so/${state.databaseId.replace(/-/g, "")}`);
}
main().catch((e) => { console.error("[asset] FATAL:", e.message); process.exit(1); });

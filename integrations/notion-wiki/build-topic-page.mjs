#!/usr/bin/env node
/**
 * build-topic-page.mjs - the distillation generator for the self-building knowledge base.
 *
 * Turns ONE auto-discovered topic (a tag cluster in topics.json) into a grounded,
 * contextually-designed page. This is the generator BD scoped as "the next build":
 * discover -> ground -> distill -> design -> render, with a hard gate before anything
 * goes outward to Notion or Ghost.
 *
 * PIPELINE
 *   1. resolve  - look up the topic in topics.json, resolve realm -> wall-safe source scope
 *   2. ground   - query gbrain (psql) for the cluster's synthesis pages: title,
 *                 compiled_truth, effective_date, and the provenance turn-refs each carries.
 *                 Realm-scoped by source, and subject-disambiguated via subject_exclude_tags
 *                 so a personal page never duplicates a KoA page (coherence + realm-split gate).
 *   3. brief    - assemble a grounding brief (JSON) - DETERMINISTIC, this is the proven layer.
 *   4. design   - the html-anything template + hallmark disciplines for the topic's treatment.
 *   5. render   - hand the brief + design spec to the reasoning model (OmniRoute gbrain combo)
 *                 to emit ONE self-contained, noindex, Notion-embed-safe HTML file.
 *
 * USAGE
 *   node build-topic-page.mjs <topic-id> --brief-only     # ground + brief only (no LLM, no spend)
 *   node build-topic-page.mjs <topic-id>                  # full: brief + render via OmniRoute
 *   node build-topic-page.mjs --list                      # list discovered topics
 *
 * GATE: this script renders to a LOCAL file only. It never calls Notion or Ghost.
 * Publishing is a separate, operator-approved step (see HOSTING-AND-PROMOTION.md).
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { execFileSync } from "node:child_process";

// POST to OmniRoute using node:http, NOT fetch. Node's fetch (undici) imposes a ~300s
// default body/headers timeout; the gbrain combos BUFFER (no bytes until the full gen
// finishes), so a long page generation trips that timeout as "fetch failed" and wedges
// the whole refresh. node:http has no default body timeout (like curl), so the only
// bound is the explicit deadline we pass. Returns { status, text }.
function omniPost(urlStr, headers, body, timeoutMs) {
  return new Promise((resolve, reject) => {
    const u = new URL(urlStr);
    const req = http.request(
      {
        hostname: u.hostname,
        port: u.port || 80,
        path: u.pathname + u.search,
        method: "POST",
        headers: { ...headers, "Content-Length": Buffer.byteLength(body) },
      },
      (res) => {
        let data = "";
        res.setEncoding("utf8");
        res.on("data", (c) => { data += c; });
        res.on("end", () => resolve({ status: res.statusCode, text: data }));
      },
    );
    const killer = setTimeout(() => req.destroy(new Error(`omniroute deadline ${timeoutMs}ms`)), timeoutMs);
    req.on("error", (e) => { clearTimeout(killer); reject(e); });
    req.on("close", () => clearTimeout(killer));
    req.write(body);
    req.end();
  });
}

const HERE = path.dirname(new URL(import.meta.url).pathname);
const HOME = os.homedir();
const REGISTRY = path.join(HERE, "topics.json");
const OUT_DIR = "/home/claude/outputs";
const BRIEF_DIR = path.join(HOME, ".gbrain/integrations/notion-wiki/briefs");

// OmniRoute internal endpoint (HTTP). The reasoning combo gbrain actually runs on.
const OMNI_URL = process.env.OMNIROUTE_URL || "http://127.0.0.1:20128/v1/chat/completions";
// The gbrain reasoning COMBO (priority chain: antigravity-sonnet -> agy-sonnet ->
// nemotron -> ce-sonnet -> flash). We deliberately call the combo, not a single model,
// so the fallback chain protects us. The combo works fine; the wiki outage from
// 2026-06-10 was NOT the combo failing — it was this builder using fetch() (Node/undici
// has a ~300s default body timeout) against a combo that BUFFERS (it must hold the whole
// response to decide priority-fallback, so zero bytes arrive until the gen completes,
// which for a full page exceeds 300s). curl has no such default, which is why curl
// worked and fetch did not. Fixed below by using node:http (no default body timeout).
const OMNI_MODEL = process.env.OMNIROUTE_COMBO || "koa-gbrain-reasoning";

function dbUrl() {
  const cfg = JSON.parse(fs.readFileSync(path.join(HOME, ".gbrain/config.json"), "utf8"));
  return cfg.database_url;
}
// Parameterless, injection-safe psql: pass the SQL on stdin, values via -v are quoted by us.
function q(sql) {
  const out = execFileSync("psql", [dbUrl(), "-At", "-F", "\x1f", "-c", sql], {
    encoding: "utf8", maxBuffer: 64 * 1024 * 1024,
  });
  return out.split("\n").filter(Boolean).map((r) => r.split("\x1f"));
}
const lit = (s) => "'" + String(s).replace(/'/g, "''") + "'";
const inList = (arr) => arr.map(lit).join(",");
// Pull the provenance refs a synthesis page carries in its body: telegram turn-refs
// (m<chat>_<topic>_t<turn>) and wiki reflection/pattern slugs it was distilled from.
const TURN_RE = /(m\d{10,}_\d+_t?\d+|wiki\/[a-z]+\/[a-z]+\/[0-9a-z-]+)/g;

function loadRegistry() { return JSON.parse(fs.readFileSync(REGISTRY, "utf8")); }

function ground(topic, reg) {
  // source_override: where the grounded data PHYSICALLY lives today, when it differs from
  // the realm's wall-safe scope. Used for KoA-subject clusters that currently reside in
  // personal-synthesis (verified 2026-06-10). Tripping this also flags the wall-review gate.
  const sources = topic.source_override && topic.source_override.length
    ? topic.source_override
    : reg.realms[topic.realm].sources;
  const tagFilter = inList(topic.tags);
  const srcFilter = inList(sources);
  let sql = `
    select p.id, p.title, coalesce(p.effective_date::text,''),
           regexp_replace(coalesce(p.compiled_truth,''),'\\s+',' ','g')
    from pages p
    where p.deleted_at is null and p.source_id in (${srcFilter})
      and p.id in (select t.page_id from tags t where t.tag in (${tagFilter}))`;
  if (topic.subject_exclude_tags && topic.subject_exclude_tags.length) {
    sql += ` and p.id not in (select t2.page_id from tags t2 where t2.tag in (${inList(topic.subject_exclude_tags)}))`;
  }
  sql += ` order by p.emotional_weight desc nulls last, p.effective_date desc limit 40;`;
  const rows = q(sql);
  return rows.map(([id, title, date, body]) => {
    const refs = [...new Set((body.match(TURN_RE) || []))].slice(0, 6);
    return { id: Number(id), title, date, body, provenance: refs };
  });
}

function buildBrief(topic, reg, pages) {
  return {
    topic_id: topic.id,
    title: topic.title,
    realm: topic.realm,
    ghost_site: reg.realms[topic.realm].ghost_site,
    treatment: topic.treatment,
    template: topic.template,
    cluster_size: pages.length,
    generated_for: "self-building knowledge base - grounded topic page",
    gates: {
      honest_copy: "Every claim must trace to a page below. No invented metrics, quotes, or facts.",
      structural_variety: "Design must fit THIS topic's shape; must not reuse another topic's rhythm.",
      provenance: "Surface the source pages / turn-refs so the reader can verify grounding.",
      wall: (topic.source_override || []).some((s) => s.startsWith("personal")) && topic.realm === "koa"
        ? "KoA content currently sourced from the ACL-walled personal-synthesis (by subject); operator review required before this page goes outward."
        : "ok",
    },
    pages,
  };
}

// Writing standard injected verbatim into the render prompt. Distilled from
// /home/claude/skills/content-generation-standards/SKILL.md + personal-voice +
// the hallmark skill's honest-copy discipline. This is the anti-jargon contract:
// a page must read as if a sharp human wrote it for a sharp reader, not as a
// buzzword-stacked machine summary.
const WRITING_STANDARD = `WRITING STANDARD (non-negotiable — the page must read as coherent human prose, NOT jargon):
- Lead with something concrete: a real decision, a real failure, a real tradeoff from the sources. Never open with "In today's world", "Let's dive in", "In the age of AI", or a definition.
- Concrete before abstract. Prefer the specific artifact, number, or quote over a generic claim. If you do not have a real number, do NOT invent one and do NOT gesture at one.
- Define every technical term in plain language the first time it appears. Assume the reader is intelligent but does not know this specific system. One clear clause is enough; do not over-explain.
- Ban these words and their kin: seamless, game-changer, revolutionary, disruptive, empower, supercharge, unleash, elevate, robust, holistic, cutting-edge, unlock, leverage, transform, synergy, next-level, paradigm. Say the plain thing instead.
- No buzzword stacking. One idea per sentence. If a sentence carries three abstract nouns in a row, rewrite it.
- Vary sentence length and openers. Mix short punchy lines with longer reflective ones. Do not start consecutive sentences or sections with the same word or syntactic frame (e.g. not "On X: ... On Y: ...").
- Active voice. Short paragraphs (1-3 sentences). Plenty of whitespace.
- No validation padding ("great", "powerful", "important to note"), no hedging stacks ("might possibly perhaps"). State the thing.
- Never describe the work or system as simple, easy, or straightforward.
- NO EM-DASHES anywhere (no — character). Use a comma, a period, or a connecting word (and, so, which, because). No decorative hyphenated compounds where a space reads better.
- Honest copy: every claim traces to a source page below. Preserve verbatim quotes exactly and attribute them to their provenance ref so a reader can verify. Invent nothing.
- Before you emit, read the draft once as the reader would and cut any sentence that sounds like an AI template.`;

const DESIGN_BRIEF = (brief, templateSpec) => `You are the distillation + design pass of a self-building knowledge base. You turn a grounded research brief into ONE finished, visually designed, publishable web page.

${WRITING_STANDARD}

DESIGN (this is a designed page, not a text document — make it look intentionally art-directed):
Render ONE self-contained HTML page (all CSS inline, no external deps, no CDN; it must render inside a Notion embed iframe AND as an offline file). Add <meta name="robots" content="noindex,nofollow">.
- TOPIC: ${brief.title} (publishing realm: ${brief.realm}) | TREATMENT: ${brief.treatment}
- Follow the html-anything template spec below as your design system (palette, type, layout motifs). Implement its aesthetic faithfully in inline CSS. Translate any non-English design notes into concrete CSS.
${templateSpec ? `--- TEMPLATE SPEC: ${brief.template} ---\n${templateSpec}\n--- END TEMPLATE SPEC ---` : `(template "${brief.template}" spec unavailable; design a polished page in that style from first principles)`}
- VISUAL RICHNESS: do not settle for stacked text columns. Use the full design vocabulary the content supports: a real type scale and hierarchy, a committed colour palette as named CSS variables, generous whitespace, section dividers, pull-quotes, numbered markers, cards with depth, tables for tabular data, and inline SVG diagrams where a relationship or pipeline is described (e.g. a layered routing stack, a flow, a comparison). Hand-draw the SVG; never invent data the sources do not contain.
- Apply the hallmark disciplines: structural variety (this page must NOT fall into a generic hero -> 3-card -> CTA rhythm; let the content's actual shape drive the layout), locked design tokens (every colour/font as a named CSS variable, no raw hex mid-render), a pre-emit critique comment stamp at the top, and mobile-responsiveness at 320/375/414/768px (no horizontal scroll, diagrams reflow or scale).
- The design must fit THIS topic. A system blueprint reads differently from personal reflections; do not reuse one rhythm for the other.
- Surface the provenance (source titles / turn-refs) in a styled footer or aside so the grounding is visible and verifiable.

SOURCE PAGES (the ONLY material you may draw from — grounded corpus for this topic):
${brief.pages.map((p, i) => `[${i + 1}] ${p.title} (${p.date})\n${p.body.slice(0, 1400)}\nprovenance: ${p.provenance.join(", ") || "n/a"}`).join("\n\n")}

Output ONLY the HTML document, nothing else.`;

// Fetch the html-anything template's design spec (palette/type/layout) so the model
// designs to the real template, not an improvised plain layout. Cached in /tmp.
async function fetchTemplateSpec(template) {
  if (!template) return null;
  const cache = path.join(os.tmpdir(), `ha-tmpl-${template}.md`);
  try { return fs.readFileSync(cache, "utf8"); } catch { /* miss */ }
  const url = `https://raw.githubusercontent.com/nexu-io/html-anything/main/next/src/lib/templates/skills/${template}/SKILL.md`;
  try {
    const r = await fetch(url);
    if (!r.ok) return null;
    const spec = (await r.text()).slice(0, 4000);
    try { fs.writeFileSync(cache, spec); } catch { /* best-effort */ }
    return spec;
  } catch { return null; }
}

async function render(brief) {
  const key = (() => {
    try {
      const env = fs.readFileSync(path.join(HOME, ".omniroute/.env"), "utf8");
      const m = env.match(/OMNIROUTE_API_KEY\s*=\s*(.+)/);
      return m ? m[1].trim() : process.env.OMNIROUTE_API_KEY;
    } catch { return process.env.OMNIROUTE_API_KEY; }
  })();
  const body = JSON.stringify({
    model: OMNI_MODEL,
    messages: [{ role: "user", content: DESIGN_BRIEF(brief, await fetchTemplateSpec(brief.template)) }],
    temperature: 0.5,
    // stream:true so the SSE accumulator below works. (Combos buffer regardless, but
    // streaming is the correct mode and the parser handles both shapes.)
    stream: true,
    max_tokens: 16000,
  });
  // The combo can be slow (a full page buffered through the priority chain can take
  // several minutes). Generous per-attempt deadline so a legitimately-slow generation
  // is NOT killed mid-flight, plus retry/backoff so a transient gateway blip fails over
  // instead of wedging the 6-hourly cron for days (the 2026-06-10 outage). node:http
  // (omniPost) avoids Node fetch's ~300s default body timeout. Tunable via env.
  const attempts = parseInt(process.env.OMNI_ATTEMPTS || "3", 10);
  const timeoutMs = parseInt(process.env.OMNI_TIMEOUT_MS || "900000", 10);
  let raw = "", status = 0, lastErr;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const r = await omniPost(
        OMNI_URL,
        {
          "Content-Type": "application/json",
          Authorization: `Bearer ${key}`,
          // KOA STOPGAP PATCH (AI request correlation)
          ...(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(
            String(process.env.AI_ROUTE_REQUEST_ID || "").trim(),
          ) ? { "X-Request-Id": String(process.env.AI_ROUTE_REQUEST_ID).trim() } : {}),
        },
        body,
        timeoutMs,
      );
      status = r.status; raw = r.text;
      if (status >= 500) throw new Error(`OmniRoute ${status}: ${raw.slice(0, 200)}`);
      lastErr = null;
      break;
    } catch (e) {
      lastErr = e;
      console.error(`[render] attempt ${attempt}/${attempts} failed: ${e.message || e}`);
      if (attempt < attempts) await new Promise((r) => setTimeout(r, attempt * 4000));
    }
  }
  if (lastErr) throw new Error(`OmniRoute unreachable after ${attempts} attempts: ${lastErr.message || lastErr}`);
  if (status < 200 || status >= 300) throw new Error(`OmniRoute ${status}: ${raw.slice(0, 240)}`);
  // The reasoning combo may answer as a single JSON object OR as an SSE stream
  // ("data: {...}\n\n" chunks). Handle both: collect choices[].delta.content.
  let html = "";
  if (raw.trimStart().startsWith("data:")) {
    for (const line of raw.split("\n")) {
      const s = line.trim();
      if (!s.startsWith("data:")) continue;
      const payload = s.slice(5).trim();
      if (payload === "[DONE]") break;
      try {
        const d = JSON.parse(payload);
        html += d.choices?.[0]?.delta?.content || d.choices?.[0]?.message?.content || "";
      } catch { /* skip keep-alive / partial lines */ }
    }
  } else {
    const j = JSON.parse(raw);
    html = j.choices?.[0]?.message?.content || "";
  }
  // Strip any markdown code fence the model wrapped the document in.
  html = html.replace(/^[\s\S]*?```html\s*/i, "").replace(/```[\s\S]*$/i, "");
  // Slice to the actual document (case-insensitive; tolerate a missing close).
  const a = html.search(/<!DOCTYPE/i);
  const bIdx = html.toLowerCase().lastIndexOf("</html>");
  if (a >= 0) html = bIdx > a ? html.slice(a, bIdx + 7) : html.slice(a);
  // Deterministic dash hygiene (em-dash ban is absolute, incl. HTML entities).
  html = html
    .replace(/\s*(?:—|&mdash;|&#8212;|&#x2014;)\s*/g, ", ")
    .replace(/(?:–|&ndash;|&#8211;|&#x2013;)/g, "-");
  return html;
}

async function main() {
  const args = process.argv.slice(2);
  const reg = loadRegistry();
  if (args.includes("--list") || args.length === 0) {
    console.log("Discovered topics:");
    for (const t of reg.topics) console.log(`  ${t.id.padEnd(26)} ${t.realm.padEnd(9)} ${t.status.padEnd(16)} ${t.title}`);
    return;
  }
  const topicId = args[0];
  const briefOnly = args.includes("--brief-only");
  const topic = reg.topics.find((t) => t.id === topicId);
  if (!topic) throw new Error(`unknown topic '${topicId}' (try --list)`);

  console.log(`[ground] querying realm=${topic.realm} sources, tags=[${topic.tags.join(",")}]`);
  const pages = ground(topic, reg);
  console.log(`[ground] ${pages.length} grounded source pages`);
  if (!pages.length) throw new Error("no grounded pages - cluster is empty in the realm scope");

  const brief = buildBrief(topic, reg, pages);
  fs.mkdirSync(BRIEF_DIR, { recursive: true });
  const briefPath = path.join(BRIEF_DIR, `${topic.id}.brief.json`);
  fs.writeFileSync(briefPath, JSON.stringify(brief, null, 2));
  console.log(`[brief]  wrote ${briefPath} (cluster ${brief.cluster_size}, wall=${brief.gates.wall === "ok" ? "ok" : "REVIEW"})`);
  if (briefOnly) { console.log("[done]   --brief-only: stopping before render (no LLM, no spend)."); return; }

  console.log(`[render] ${OMNI_MODEL} via ${OMNI_URL} ...`);
  const html = await render(brief);
  if (!html.includes("<!DOCTYPE")) throw new Error("render did not return an HTML document");
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const outPath = path.join(OUT_DIR, `gbrain-topic-${topic.id}.html`);
  fs.writeFileSync(outPath, html);
  console.log(`[done]   ${outPath} (${html.length} bytes) - LOCAL preview only, nothing published`);
}
main().catch((e) => { console.error("[FATAL]", e.message); process.exit(1); });

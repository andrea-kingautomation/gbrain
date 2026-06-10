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
import { execFileSync } from "node:child_process";

const HERE = path.dirname(new URL(import.meta.url).pathname);
const HOME = os.homedir();
const REGISTRY = path.join(HERE, "topics.json");
const OUT_DIR = "/home/claude/outputs";
const BRIEF_DIR = path.join(HOME, ".gbrain/integrations/notion-wiki/briefs");

// OmniRoute internal endpoint (HTTP). The reasoning combo gbrain actually runs on.
const OMNI_URL = process.env.OMNIROUTE_URL || "http://127.0.0.1:20128/v1/chat/completions";
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

const DESIGN_BRIEF = (brief) => `You are the distillation + design pass of a self-building knowledge base.
Render ONE self-contained HTML page (all CSS inline, no external deps, must render inside a Notion embed iframe and as an offline file). Add <meta name="robots" content="noindex,nofollow">.

TOPIC: ${brief.title} (realm: ${brief.realm})
TREATMENT: ${brief.treatment} — follow the html-anything template "${brief.template}" and the hallmark disciplines (honest copy, structural variety, locked tokens, pre-emit critique stamp, mobile-safe). The design must FIT this topic's shape and must not look like a generic template.

HARD RULES:
- Honest copy: every sentence must be grounded in the source pages below. Do NOT invent metrics, quotes, or facts.
- Preserve verbatim quotes exactly; attribute provenance (the turn-refs) so the page is verifiable.
- Self-contained, noindex, mobile-responsive at 320/375/414/768px.

SOURCE PAGES (grounded corpus for this topic):
${brief.pages.map((p, i) => `[${i + 1}] ${p.title} (${p.date})\n${p.body.slice(0, 1400)}\nprovenance: ${p.provenance.join(", ") || "n/a"}`).join("\n\n")}

Output ONLY the HTML document, nothing else.`;

async function render(brief) {
  const key = (() => {
    try {
      const env = fs.readFileSync(path.join(HOME, ".omniroute/.env"), "utf8");
      const m = env.match(/OMNIROUTE_API_KEY\s*=\s*(.+)/);
      return m ? m[1].trim() : process.env.OMNIROUTE_API_KEY;
    } catch { return process.env.OMNIROUTE_API_KEY; }
  })();
  const res = await fetch(OMNI_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
    body: JSON.stringify({
      model: OMNI_MODEL,
      messages: [{ role: "user", content: DESIGN_BRIEF(brief) }],
      temperature: 0.5,
    }),
  });
  const j = await res.json();
  if (!res.ok) throw new Error(`OmniRoute ${res.status}: ${JSON.stringify(j).slice(0, 240)}`);
  let html = j.choices?.[0]?.message?.content || "";
  const a = html.indexOf("<!DOCTYPE"); const b = html.lastIndexOf("</html>");
  if (a >= 0 && b > a) html = html.slice(a, b + 7);
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

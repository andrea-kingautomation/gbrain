#!/usr/bin/env node
/**
 * refresh-topics.mjs - the maturity trigger for the self-building knowledge base.
 *
 * A page should keep getting better as the brain learns, without rebuilding on every
 * trivial change. For each topic this:
 *   1. grounds the cluster cheaply (psql COUNT + MAX(id), no LLM) to get a signature,
 *   2. compares it to the signature stored when the page was last built,
 *   3. rebuilds + republishes ONLY when the cluster has gained >= THRESHOLD new grounded
 *      pages AND it has been >= FLOOR_HOURS since the last build (floored ~once/day).
 *
 * Rebuild preserves the row's current Visibility (a Published page stays Published).
 * Run from cron; it self-gates per topic, so frequent runs are cheap and safe.
 *
 * USAGE
 *   node refresh-topics.mjs            # check all topics, rebuild the matured ones
 *   node refresh-topics.mjs --force <id>   # rebuild one topic regardless of gates
 *   node refresh-topics.mjs --dry-run  # report what would rebuild, do nothing
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

const HOME = os.homedir();
const HERE = path.dirname(new URL(import.meta.url).pathname);
const REGISTRY = path.join(HERE, "topics.json");
const STATE_FILE = path.join(HOME, ".gbrain/integrations/notion-wiki/topic-state.json");
const THRESHOLD = parseInt(process.env.REFRESH_THRESHOLD || "8", 10); // new grounded pages to trigger
const FLOOR_HOURS = parseInt(process.env.REFRESH_FLOOR_HOURS || "20", 10); // min hours between rebuilds

const argv = process.argv.slice(2);
const DRY = argv.includes("--dry-run");
const FORCE_ID = argv.includes("--force") ? argv[argv.indexOf("--force") + 1] : null;

const lit = (s) => "'" + String(s).replace(/'/g, "''") + "'";
const inList = (a) => a.map(lit).join(",");
function dbUrl() { return JSON.parse(fs.readFileSync(path.join(HOME, ".gbrain/config.json"), "utf8")).database_url; }
function q(sql) {
  return execFileSync("psql", [dbUrl(), "-At", "-F", "\x1f", "-c", sql], { encoding: "utf8" })
    .split("\n").filter(Boolean).map((r) => r.split("\x1f"));
}

// Cheap cluster signature: how many grounded pages, and the newest page id (monotonic).
function signature(topic, reg) {
  const sources = topic.source_override?.length ? topic.source_override : reg.realms[topic.realm].sources;
  let sql = `select count(*), coalesce(max(p.id),0) from pages p
    where p.deleted_at is null and p.source_id in (${inList(sources)})
      and p.id in (select t.page_id from tags t where t.tag in (${inList(topic.tags)}))`;
  if (topic.subject_exclude_tags?.length)
    sql += ` and p.id not in (select t2.page_id from tags t2 where t2.tag in (${inList(topic.subject_exclude_tags)}))`;
  const [row] = q(sql + ";");
  return { count: Number(row[0]), maxId: Number(row[1]) };
}

function hoursSince(iso) { if (!iso) return Infinity; return (Date.now() - Date.parse(iso)) / 3.6e6; }

function rebuild(id) {
  execFileSync("node", [path.join(HERE, "build-topic-page.mjs"), id], { stdio: "inherit" });
  execFileSync("node", [path.join(HERE, "publish-topic.mjs"), id], { stdio: "inherit" });
}

function main() {
  const reg = JSON.parse(fs.readFileSync(REGISTRY, "utf8"));
  let state = {}; try { state = JSON.parse(fs.readFileSync(STATE_FILE, "utf8")); } catch {}
  state.topics = state.topics || {};
  const topics = FORCE_ID ? reg.topics.filter((t) => t.id === FORCE_ID) : reg.topics;
  let rebuilt = 0;
  for (const topic of topics) {
    const rec = state.topics[topic.id] || {};
    const sig = signature(topic, reg);
    const prev = rec.built_signature || { count: 0, maxId: 0 };
    const newPages = Math.max(0, sig.count - prev.count);
    const matured = sig.maxId > prev.maxId && newPages >= THRESHOLD;
    const cooled = hoursSince(rec.built_at) >= FLOOR_HOURS;
    const go = FORCE_ID === topic.id || (matured && cooled);
    const why = FORCE_ID === topic.id ? "forced"
      : !rec.built_at ? `never built (have ${sig.count} pages)`
      : !matured ? `only +${newPages} new (need ${THRESHOLD})`
      : !cooled ? `cooled ${hoursSince(rec.built_at).toFixed(0)}h<${FLOOR_HOURS}h`
      : `matured +${newPages}`;
    console.log(`[${go ? "REBUILD" : "skip   "}] ${topic.id.padEnd(26)} count=${sig.count} (+${newPages}) :: ${why}`);
    if (go && !DRY) {
      rebuild(topic.id);
      state.topics[topic.id] = { ...(state.topics[topic.id] || {}), built_signature: sig, built_at: new Date().toISOString() };
      rebuilt++;
    } else if (go && DRY) { rebuilt++; }
  }
  if (!DRY) { fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true }); fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2)); }
  console.log(`[done] ${rebuilt} topic(s) ${DRY ? "would rebuild" : "rebuilt"}.`);
}
main();

#!/usr/bin/env node
/**
 * setup-gbrain-views.mjs - create navigation views on the G-Brain Notion DB.
 *
 * Idempotent: lists existing views and skips any whose name already exists.
 * Uses the Views API (2026-03-11) via the existing integration token.
 *
 *   node setup-gbrain-views.mjs            # create the standard view set
 *   node setup-gbrain-views.mjs --dry-run  # print the bodies, create nothing
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const HOME = os.homedir();
const SECRET_FILE = path.join(HOME, ".gbrain/secrets/notion-wiki.env");
const DB = process.env.NOTION_KB_DB_ID || "375eaa93-c844-8114-8fa0-ceba5a907e50";
const V = "2026-03-11";
const BASE = "https://api.notion.com/v1";
const DRY = process.argv.includes("--dry-run");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function token() {
  if (process.env.NOTION_TOKEN) return process.env.NOTION_TOKEN.trim();
  if (process.env.NOTION_API_KEY) return process.env.NOTION_API_KEY.trim();
  const m = fs.readFileSync(SECRET_FILE, "utf8").match(/^\s*NOTION_API_KEY\s*=\s*(.+)\s*$/m);
  return m ? m[1].trim().replace(/^["']|["']$/g, "") : null;
}
const TOKEN = token();
async function api(method, ep, body) {
  const res = await fetch(`${BASE}${ep}`, {
    method,
    headers: { Authorization: `Bearer ${TOKEN}`, "Notion-Version": V, "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  await sleep(340);
  const j = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${method} ${ep} ${res.status}: ${j.code || ""} ${j.message || ""}`);
  return j;
}

async function main() {
  const db = await api("GET", `/databases/${DB}`);
  const ds = db.data_sources[0];
  const dsFull = await api("GET", `/data_sources/${ds.id}`);
  const propId = {};
  for (const [name, p] of Object.entries(dsFull.properties)) propId[name] = p.id;
  const need = ["Realm", "Status", "Asset Type", "Updated", "Name"];
  for (const n of need) if (!propId[n]) throw new Error(`missing property '${n}' on G-Brain DS`);

  // Existing views (skip by name). The list endpoint returns sparse objects
  // WITHOUT names, so we must GET each view to read its name — otherwise the
  // skip-by-name check is empty and re-runs create duplicates.
  const existing = await api("GET", `/views?data_source_id=${ds.id}`);
  const have = new Set();
  for (const v of existing.results || []) {
    const full = await api("GET", `/views/${v.id}`).catch(() => null);
    if (full?.name) have.add(full.name);
  }

  const base = { database_id: DB, data_source_id: ds.id };
  // NB: the Views API (2026-03-11) does NOT accept a `configuration` for gallery
  // views (its configuration.type enum is table/board/calendar/timeline/list/
  // map/form/chart — no gallery). A bare gallery view is created; card cover /
  // visible-property tuning is UI-only for now.
  const views = [
    { name: "Library", type: "gallery" },
    { name: "By Realm", type: "board", configuration: { type: "board", group_by: { type: "select", property_id: propId["Realm"], sort: { type: "manual" } } } },
    { name: "By Asset Type", type: "board", configuration: { type: "board", group_by: { type: "select", property_id: propId["Asset Type"], sort: { type: "manual" } } } },
    { name: "By Status", type: "board", configuration: { type: "board", group_by: { type: "select", property_id: propId["Status"], sort: { type: "manual" } } } },
    { name: "Recently Updated", type: "table", sorts: [{ property: "Updated", direction: "descending" }] },
  ];

  for (const v of views) {
    if (have.has(v.name)) { console.log(`[skip]   "${v.name}" already exists`); continue; }
    const body = { ...base, ...v };
    if (DRY) { console.log(`[dry]    would create "${v.name}":`, JSON.stringify(v.configuration || v.sorts || {})); continue; }
    try {
      const r = await api("POST", `/views`, body);
      console.log(`[create] "${v.name}" -> ${r.id} (${r.type})`);
    } catch (e) {
      console.error(`[FAIL]   "${v.name}": ${e.message}`);
    }
  }
  console.log("done.");
}
main().catch((e) => { console.error("[FATAL]", e.message); process.exit(1); });

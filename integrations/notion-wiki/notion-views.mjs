#!/usr/bin/env node
/**
 * notion-views.mjs - programmatic Notion VIEW management (the autonomy gap).
 *
 * The classic Composio Notion toolkit and the self-hosted official MCP
 * (@notionhq/notion-mcp-server, pinned to API 2025-09-03) cannot create or
 * modify database VIEWS. Notion shipped the Views API (8 endpoints) under API
 * version 2026-03-11. Our existing integration token ("openclaw" bot, workspace
 * caps on "King of Automation") reaches it directly over REST - no OAuth, fully
 * headless. This wraps those endpoints so every seat can manage views end to end.
 *
 * Endpoints used (Notion-Version: 2026-03-11):
 *   GET    /v1/views?data_source_id=<ds>     list views on a data source
 *   GET    /v1/views/:id                     retrieve a view
 *   POST   /v1/views                         create a view
 *   PATCH  /v1/views/:id                     update a view (filter/sorts/name/layout)
 *   DELETE /v1/views/:id                     delete a view
 *
 * USAGE
 *   node notion-views.mjs ds <database_id>                  # resolve db -> data_source_id(s)
 *   node notion-views.mjs list <database_id|data_source_id>
 *   node notion-views.mjs get <view_id>
 *   node notion-views.mjs create <database_id> --type table --name "My View" [--spec file.json]
 *   node notion-views.mjs update <view_id> --spec file.json   # PATCH body from JSON
 *   node notion-views.mjs delete <view_id>
 *
 * AUTH: NOTION_TOKEN or NOTION_API_KEY env, else ~/.gbrain/secrets/notion-wiki.env.
 * Point NOTION_TOKEN at any workspace's integration token to manage that workspace.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const HOME = os.homedir();
const SECRET_FILE = path.join(HOME, ".gbrain/secrets/notion-wiki.env");
const NOTION_VERSION = process.env.NOTION_VIEWS_VERSION || "2026-03-11";
const BASE = "https://api.notion.com/v1";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function token() {
  if (process.env.NOTION_TOKEN) return process.env.NOTION_TOKEN.trim();
  if (process.env.NOTION_API_KEY) return process.env.NOTION_API_KEY.trim();
  try {
    const m = fs.readFileSync(SECRET_FILE, "utf8").match(/^\s*NOTION_API_KEY\s*=\s*(.+)\s*$/m);
    if (m) return m[1].trim().replace(/^["']|["']$/g, "");
  } catch {}
  throw new Error("no Notion token (set NOTION_TOKEN / NOTION_API_KEY or ~/.gbrain/secrets/notion-wiki.env)");
}
const TOKEN = token();

async function api(method, ep, body) {
  const res = await fetch(`${BASE}${ep}`, {
    method,
    headers: { Authorization: `Bearer ${TOKEN}`, "Notion-Version": NOTION_VERSION, "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  await sleep(340);
  const j = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`Notion ${method} ${ep} ${res.status}: ${j.code || ""} ${j.message || JSON.stringify(j).slice(0, 200)}`);
  return j;
}

// A database (container) holds one or more data sources; views attach to a data source.
async function resolveDataSource(idOrDb) {
  // If it's already a data source id, the list call will accept it; otherwise treat as a db id.
  const db = await api("GET", `/databases/${idOrDb}`).catch(() => null);
  if (db && Array.isArray(db.data_sources) && db.data_sources.length) {
    return { databaseId: idOrDb, dataSources: db.data_sources };
  }
  // Not a database id -> assume it is itself a data_source_id.
  return { databaseId: null, dataSources: [{ id: idOrDb, name: "(data source)" }] };
}

function argOf(flag) { const i = process.argv.indexOf(flag); return i > -1 ? process.argv[i + 1] : null; }
function readSpec() {
  const f = argOf("--spec");
  if (!f) return {};
  return JSON.parse(fs.readFileSync(f, "utf8"));
}
const out = (o) => console.log(JSON.stringify(o, null, 2));

async function main() {
  const [cmd, target] = process.argv.slice(2);
  if (!cmd) throw new Error("usage: notion-views.mjs <ds|list|get|create|update|delete> ...");

  if (cmd === "ds") {
    const r = await resolveDataSource(target);
    out(r);
  } else if (cmd === "list") {
    const { dataSources } = await resolveDataSource(target);
    for (const ds of dataSources) {
      const r = await api("GET", `/views?data_source_id=${ds.id}`);
      console.log(`# data_source ${ds.id} (${ds.name}) -> ${r.results?.length || 0} view(s)`);
      for (const v of r.results || []) console.log(`  ${v.id}  type=${v.type || v.view_type || "?"}  name=${JSON.stringify(v.name || "")}`);
    }
  } else if (cmd === "get") {
    out(await api("GET", `/views/${target}`));
  } else if (cmd === "create") {
    const { databaseId, dataSources } = await resolveDataSource(target);
    const spec = readSpec();
    const body = {
      database_id: databaseId || spec.database_id,
      data_source_id: spec.data_source_id || dataSources[0].id,
      type: argOf("--type") || spec.type || "table",
      ...(argOf("--name") ? { name: argOf("--name") } : spec.name ? { name: spec.name } : {}),
      ...(spec.filter ? { filter: spec.filter } : {}),
      ...(spec.sorts ? { sorts: spec.sorts } : {}),
      ...(spec.layout ? { layout: spec.layout } : {}),
    };
    out(await api("POST", `/views`, body));
  } else if (cmd === "update") {
    out(await api("PATCH", `/views/${target}`, readSpec()));
  } else if (cmd === "delete") {
    out(await api("DELETE", `/views/${target}`));
  } else {
    throw new Error(`unknown command '${cmd}'`);
  }
}
main().catch((e) => { console.error("[FATAL]", e.message); process.exit(1); });

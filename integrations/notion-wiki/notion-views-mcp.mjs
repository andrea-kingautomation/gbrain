#!/usr/bin/env node
/**
 * notion-views-mcp.mjs - stdio MCP server exposing Notion VIEW management.
 *
 * Wraps the Notion Views API (version 2026-03-11) that neither the classic
 * Composio Notion toolkit nor the self-hosted official MCP (pinned 2025-09-03)
 * exposes. Self-contained: raw newline-delimited JSON-RPC over stdio, no SDK
 * dependency. Auth via NOTION_TOKEN / NOTION_API_KEY / ~/.gbrain/secrets/notion-wiki.env.
 *
 * Tools: notion_list_views, notion_get_view, notion_create_view,
 *        notion_update_view, notion_delete_view.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";

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
  return null;
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
  if (!res.ok) throw new Error(`Notion ${method} ${ep} ${res.status}: ${j.code || ""} ${j.message || ""}`);
  return j;
}
async function resolveDataSources(idOrDb) {
  const db = await api("GET", `/databases/${idOrDb}`).catch(() => null);
  if (db && Array.isArray(db.data_sources) && db.data_sources.length)
    return { databaseId: idOrDb, dataSources: db.data_sources };
  return { databaseId: null, dataSources: [{ id: idOrDb, name: "(data source)" }] };
}

const TOOLS = [
  { name: "notion_list_views", description: "List views on a Notion database or data source. Pass a database_id (preferred) or a data_source_id.",
    inputSchema: { type: "object", properties: { id: { type: "string", description: "database_id or data_source_id" } }, required: ["id"] } },
  { name: "notion_get_view", description: "Retrieve a single Notion view by id (type, name, filter, sorts, layout).",
    inputSchema: { type: "object", properties: { view_id: { type: "string" } }, required: ["view_id"] } },
  { name: "notion_create_view", description: "Create a view on a database. type is one of table|board|calendar|timeline|gallery|list|form|chart|map. filter/sorts/layout are optional Notion view spec objects.",
    inputSchema: { type: "object", properties: {
      database_id: { type: "string" }, type: { type: "string" }, name: { type: "string" },
      data_source_id: { type: "string", description: "optional; defaults to the db's first data source" },
      filter: { type: "object" }, sorts: { type: "array" }, layout: { type: "object" } }, required: ["database_id", "type"] } },
  { name: "notion_update_view", description: "Update a view (PATCH). body is the partial Notion view object, e.g. {\"name\":\"X\"} or {\"filter\":{...}} or {\"sorts\":[...]}.",
    inputSchema: { type: "object", properties: { view_id: { type: "string" }, body: { type: "object" } }, required: ["view_id", "body"] } },
  { name: "notion_delete_view", description: "Delete a view by id.",
    inputSchema: { type: "object", properties: { view_id: { type: "string" } }, required: ["view_id"] } },
];

async function callTool(name, a = {}) {
  if (name === "notion_list_views") {
    const { dataSources } = await resolveDataSources(a.id);
    const out = [];
    for (const ds of dataSources) {
      const r = await api("GET", `/views?data_source_id=${ds.id}`);
      out.push({ data_source_id: ds.id, data_source_name: ds.name, views: (r.results || []).map((v) => ({ id: v.id, type: v.type, name: v.name })) });
    }
    return out;
  }
  if (name === "notion_get_view") return api("GET", `/views/${a.view_id}`);
  if (name === "notion_create_view") {
    const { databaseId, dataSources } = await resolveDataSources(a.database_id);
    const body = { database_id: databaseId || a.database_id, data_source_id: a.data_source_id || dataSources[0].id, type: a.type };
    if (a.name) body.name = a.name;
    if (a.filter) body.filter = a.filter;
    if (a.sorts) body.sorts = a.sorts;
    if (a.layout) body.layout = a.layout;
    return api("POST", `/views`, body);
  }
  if (name === "notion_update_view") return api("PATCH", `/views/${a.view_id}`, a.body || {});
  if (name === "notion_delete_view") return api("DELETE", `/views/${a.view_id}`);
  throw new Error(`unknown tool ${name}`);
}

const send = (msg) => process.stdout.write(JSON.stringify(msg) + "\n");
function ok(id, result) { send({ jsonrpc: "2.0", id, result }); }
function err(id, code, message) { send({ jsonrpc: "2.0", id, error: { code, message } }); }

const rl = readline.createInterface({ input: process.stdin });
rl.on("line", async (line) => {
  line = line.trim();
  if (!line) return;
  let msg;
  try { msg = JSON.parse(line); } catch { return; }
  const { id, method, params } = msg;
  try {
    if (method === "initialize") {
      ok(id, { protocolVersion: params?.protocolVersion || "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "notion-views", version: "1.0.0" } });
    } else if (method === "notifications/initialized" || method === "initialized") {
      /* notification, no reply */
    } else if (method === "tools/list") {
      ok(id, { tools: TOOLS });
    } else if (method === "tools/call") {
      if (!TOKEN) return ok(id, { content: [{ type: "text", text: "ERROR: no Notion token configured" }], isError: true });
      try {
        const result = await callTool(params?.name, params?.arguments || {});
        ok(id, { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] });
      } catch (e) {
        ok(id, { content: [{ type: "text", text: `ERROR: ${e.message}` }], isError: true });
      }
    } else if (method === "ping") {
      ok(id, {});
    } else if (id !== undefined) {
      err(id, -32601, `method not found: ${method}`);
    }
  } catch (e) {
    if (id !== undefined) err(id, -32603, e.message);
  }
});

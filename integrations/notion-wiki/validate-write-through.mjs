#!/usr/bin/env node
/**
 * validate-write-through.mjs - onboarding write-through check for the notion-wiki pipeline (I13 / W-C6).
 *
 * Proves ONE real write-through to the box owner's Notion knowledge base works end to end:
 *   1. resolve the per-box KB DB + asset config exactly like publish-topic.mjs (env -> domain skill -> refuse)
 *   2. GET the DB and discover its title property BY TYPE (customer DBs can name it anything)
 *   3. POST one clearly-labeled validation page into the DB
 *   4. GET the page back to verify it landed
 *   5. PATCH archived:true to clean up (skipped with --keep)
 *
 * Never falls back to an operator target: unresolved per-box config is a refusal, not a default.
 *
 * USAGE
 *   node validate-write-through.mjs           # run the check, archive the page afterwards
 *   node validate-write-through.mjs --keep    # leave the validation page in place
 *
 * EXIT CODES
 *   0  write-through verified
 *   2  per-box publishing target unresolved (kb_db_id / asset base_url / asset root)
 *   3  no Notion token (env NOTION_API_KEY or ~/.gbrain/secrets/notion-wiki.env)
 *   4  Notion API failure (stage named in the final JSON line)
 *
 * OUTPUT: human-readable progress on stderr; exactly ONE final JSON line on stdout:
 *   {"ok":true,"pageId":...,"url":...,"archived":true|false,"titleProp":...,"resolved":{...}}
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";

const HOME = os.homedir();
const SECRET_FILE = path.join(HOME, ".gbrain/secrets/notion-wiki.env");
const NOTION_VERSION = "2022-06-28";
const NOTION_BASE = "https://api.notion.com/v1";
const REPO = process.env.AGENT_CHAKRA_REPO || "/home/claude/agent-chakra";

// Per-box publishing targets (R2-AC18, config-is-a-skill): env override first, then the
// wiki-publishing domain skill via resolve_user_value, else REFUSE in the CLI. No hardcoded
// default: a customer box must never validate against the operator's Notion or asset host.
export function defaultResolveUserValue(key) {
  try {
    const out = execFileSync(
      "python3",
      [path.join(REPO, "infra/openclaw/scripts/resolve_user_value.py"), "--get", key, "--json"],
      { encoding: "utf8", timeout: 20000 },
    );
    const d = JSON.parse(out);
    if (d.resolved) return String(d.value);
  } catch {}
  return null;
}

/**
 * Mirror publish-topic.mjs resolution exactly: env override -> domain skill -> null.
 * The resolver is never invoked for a key whose env override is set.
 * Returns { dbId, baseUrl, root, resolved: {kb_db_id, base_url, root} }.
 */
export function resolveTargets({ env, resolveUserValue }) {
  const pick = (envKey, skillKey) =>
    env[envKey] != null && env[envKey] !== "" ? env[envKey] : resolveUserValue(skillKey);
  const dbId = pick("NOTION_KB_DB_ID", "wiki.notion.kb_db_id");
  const baseUrl = pick("WIKI_ASSET_BASE_URL", "wiki.assets.base_url");
  const root = pick("WIKI_ASSET_ROOT", "wiki.assets.root");
  return {
    dbId,
    baseUrl,
    root,
    resolved: { kb_db_id: !!dbId, base_url: !!baseUrl, root: !!root },
  };
}

/** Pure parser for the secrets file content (NOTION_API_KEY=... line). */
export function parseTokenFromEnvText(text) {
  const m = String(text).match(/^\s*NOTION_API_KEY\s*=\s*(.+)\s*$/m);
  return m ? m[1].trim().replace(/^["']|["']$/g, "") : null;
}

export function loadToken({ env = process.env, secretFile = SECRET_FILE } = {}) {
  if (env.NOTION_API_KEY) return env.NOTION_API_KEY.trim();
  try {
    return parseTokenFromEnvText(fs.readFileSync(secretFile, "utf8"));
  } catch {
    return null;
  }
}

/** Typed error carrying the failing stage plus the Notion status/body for the report. */
export class WriteThroughError extends Error {
  constructor(stage, status, body) {
    super(`write-through failed at stage '${stage}' (HTTP ${status}): ${JSON.stringify(body).slice(0, 300)}`);
    this.name = "WriteThroughError";
    this.stage = stage;
    this.status = status;
    this.body = body;
  }
}

const rt = (s) => [{ type: "text", text: { content: String(s).slice(0, 1990) } }];

/**
 * Run the write-through: database get -> page create -> page get -> archive patch.
 * All seams injectable for tests. Throws WriteThroughError with {stage,status,body} on
 * any API failure; stages are "database", "create", "verify", "archive".
 */
export async function runValidation({
  dbId,
  token,
  fetchImpl = fetch,
  now = () => new Date(),
  keep = false,
  sleepMs = 340,
  log = (msg) => process.stderr.write(`${msg}\n`),
}) {
  const sleep = (ms) => (ms > 0 ? new Promise((r) => setTimeout(r, ms)) : Promise.resolve());
  async function api(stage, method, ep, body) {
    const res = await fetchImpl(`${NOTION_BASE}${ep}`, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        "Notion-Version": NOTION_VERSION,
        "Content-Type": "application/json",
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    await sleep(sleepMs);
    const j = await res.json().catch(() => ({}));
    if (!res.ok) throw new WriteThroughError(stage, res.status, j);
    return j;
  }

  // a. discover the title property NAME by type (never assume it is called "Name" or "Title").
  log(`[db]      GET database ${dbId}`);
  const db = await api("database", "GET", `/databases/${dbId}`);
  const titleProp = Object.entries(db.properties || {}).find(([, p]) => p?.type === "title")?.[0];
  if (!titleProp) throw new WriteThroughError("database", 200, { message: "no title property found on target DB" });
  log(`[db]      title property is "${titleProp}"`);

  // b. create the validation page.
  const stamp = now().toISOString().slice(0, 16) + "Z"; // minutes precision
  const title = `Wiki write-through check ${stamp}`;
  const createBody = {
    parent: { database_id: dbId },
    properties: { [titleProp]: { title: rt(title) } },
    children: [
      {
        object: "block",
        type: "paragraph",
        paragraph: {
          rich_text: rt(
            "This is an automatic Agent Chakra onboarding validation page proving the wiki pipeline can write to your knowledge base. It is safe to delete.",
          ),
        },
      },
    ],
  };
  log(`[create]  POST page "${title}"`);
  const page = await api("create", "POST", "/pages", createBody);
  const pageId = page.id;
  const url = page.url || null;
  log(`[create]  page ${pageId} created`);

  // c. read it back to verify it landed.
  log(`[verify]  GET page ${pageId}`);
  const back = await api("verify", "GET", `/pages/${pageId}`);
  if (back.object !== "page" || back.id !== pageId) {
    throw new WriteThroughError("verify", 200, { message: "created page did not read back", got: back.object });
  }

  // d. clean up unless asked to keep the evidence page.
  let archived = false;
  if (keep) {
    log("[archive] --keep passed, leaving the validation page in place");
  } else {
    log(`[archive] PATCH page ${pageId} archived:true`);
    await api("archive", "PATCH", `/pages/${pageId}`, { archived: true });
    archived = true;
  }

  return { ok: true, pageId, url, archived, titleProp };
}

async function main() {
  const argv = process.argv.slice(2);
  const keep = argv.includes("--keep");

  const targets = resolveTargets({ env: process.env, resolveUserValue: defaultResolveUserValue });
  process.stderr.write(
    `[resolve] kb_db_id=${targets.resolved.kb_db_id} asset_base_url=${targets.resolved.base_url} asset_root=${targets.resolved.root}\n`,
  );
  if (!targets.resolved.kb_db_id || !targets.resolved.base_url || !targets.resolved.root) {
    process.stderr.write(
      "validate-write-through: per-box publishing target unresolved " +
        `(kb_db_id=${targets.resolved.kb_db_id} asset_base_url=${targets.resolved.base_url} asset_root=${targets.resolved.root}). ` +
        "Fill skills/wiki-publishing values (wiki.notion.kb_db_id / wiki.assets.*) or set " +
        "NOTION_KB_DB_ID / WIKI_ASSET_BASE_URL / WIKI_ASSET_ROOT. Refusing to validate; " +
        "never an operator fallback.\n",
    );
    console.log(JSON.stringify({ ok: false, stage: "resolve", error: "per-box publishing target unresolved", resolved: targets.resolved }));
    process.exit(2);
  }

  const token = loadToken();
  if (!token) {
    process.stderr.write("validate-write-through: no NOTION_API_KEY (env or ~/.gbrain/secrets/notion-wiki.env)\n");
    console.log(JSON.stringify({ ok: false, stage: "token", error: "no NOTION_API_KEY", resolved: targets.resolved }));
    process.exit(3);
  }

  try {
    const r = await runValidation({ dbId: targets.dbId, token, keep });
    console.log(JSON.stringify({ ...r, resolved: targets.resolved }));
    process.exit(0);
  } catch (e) {
    const stage = e.stage || "unknown";
    const body = e.body !== undefined ? e.body : String(e.message || e);
    process.stderr.write(`[FATAL]   stage=${stage} ${e.message}\n`);
    console.log(JSON.stringify({ ok: false, stage, status: e.status ?? null, error: body, resolved: targets.resolved }));
    process.exit(4);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}

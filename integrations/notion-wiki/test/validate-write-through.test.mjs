/**
 * Tests for validate-write-through.mjs. No network: every Notion call goes through
 * a scripted fake fetch. Fixture ids are obviously fake.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  resolveTargets,
  parseTokenFromEnvText,
  runValidation,
  WriteThroughError,
} from "../validate-write-through.mjs";

const FAKE_DB = "db-fixture-00000000000000000000";
const FAKE_PAGE = "page-fixture-1111111111111111";

// ---------- resolveTargets ----------

test("resolveTargets: all three resolve via the resolver when env is empty", () => {
  const calls = [];
  const r = resolveTargets({
    env: {},
    resolveUserValue: (k) => {
      calls.push(k);
      return `resolved:${k}`;
    },
  });
  assert.deepEqual(r.resolved, { kb_db_id: true, base_url: true, root: true });
  assert.equal(r.dbId, "resolved:wiki.notion.kb_db_id");
  assert.equal(r.baseUrl, "resolved:wiki.assets.base_url");
  assert.equal(r.root, "resolved:wiki.assets.root");
  assert.deepEqual(calls.sort(), ["wiki.assets.base_url", "wiki.assets.root", "wiki.notion.kb_db_id"]);
});

test("resolveTargets: kb_db_id missing is reported unresolved", () => {
  const r = resolveTargets({
    env: {},
    resolveUserValue: (k) => (k === "wiki.notion.kb_db_id" ? null : "https://fake.example/assets"),
  });
  assert.equal(r.resolved.kb_db_id, false);
  assert.equal(r.resolved.base_url, true);
  assert.equal(r.resolved.root, true);
  assert.equal(r.dbId, null);
});

test("resolveTargets: env override wins and the resolver is never called for that key", () => {
  const calls = [];
  const r = resolveTargets({
    env: { NOTION_KB_DB_ID: FAKE_DB },
    resolveUserValue: (k) => {
      calls.push(k);
      return "from-resolver";
    },
  });
  assert.equal(r.dbId, FAKE_DB);
  assert.ok(!calls.includes("wiki.notion.kb_db_id"), "resolver must not be called when env is set");
  // the other two keys still go through the resolver
  assert.deepEqual(calls.sort(), ["wiki.assets.base_url", "wiki.assets.root"]);
});

test("resolveTargets: all three env overrides mean zero resolver calls", () => {
  let called = 0;
  const r = resolveTargets({
    env: {
      NOTION_KB_DB_ID: FAKE_DB,
      WIKI_ASSET_BASE_URL: "https://fake.example/assets",
      WIKI_ASSET_ROOT: "/srv/fake-assets",
    },
    resolveUserValue: () => {
      called++;
      return "x";
    },
  });
  assert.equal(called, 0);
  assert.deepEqual(r.resolved, { kb_db_id: true, base_url: true, root: true });
});

// ---------- fake fetch harness ----------

function jsonResponse(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  };
}

// DB fixture whose title property is named "Name" (NOT "title") to prove discovery by TYPE.
const DB_FIXTURE = {
  object: "database",
  id: FAKE_DB,
  properties: {
    Summary: { id: "aaa", type: "rich_text" },
    Name: { id: "title", type: "title" },
    Updated: { id: "bbb", type: "date" },
  },
};

function scriptedFetch(script, calls) {
  return async (url, opts) => {
    const call = { url, method: opts.method, body: opts.body ? JSON.parse(opts.body) : undefined, headers: opts.headers };
    calls.push(call);
    const step = script.shift();
    assert.ok(step, `unexpected extra fetch call: ${opts.method} ${url}`);
    return jsonResponse(step.status, step.body);
  };
}

const FIXED_NOW = () => new Date("2026-07-17T09:30:45.123Z");

// ---------- runValidation ----------

test("runValidation happy path: call order, title-by-type, bodies, archived:true", async () => {
  const calls = [];
  const fetchImpl = scriptedFetch(
    [
      { status: 200, body: DB_FIXTURE },
      { status: 200, body: { object: "page", id: FAKE_PAGE, url: `https://notion.example/${FAKE_PAGE}` } },
      { status: 200, body: { object: "page", id: FAKE_PAGE } },
      { status: 200, body: { object: "page", id: FAKE_PAGE, archived: true } },
    ],
    calls,
  );
  const r = await runValidation({ dbId: FAKE_DB, token: "fake-token", fetchImpl, now: FIXED_NOW, sleepMs: 0, log: () => {} });

  // call ORDER: database get -> page create -> page get -> archive patch
  assert.equal(calls.length, 4);
  assert.equal(calls[0].method, "GET");
  assert.ok(calls[0].url.endsWith(`/v1/databases/${FAKE_DB}`));
  assert.equal(calls[1].method, "POST");
  assert.ok(calls[1].url.endsWith("/v1/pages"));
  assert.equal(calls[2].method, "GET");
  assert.ok(calls[2].url.endsWith(`/v1/pages/${FAKE_PAGE}`));
  assert.equal(calls[3].method, "PATCH");
  assert.ok(calls[3].url.endsWith(`/v1/pages/${FAKE_PAGE}`));

  // headers carry the token and a Notion-Version on every call
  for (const c of calls) {
    assert.equal(c.headers.Authorization, "Bearer fake-token");
    assert.ok(c.headers["Notion-Version"]);
  }

  // create body: discovered title prop ("Name", found by TYPE) + paragraph block
  const create = calls[1].body;
  assert.deepEqual(Object.keys(create.properties), ["Name"]);
  const titleText = create.properties.Name.title[0].text.content;
  assert.ok(titleText.startsWith("Wiki write-through check 2026-07-17T09:30Z"), `bad title: ${titleText}`);
  assert.equal(create.parent.database_id, FAKE_DB);
  assert.equal(create.children.length, 1);
  assert.equal(create.children[0].type, "paragraph");
  assert.match(create.children[0].paragraph.rich_text[0].text.content, /safe to delete/);

  // archive body
  assert.deepEqual(calls[3].body, { archived: true });

  assert.equal(r.ok, true);
  assert.equal(r.pageId, FAKE_PAGE);
  assert.equal(r.archived, true);
  assert.equal(r.titleProp, "Name");
  assert.equal(r.url, `https://notion.example/${FAKE_PAGE}`);
});

test("runValidation keep:true skips the archive call and returns archived:false", async () => {
  const calls = [];
  const fetchImpl = scriptedFetch(
    [
      { status: 200, body: DB_FIXTURE },
      { status: 200, body: { object: "page", id: FAKE_PAGE, url: null } },
      { status: 200, body: { object: "page", id: FAKE_PAGE } },
    ],
    calls,
  );
  const r = await runValidation({ dbId: FAKE_DB, token: "fake-token", fetchImpl, now: FIXED_NOW, keep: true, sleepMs: 0, log: () => {} });
  assert.equal(calls.length, 3, "archive PATCH must not fire with keep:true");
  assert.ok(!calls.some((c) => c.method === "PATCH"));
  assert.equal(r.archived, false);
  assert.equal(r.ok, true);
});

test("runValidation: create failure throws typed error with stage 'create' and the body", async () => {
  const calls = [];
  const apiError = { object: "error", status: 400, code: "validation_error", message: "body failed validation" };
  const fetchImpl = scriptedFetch(
    [
      { status: 200, body: DB_FIXTURE },
      { status: 400, body: apiError },
    ],
    calls,
  );
  await assert.rejects(
    runValidation({ dbId: FAKE_DB, token: "fake-token", fetchImpl, now: FIXED_NOW, sleepMs: 0, log: () => {} }),
    (e) => {
      assert.ok(e instanceof WriteThroughError);
      assert.equal(e.stage, "create");
      assert.equal(e.status, 400);
      assert.deepEqual(e.body, apiError);
      return true;
    },
  );
  assert.equal(calls.length, 2, "must stop after the failed create");
});

test("runValidation: verify failure carries stage 'verify'", async () => {
  const calls = [];
  const fetchImpl = scriptedFetch(
    [
      { status: 200, body: DB_FIXTURE },
      { status: 200, body: { object: "page", id: FAKE_PAGE } },
      { status: 404, body: { object: "error", status: 404, code: "object_not_found", message: "Could not find page" } },
    ],
    calls,
  );
  await assert.rejects(
    runValidation({ dbId: FAKE_DB, token: "fake-token", fetchImpl, now: FIXED_NOW, sleepMs: 0, log: () => {} }),
    (e) => {
      assert.equal(e.stage, "verify");
      assert.equal(e.status, 404);
      return true;
    },
  );
  assert.equal(calls.length, 3, "must stop after the failed verify (no archive attempt)");
});

test("runValidation: DB with no title property fails at stage 'database'", async () => {
  const calls = [];
  const fetchImpl = scriptedFetch(
    [{ status: 200, body: { object: "database", id: FAKE_DB, properties: { Summary: { type: "rich_text" } } } }],
    calls,
  );
  await assert.rejects(
    runValidation({ dbId: FAKE_DB, token: "fake-token", fetchImpl, now: FIXED_NOW, sleepMs: 0, log: () => {} }),
    (e) => e.stage === "database",
  );
});

// ---------- token parsing ----------

test("parseTokenFromEnvText: parses NOTION_API_KEY from fixture text", () => {
  const text = "# notion wiki secrets\nSOMETHING_ELSE=abc\nNOTION_API_KEY=secret_fixture_not_a_real_key_123\n";
  assert.equal(parseTokenFromEnvText(text), "secret_fixture_not_a_real_key_123");
});

test("parseTokenFromEnvText: strips quotes and whitespace", () => {
  assert.equal(parseTokenFromEnvText('NOTION_API_KEY = "quoted_fixture_key"  \n'), "quoted_fixture_key");
  assert.equal(parseTokenFromEnvText("NOTION_API_KEY='single_fixture_key'\n"), "single_fixture_key");
});

test("parseTokenFromEnvText: returns null when the key line is absent", () => {
  assert.equal(parseTokenFromEnvText("OTHER=1\n"), null);
});

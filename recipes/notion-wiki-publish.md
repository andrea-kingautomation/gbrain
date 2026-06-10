---
id: notion-wiki-publish
name: Notion Wiki Publish
version: 0.1.0
description: gbrain's LLM-maintained wiki (ideas + reflections) is published into a dedicated, navigable Notion database. One page per entry, with Type / Category / Topics / Date / Source so the operator can filter, group and scroll visually. Re-syncs changed pages on each dream cycle.
category: reflex
requires: []
secrets:
  - name: NOTION_API_KEY
    description: Notion Internal Integration secret for the King of Automation workspace (starts ntn_ or secret_). A headless reflex cannot use an interactive-OAuth MCP, so a token is the correct durable transport.
    where: notion.so → Settings → Connections → "Develop or manage integrations" → New integration (Internal, workspace = King of Automation, name "gbrain-wiki"). Copy the Internal Integration Secret. Then open one Notion page → ⋯ → Connections → add "gbrain-wiki" so the integration can see it. The database is created inside that page.
health_checks:
  - type: http
    url: "https://api.notion.com/v1/users/me"
    auth: bearer
    auth_token: "$NOTION_API_KEY"
    label: "Notion API"
setup_time: 5 min
cost_estimate: "$0 (Notion API is free). Optional --categorize LLM pass: ~475 small omniroute calls on first full run, pennies."
---

# Notion Wiki Publish: Your G-Brain, Browsable

gbrain already distills your conversations into a wiki of ideas and reflections.
This reflex publishes that wiki into a dedicated Notion database so you can search,
filter and scroll through your thinking visually instead of guessing at slugs.

## IMPORTANT: Instructions for the Agent

**You are the installer.** Follow these steps precisely.

**The core pattern: code for data, LLMs for judgment.**
The LLM work (distilling conversations into clean wiki pages) is already done by
gbrain's `dream`/`autopilot`. This reflex is the deterministic transport: it reads
the wiki markdown, maps it to Notion pages, and keeps them in sync. The only optional
LLM step is `--categorize`, which assigns each page a clean top-level Category.

**Why a token, not the Composio/Notion MCP:**
A scheduled reflex runs headless from the gbrain daemon. An interactive-OAuth MCP
proxy (Composio, official Notion MCP) cannot authenticate without a browser session,
so it is the wrong transport for unattended publishing. An Internal Integration
token hits `api.notion.com` directly and works headless. This is also the documented
fix for the long-standing content/founder-seat Composio-Notion failures.

## Architecture

```
gbrain dream/autopilot  (LLM maintains content)
  ↓ writes
~/.gbrain/sources/<source>/wiki/
  ├── originals/ideas/*.md          (type: original  → "Idea")
  └── personal/reflections/*.md     (type: reflection → "Reflection")
  ↓ read by
publish.mjs  (deterministic transport, this recipe)
  ├── parse frontmatter + markdown body
  ├── derive Category (heuristic) or refine with --categorize (omniroute koa-default)
  ├── Topics  ← frontmatter tags  (accurate per-topic axis)
  ├── markdown → Notion blocks (headings, quotes, lists, bold/italic/code/links)
  └── upsert via Notion REST API  (idempotent, incremental by content hash)
  ↓
Notion database "🧠 G-Brain Wiki"
  Properties: Name · Type · Category · Topics · Date · Source · Slug · Updated
  State: ~/.gbrain/integrations/notion-wiki/state.json  (db id + slug→pageId + hash)
```

## Database schema (what the operator gets)

| Property | Type | Source | Use |
|---|---|---|---|
| Name | title | wiki `title` | page name |
| Type | select | wiki `type` | Idea / Reflection / Concept / … (group by this) |
| Category | select | heuristic or LLM | Business / Product & Engineering / Strategy & Ops / Personal & Reflection / Knowledge |
| Topics | multi_select | wiki `tags` | the accurate per-topic axis (filter by these) |
| Date | date | `effective_date`/`date` | sort/timeline |
| Source | rich_text | wiki `source` | provenance (conversation id) |
| Slug | rich_text | filename | unique upsert key |
| Updated | date | publish time | last sync |

Recommended Notion views (create in the UI, the API cannot create views):
- **Gallery grouped by Category** — the visual scroll the operator asked for.
- **Board grouped by Type** — Ideas vs Reflections columns.
- **Table filtered by Topics** — drill into one theme.

## Step 1 — Provide the token

Set the secret (either env or the gbrain secret file):

```bash
mkdir -p ~/.gbrain/secrets
echo 'NOTION_API_KEY=ntn_xxxxxxxxxxxxxxxxxxxx' > ~/.gbrain/secrets/notion-wiki.env
chmod 600 ~/.gbrain/secrets/notion-wiki.env
```

Verify health:

```bash
curl -s https://api.notion.com/v1/users/me \
  -H "Authorization: Bearer $(grep -oP 'NOTION_API_KEY=\K.*' ~/.gbrain/secrets/notion-wiki.env)" \
  -H "Notion-Version: 2022-06-28" | head -c 300
```

A JSON object with `"type":"bot"` means the integration is live. Make sure at least
one page is shared with the integration (⋯ → Connections → gbrain-wiki).

## Step 2 — First publish (creates the database)

```bash
cd ~/gbrain/integrations/notion-wiki
set -a; . ~/.gbrain/secrets/notion-wiki.env; set +a
node publish.mjs --full --categorize        # ~475 pages, creates DB + all pages
```

The DB is created inside the first page shared with the integration. To pin a
specific parent: `node publish.mjs --parent <page_id>`. The db id is saved to
`state.json` and reused.

## Step 3 — Wire the reflex (incremental, on each dream cycle)

The publisher is incremental by default (only pages whose content hash changed are
re-published), so it is cheap to run often. Wire it to fire after the gbrain dream
cycle that maintains the wiki:

```bash
# add to the dream/autopilot post-hook (or a systemd --user timer)
cd ~/gbrain/integrations/notion-wiki \
  && set -a && . ~/.gbrain/secrets/notion-wiki.env && set +a \
  && node publish.mjs >> ~/.gbrain/integrations/notion-wiki/publish.log 2>&1
```

A standalone systemd `--user` timer (e.g. every 30 min, matching the autopilot
interval) is equally fine. Incremental runs with no wiki changes do zero Notion writes.

## Commands

| Command | Effect |
|---|---|
| `node publish.mjs --dry-run` | parse + build payloads, validate, no network |
| `node publish.mjs` | incremental publish (changed pages only) |
| `node publish.mjs --full` | republish every page |
| `node publish.mjs --categorize` | LLM top-level Category pass (omniroute koa-default) |
| `node publish.mjs --limit N` | cap to N pages (testing) |
| `node publish.mjs --parent <id>` | force the parent page hosting the DB |

## Notes / guardrails

- **Idempotent:** re-running never duplicates; pages are upserted by `Slug` and
  skipped when their content hash is unchanged.
- **Source of truth stays gbrain.** This is a one-way publish (brain → Notion). A
  future `notion-to-brain` sense could close the loop (operator edits in Notion flow
  back), but is intentionally out of scope here to avoid write conflicts.
- **Multi-source:** point at any brain via `GBRAIN_WIKI_DIR`. Default is the
  personal-conversations source.
- **Rate limits:** the client self-throttles to ~3 req/s (Notion's limit).
- **Token scope:** the integration only sees pages explicitly shared with it. Keep it
  to a dedicated G-Brain parent page; do not share client/external databases.

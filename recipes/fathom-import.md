---
id: fathom-import
name: Fathom History Import
version: 0.1.0
description: One-time bootstrap of existing Fathom meeting recordings into gbrain as meeting-typed pages (facts-eligible), via the Composio Fathom connected account. Go-forward live capture is handled by Vexa (see vexa-autojoin.md), not this recipe.
category: sense
owner_seat: content
status: built; runs in an OpenClaw content session (needs the Composio MCP, which exposes the live FATHOM_* tools). The content CC seat's Composio CLI is non-functional in this environment; the REST tool-catalog filter also returns empty, so DO NOT try to enumerate Fathom tools from a resumed CC session — enumerate them from the OpenClaw MCP at session start.
secrets:
  - name: COMPOSIO (connected account)
    description: Fathom is connected via Composio OAuth2. Connected account id = ca_6EDMC_sa2gBY (user_id "koa", status ACTIVE as of 2026-06-03). No separate token to manage; the OpenClaw Composio MCP holds the OAuth token.
    where: Composio project. Verify with the project API key in 1Password ("composio project api key", vault "api keys", field credential).
cost_estimate: "$0 (Fathom API read is free; LLM cost is only the downstream facts extraction, ~$0.01-0.02 per meeting page)"
---

# Fathom History Import: existing recordings -> brain meeting pages

Pulls the EXISTING Fathom meeting library (the recordings already captured before we
switch go-forward capture to Vexa) and writes each as a `meeting`-typed gbrain page.
Because `meeting` is in the conversation-facts extractor allowlist
(`conversation, meeting, slack, email`), these pages ARE facts-eligible — unlike the
`conversation_turn`-typed chat backfill, which the extractor does not see. So this
import is the one meeting path that actually compounds into facts/takes today.

## IMPORTANT: Instructions for the Agent (you are the installer)

This recipe runs inside an OpenClaw **content** session, where the Composio MCP is
loaded and exposes the live Fathom tools. It does NOT run from a resumed Claude Code
seat (that environment's Composio CLI prints nothing and the REST `/tools` filter
returns 0 for fathom — verified 2026-06-04).

### Step 1 — enumerate the live Fathom tools
At session start, list the Composio Fathom toolkit tools from the MCP (do not guess
slugs; the FATHOM_* names were not enumerable offline). Fathom exposes **7 tools**
(`triggers_count: 0`) over base `https://fathom.video/external/v1`, OAuth2. Identify
the list-meetings tool and the get-transcript/get-meeting tool. If a tool is missing,
fall back to `composio proxy`/MCP raw call against `https://fathom.video/external/v1/meetings`
through connected account `ca_6EDMC_sa2gBY`.

### Step 2 — pull the meeting list
Call the list-meetings tool (paginate to the start of history). For each meeting,
capture: id, title, start time, duration, attendees, meeting/platform, and the
transcript + AI summary + action items (fetch per-meeting if the list call omits them).

### Step 3 — write one gbrain page per meeting (idempotent)
Target source: the same source the live meeting pipeline uses. If none exists yet,
create an **isolated** source `fathom-meetings` (federated:false, so it never pollutes
`default` cross-source recall — the operator's standing concern). Page format:

```markdown
---
type: meeting
source_id: fathom_<fathom_meeting_id>
source_type: fathom
title: <meeting title>
date: <YYYY-MM-DD>
duration: <N min>
attendees: [Name A, Name B]
location: <Google Meet | Zoom | Teams>
tags: [<derived topical tags>]
---

## Key Points
- <from Fathom AI summary>

## Action Items
- [ ] <owner>: <action>

---

## Transcript
**Speaker** (00:00): ...
```

Rules:
- **Idempotent by `source_id`** (`fathom_<id>`). If a page with that source_id exists, skip.
- Attendee filtering: skip room resources and group addresses; display names, not emails.
- Keep the raw transcript in the page so facts extraction has the full signal.

### Step 4 — extract facts/takes from the imported meetings
Once pages are written and synced, run on the host (bun on PATH at
`/home/claude/.bun/bin`):
```bash
gbrain extract-conversation-facts --source-id fathom-meetings --types meeting --workers 8 --max-cost-usd 5 --yes
gbrain takes extract --from-pages   # bootstrap takes from the same pages
```
`meeting` is in the allowlist, so this produces real facts (unlike the chat corpus).
Routing stays adaptive `koa-default` (no hardcoded model). Report actual spent cost.

### Step 5 — verify
- `gbrain doctor` -> `facts_health` should show > 0 active facts.
- Spot-check 2-3 pages for attendee/action-item fidelity.

## Notes / boundaries
- This is a ONE-TIME history bootstrap. Go-forward auto-capture = Vexa (`vexa-autojoin.md`).
- Do NOT federate `fathom-meetings` into `default`; keep it isolated unless the
  operator asks to merge.
- This recipe is additive (new source + new pages). It does not touch the existing
  `default`/`agent-chakra`/`koa-claude-context`/`personal` sources.

---
id: vexa-autojoin
name: Vexa Auto-Join (go-forward meeting capture)
version: 0.1.0
description: Go-forward meeting capture. A Vexa bot auto-joins scheduled Google Meet / Zoom / Teams calls (read from Google Calendar), transcribes, and the transcript lands in gbrain as a meeting-typed page. Replaces Fathom for new meetings; works regardless of whether the operator joins from mobile or desktop, because the bot joins via the meeting URL.
category: sense
owner_seat: content
status: designed; BLOCKED on one operator action (signup -> API key). Orchestration is buildable now (Google Calendar is already a connected Composio account).
secrets:
  - name: VEXA_API_KEY
    description: Vexa cloud API key, format vx_sk_...
    where: https://vexa.ai -> sign up (gives $5 free bot credit, NO credit card required, ~16 hrs at $0.30/hr) -> dashboard -> API key. Store in 1Password vault "api keys" as "vexa api key".
cost_estimate: "Pay-as-you-go: $0.30/hr bot infra + $0.20/hr transcription = ~$0.50/hr/meeting. 12 months audio storage included. First ~16 hrs free ($5 credit, no card). Individual plan $12/mo = 1 bot if a flat rate is preferred later."
---

# Vexa Auto-Join: bot joins your calls, transcript becomes a brain page

## Why Vexa (vs Fathom/Fireflies/Circleback) for go-forward
- The bot joins by **meeting URL**, so it captures the call whether the operator is on
  the Google Meet/Zoom **mobile** app or desktop — no device-side app, no phone needed.
  (This is what the operator confirmed: "you don't really need to use cell phones.")
- Pay-as-you-go, no subscription lock-in (irregular meeting schedule) — $0.50/hr all-in.
- Open-source core; cloud managed plan stores recordings 12 months.
- Meet + Zoom + Teams all via one REST API.

## API (verified 2026-06-04)
- Base URL: `https://api.cloud.vexa.ai`
- Auth header: `X-API-Key: vx_sk_...`
- Dispatch a bot: `POST /bots` with `{ "platform": "google_meet" | "zoom" | "teams", "native_meeting_id": "<id from the meeting URL>" }`
- Transcript: retrieved by polling the bot/meeting resource (or webhook if configured).
- Calendar auto-join is **NOT** a native dashboard toggle — it is an orchestration:
  Google Calendar "event started" -> extract the meeting link -> `POST /bots`.
  (Vexa publishes n8n templates that do exactly this; we build the same in OpenClaw.)

## The ONE blocker (operator action)
Sign up at https://vexa.ai (free, no credit card, $5 credit) and paste the `vx_sk_...`
key — or tell me to self-serve the signup and which email/inbox to verify against.
Everything below is buildable the moment the key exists.

## Orchestration (OpenClaw, built once key exists)
1. **Calendar watch** (Composio `googlecalendar`, already connected): a cron in the
   content agent polls upcoming events (next ~10 min) every few minutes, OR subscribes
   to the calendar "event started" trigger.
2. **Link extract**: from each event's conferencing data, pull the platform +
   `native_meeting_id` (the Meet code / Zoom meeting id). Skip events with no video link.
3. **Dispatch**: `POST https://api.cloud.vexa.ai/bots` with the key; bot joins, stays
   for the call, leaves automatically.
4. **Collect**: when the meeting ends, fetch the transcript (poll the meeting resource).
5. **Ingest**: write a `meeting`-typed gbrain page (same format as `fathom-import.md`,
   `source_type: vexa`, `source_id: vexa_<meeting_id>`, idempotent). Isolated source
   `vexa-meetings` (federated:false) unless the operator asks to merge.
6. **Facts**: `gbrain extract-conversation-facts --source-id vexa-meetings --types meeting`
   produces facts/takes (meeting type is in the allowlist). Adaptive `koa-default` routing.

## VALIDATED + READY TO REGISTER (2026-06-04)
- Vexa key (1P "vexa.ai meeting bot" / credential) tested live: GET /bots, /meetings -> 200, pay-per-use active.
- Composio v3 REST path works: POST /api/v3/tools/execute/GOOGLECALENDAR_EVENTS_LIST with
  `{user_id, arguments:{calendarId:"primary", timeMin, timeMax, singleEvents:true, orderBy:"startTime"}}`.
  NOTE: `calendarId` is REQUIRED (omit -> error). user_id = the email the account was connected under.
- 3 ACTIVE calendars: ercolessiandrea97@gmail.com, thesneakersdaddy@gmail.com, contact@kingofautomation.com.
  The script auto-resolves the first ACTIVE googlecalendar user_id; extend to loop all three for full coverage.
- Orchestration script: `gbrain/integrations/vexa/vexa-autojoin.mjs` (modes: `dispatch`, `collect`).
  Reads COMPOSIO_API_KEY + VEXA_API_KEY from env or 1Password.

Cron jobs to register via the gateway cron tool (NOT by hand-editing jobs.json):
```jsonc
// dispatcher — every 3 min, send a bot to imminent meetings
{ "agentId":"content", "name":"Vexa auto-join dispatcher", "enabled":true,
  "schedule":{"kind":"cron","expr":"*/3 * * * *","tz":"UTC"},
  "sessionTarget":"isolated","wakeMode":"next-heartbeat",
  "payload":{"kind":"agentTurn","message":"Run: node /home/claude/gbrain/integrations/vexa/vexa-autojoin.mjs dispatch","timeoutSeconds":120},
  "delivery":{"mode":"none"} }
// collector — every 10 min, pull finished transcripts into gbrain
{ "agentId":"content", "name":"Vexa transcript collector", "enabled":true,
  "schedule":{"kind":"cron","expr":"*/10 * * * *","tz":"UTC"},
  "sessionTarget":"isolated","wakeMode":"next-heartbeat",
  "payload":{"kind":"agentTurn","message":"Run: node /home/claude/gbrain/integrations/vexa/vexa-autojoin.mjs collect; then gbrain sources add vexa-meetings --path ~/.gbrain/sources/vexa-meetings (once) and gbrain sync --source vexa-meetings; then gbrain extract-conversation-facts --source-id vexa-meetings --types meeting --yes","timeoutSeconds":300},
  "delivery":{"mode":"none"} }
```
First-real-meeting TODO: confirm the Vexa transcript endpoint shape (`GET /meetings/{platform}/{id}` -> segments[]) and adjust `collect()` if the field names differ.

## Guardrails
- Only dispatch a bot for events the operator owns/attends (don't bot every shared invite).
  Default: events where the operator is organizer or accepted. Make this configurable.
- Cost visibility: log per-meeting bot minutes so spend is auditable (operator dislikes
  silent caps and silent spend).
- One bot per meeting; dedupe by `native_meeting_id` so a re-poll doesn't double-dispatch.

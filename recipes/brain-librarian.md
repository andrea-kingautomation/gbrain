# Recipe: brain-librarian (the LLM librarian)

**Category:** scheduled (cron) + on-demand. **Owner seat:** content. **Status:** built; activates in an
OpenClaw runtime session (needs gbrain + ghost + cloudinary MCPs, which load at session start).

Goal (operator, msg 7490): a self-maintaining, beautiful, useful wiki of consolidated knowledge that
the operator can scroll/search visually in Notion, where approved pages ALSO publish as SEO-optimized
blog posts to the personal and KoA Ghost sites via Telegram-button approval, leveraging OpenClaw's
native interactive capabilities.

## Inputs / wiring (all verified live unless noted)
- Substrate: GBrain stores, BOTH realms — KoA (live Supabase brain via gbrain MCP) + personal
  (`gbrain-personal` / personal.pglite). Read via the seat's gbrain MCP bridge.
- Synthesis engine: `concept-synthesis` skill (dedup -> tier T1 Canon..T4 Riff -> synthesize -> cluster).
- Renderer: `html-anything` skill (asset-type -> template map in `integrations/notion-wiki/RENDERING.md`).
  Fallback: `integrations/notion-wiki/build-asset.mjs html()` (proven on the Principles asset).
- Private host (LIVE): write rendered HTML to `/srv/brain-assets/<uuidhex>/<slug>.html` (claude-owned).
  Served inline + noindex at `https://notebooklm.kingofautomation.com/brain/<uuidhex>/<slug>.html`
  (Caddy `handle_path /brain/*`). Unguessable + X-Robots-Tag noindex. This is the "private" tier embed.
- Published host: Ghost via `ghost__*` (KoA realm) / `ghost-personal__*` (personal realm) `posts_edit`
  (HTML source). Public URL -> SEO + building-in-public. Embed the public URL in the Notion row.
- Cover images: `cloudinary` MCP (official @cloudinary/asset-management-mcp, installed) OR signed REST.
  ONE cover per asset, reused for the Notion page cover and the Ghost feature image on publish.
- Catalog: Notion DB "Knowledge Assets" 375eaa93-c844-8114-8fa0-ceba5a907e50. Props: Name, Asset Type,
  Themes, Sources, Status, Updated, Summary, **Visibility (Private|Published)**, **Realm (KoA|Personal)**.
- Notifications/approvals topic: dedicated topic in the PERSONAL group (-1003818046085) — see Routing.

## Flow (one run)
1. **Synthesize** across both realms (concept-synthesis). Keep realms separate (tag each cluster KoA|Personal).
2. **Asset-worthiness gate** (anti-noise): a theme becomes an asset only if it has enough cross-source
   material + recurrence (>= N distinct sources AND >= M mentions; tune N/M, log what was dropped).
3. For each NEW or materially-CHANGED qualifying theme:
   a. Pick asset type (Principles/Guide/Top-N/Report/Map/Profile) -> html-anything template.
   b. Compile to self-contained HTML in the operator's voice (`personal-voice` skill).
   c. Render a cover image; upload via cloudinary -> cover URL.
   d. Host PRIVATE: write HTML to `/srv/brain-assets/<uuid>/<slug>.html` -> get the notebooklm /brain/ URL.
   e. Upsert a Notion DB row (idempotent by a stable Slug): embed-first (the /brain/ URL as the FIRST
      block, no native click-layer), page cover = cover URL, Visibility=Private, Realm=KoA|Personal.
4. **Dry-run slate (DEFAULT on first run / when --dry-run):** do NOT publish. Post the candidate slate
   (titles + 1-line summary + realm + proposed asset type) to the librarian topic with per-asset
   approve buttons. Nothing reaches the catalog/Ghost until approved.
5. **On approve-to-catalog:** create/update the Private Notion row (steps 3d-3e).
6. **On approve-to-publish (per row, Telegram button):** set Visibility=Published; Ghost `posts_edit`
   the HTML to the realm's site (KoA->ghost, Personal->ghost-personal) with the cover as feature image,
   SEO fields (title, excerpt, tags from Themes), slug; swap the Notion embed to the public Ghost URL.
   Flipping back to Private reverts the embed to the /brain/ URL and unpublishes the Ghost post.

## Telegram button approval (OpenClaw native)
Use OpenClaw's native interactive message/button capability (founder/bd/eng/content accounts have
`commands.native: true`). Each dry-run slate item and each catalog row gets inline buttons:
`[Approve to wiki] [Publish to <site>] [Skip]`. Button callbacks drive steps 5/6. No custom bot code;
this is OpenClaw-native. (Approvals are non-interactive-origin -> they post to the librarian topic, see Routing.)

## Routing (operator msg 7490 — dedicated topic for non-interactive output) — RESOLVED
Anything the librarian emits that is NOT a reply inside an interactive chat (scheduled runs, dry-run
slates, publish confirmations, error alerts) MUST go to a DEDICATED TOPIC, grouped, in the right group,
mirroring the existing reminders topic. **Topic supplied by operator (msg 7506, t.me/c/3818046085/923):**
- group: PERSONAL (-1003818046085) · `message_thread_id` = **923**
- Stored at `/home/claude/gbrain/state/librarian_topic_id.txt` (read it for every emit; never hardcode).
General convention: background/scheduled seats post status/alerts/approvals to a dedicated per-purpose
topic, never to an interactive thread.

## Schedule (operator msg 7506 #3: "let's wait for it to pick it up")
No manual trigger from a resumed CC session. The NEXT OpenClaw content session registers the recurring
cron via the gateway cron tool (validated path — do NOT hand-edit the live `~/.openclaw-personal/cron/
jobs.json`, a bad entry can break the reminders jobs) and runs the first `--dry-run`. First run = dry-run
slate. After the operator approves the initial batch, subsequent runs only surface NEW/changed assets
(idempotent by Slug + content hash). Turnkey cron spec to add (mirror the working reminder entries' shape;
schema = openclaw `CronJobSchema`):
```jsonc
{ "agentId": "content", "name": "Brain librarian (dry-run slate)", "enabled": true,
  "schedule": { "kind": "cron", "expr": "30 19 * * *", "tz": "UTC" },   // 02:30 ICT, after nightly embed
  "sessionTarget": "isolated", "wakeMode": "next-heartbeat",
  "payload": { "kind": "agentTurn",
    "message": "Run recipe gbrain/recipes/brain-librarian.md in --dry-run. Post the candidate slate with per-asset approve buttons to the librarian topic (read /home/claude/gbrain/state/librarian_topic_id.txt). Publish nothing.",
    "timeoutSeconds": 900 },
  "delivery": { "mode": "none" },   // the agentTurn posts the slate itself via its tools
  "failureAlert": { "after": 1, "mode": "announce", "channel": "telegram", "to": "telegram:-1003818046085", "accountId": "content" } }
```

## Activation checklist (next OpenClaw content session)
- [ ] gbrain + ghost + cloudinary MCPs present (cloudinary added to openclaw.json; activates this session).
- [x] Operator created the librarian topic; thread_id 923 saved to `/home/claude/gbrain/state/librarian_topic_id.txt`.
- [ ] PRE-FLIGHT: confirm the content bot (@koa_content_bot) can post into personal group -1003818046085
      topic 923. If it is not a member / cannot post there, route the emit via the `personal` account
      (as the reminder jobs do) instead of `content`, and set the cron `failureAlert.accountId` to match.
- [ ] Register the recurring cron via the gateway cron tool (spec above) — NOT by hand-editing jobs.json.
- [ ] Run once with --dry-run -> post slate to topic 923 for button approval.

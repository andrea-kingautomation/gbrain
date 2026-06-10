# Brain-organizer: hosting (Ghost) + promotion (self-learning) — verified design

Supersedes the GitHub-Pages hosting plan (operator msg 7443). Two corrections + one better idea.

## Hosting = TWO TIERS (operator msg 7447, finalized)

Ghost drafts do NOT reliably embed in a Notion iframe (operator confirmed). So we split by tier:

### Tier 1 — PUBLISHED -> Ghost (unchanged)
For assets the operator approves to publish, create a proper, fully-formatted Ghost blog post
(SEO fields, feature image, tags) and embed the public Ghost URL in the Notion page. Doubles as
building-in-public / auto-blog content. Both Ghost sites are wired into OpenClaw as MCP servers,
content seat allowed both [src: .openclaw-personal/openclaw.json]:
- `ghost`          -> KoA site (kingofautomation.com) — helper `/home/claude/infra/helpers/ghost-koa-mcp.sh`
- `ghost-personal` -> personal site (andrea-ercolessi.ghost.io) — helper `ghost-personal-mcp.sh`
Both are remote (Railway) MCP servers loaded at OpenClaw session start (NOT callable from a
resumed CC session — live publish runs in a fresh OpenClaw session). `portfolio-generator-workflow`
already publishes HTML via Ghost `posts_edit` (HTML source, never cards_add) — proven path.

### Tier 2 — PRIVATE -> render the HTML on our own host, embed THAT url (skip Ghost)
Honest constraint: Notion has NO raw-HTML block. "Embed the HTML file into Notion" still requires
the HTML to live at a URL the Notion iframe can fetch. The clean private host = our own VPS, which
we control (so we set frame-friendly headers and `X-Robots-Tag: noindex`):
- Render the asset to a self-contained HTML file (html-anything), write it to a private static
  dir, served by Caddy at an **unguessable path** (`/assets/<rand>/<slug>.html`), `noindex`.
- Embed that URL in the Notion page. It renders visually, never touches Ghost, never gets a
  public/SEO presence.
- **Privacy ceiling (honest):** any iframe-rendered page is fetched WITHOUT auth, so "private"
  here = private-by-unguessable-link, NOT login-walled. Same ceiling as the rejected Ghost-draft
  approach; the reason to switch is that a VPS file with our headers actually RENDERS where Ghost
  drafts did not. For genuinely sensitive content, keep it native-blocks-only (no embed at all).
- The same VPS route also hosts the cover thumbnail PNG (one image, reused for Notion cover and,
  if later published, the Ghost feature image — operator msg 7447).
- **Caddy is root-owned and fronts the OpenClaw web UI + notebooklm + dashboards** [src: /etc/caddy/Caddyfile].
  Adding the static route is a shared-infra change -> gated on operator go + a System Changes
  (topic 60) note; do NOT blind-edit. Proposed block: a `handle_path /assets/*` on an existing
  host with `root * /srv/brain-assets`, `file_server`, `header X-Robots-Tag noindex`.

### Realm split
KoA-realm assets -> KoA site (on publish). Personal-realm -> personal site. Notion DB carries a
`Realm` select (KoA | Personal) so the two are separated in views. LIVE on DB now.

### Publish control
A `Visibility` select on each Notion row (Private | Published). LIVE on DB now. Private rows use
the Tier-2 VPS embed; flipping to Published triggers the Tier-1 Ghost publish + swaps the embed
URL to the Ghost URL. (Notion buttons can't call APIs; the property + a reflex is the "inline button.")

## Notion page mechanics (operator-specified)
- **Embed-first, no click-layer:** the asset page leads with the Ghost embed block as the FIRST
  and primary content. Drop the verbose native blocks (callouts/headings/toggles); keep at most a
  one-line caption + a provenance line. The HTML IS the page.
- **Iframe max-size:** Notion's API creates the embed (`{embed:{url}}`) but does NOT expose
  width/height or page full-width — those are one-time UI drags. Design Ghost pages to render well
  at Notion's default and full-width; the max-size drag is manual (operator already did it once).
- **Gallery visual preview:** gallery cards cannot render an iframe. To show a visual thumbnail,
  set each row's **page cover** to a rendered screenshot of the HTML, hosted on Cloudinary (key
  "cloudinary" in 1P "api keys"). A Gallery view with card-preview = Page cover then shows visual
  previews. View creation is manual (API can't make views); we set covers so it looks right.
- Surface the DB directly (favorite / top-level) to cut the click to reach it.

## Promotion = the existing self-learning loop (NOT a new file)
Operator confirmed (msg 7447): this IS Branch A (STATIC) work. The only difference from a normal
Branch A capture is the SURFACING source: not the operator's interactive correction in the moment,
but gbrain's background intelligence noticing the recurring pattern across conversations. Same loop,
same destinations, same operator-approval gate. We plug the brain-organizer's output into the
existing capture -> apply -> weekly-reflection loop (`koa-branch-classifier`, `koa-weekly-reflection`),
not a parallel mechanism. [src: architecture/self-learning-architecture.md]

### CORRECTED promotion targets (verified live Chakra OS layout, msg 7447)
`base-agent-instructions.md` is DEPRECATED (2026-05-28) [src: architecture/PENDING-CHANGES.md:36].
Universal shared knowledge now lives in the generator template that `agents-build.mjs` injects into
EVERY seat's AGENTS.md [src: architecture/AGENTS-TEMPLATE.md frontmatter].

| Concept kind | Destination (verified) |
|---|---|
| Universal behavioral principle (every seat) | `architecture/AGENTS-TEMPLATE.md` shared block -> propagated to all seats by `infra/openclaw/scripts/agents-build.mjs` (one-liner) |
| Architecture truth / system doctrine | `architecture/CHAKRA-OS.md` |
| Seat behavioral rule | `infra/openclaw/agent-config/<seat>/AGENTS.md` |
| Identity / personal value | `agent-config/<seat>/IDENTITY.md` |
| Voice / tone | `personal-voice` skill (canonical) + `agent-config/<seat>/SOUL.md` for seat tone |
| Reference / on-demand fact | GBrain L6 Principles (queryable) + optional `agent-config/<seat>/MEMORY.md` pointer |

Every-turn files (AGENTS-TEMPLATE.md) get one-liners only (token budget). gbrain proposes the exact
file + line; operator approves in the weekly review; then promote. Append-only with supersede chain.

NOTE (drift to fix, NOT this turn — shared infra, needs eng + System Changes note):
`self-learning-architecture.md` still names Branch A destinations as "a skill, brain.md, or role.md"
— `brain.md`/`role.md` are stale CC-era terms. The live targets are the table above.

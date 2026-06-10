# Asset rendering: html-anything wiring

The brain-organizer renders each consolidated asset as a self-contained HTML page
using the **html-anything** skill (`/home/claude/agent-chakra/skills/html-anything/SKILL.md`,
upstream github.com/nexu-io/html-anything). 97 templates, zero API key. Each template is a
design spec (layout + Tailwind classes + data mapping) fetched at:

    https://raw.githubusercontent.com/nexu-io/html-anything/main/next/src/lib/templates/skills/<template>/SKILL.md

## Compiler rule

The compile step (an LLM pass) picks the template by asset type, follows that template's
layout + design spec, and emits ONE self-contained HTML file (Tailwind via CDN or inlined so
it renders offline and inside a Notion embed iframe).

| Asset type | html-anything template | Notes |
|---|---|---|
| Principles / Values | `web-proto-editorial` or `article-magazine` | editorial, serif headings, pull-quotes |
| Guide (travel, how-to) | `article-magazine` | + generated hero image (image-generation-master) + static map (maps tools) |
| Top-N (e.g. top archaeological sites) | `article-magazine` + card grid | ranked cards, one image per item |
| Report / data | `data-report` | charts + tables |
| Map / system overview | `deck-blueprint` or `deck-graphify-dark` | layered diagram aesthetic |
| Profile | `resume-modern` or editorial | |

## Notes
- Travel/wildlife/archaeology guides are where html-anything earns its keep: real visuals, not
  just text. Wire image-generation-master for hero art and the google-maps static-map tool for
  location context.
- The current hand-rolled principles template (build-asset.mjs `html()`) stays as a fallback;
  migrate it to the `web-proto-editorial` spec when the compiler lands.
- Output must be self-contained (no external build step) so it renders in a Notion embed iframe
  and as an offline screenshot.

## Hosting (see GOLIVE doc)
Notion has no raw-HTML block; the only way the HTML itself becomes the in-Notion surface is an
`embed` block pointing at a hosted URL. That URL is public-by-URL (iframes cannot carry auth),
regardless of repo privacy. Plan: agent-chakra (private) stores source under `assets/brain/`;
a dedicated PUBLIC assets repo serves the rendered HTML via GitHub Pages with an unguessable
path + noindex/robots. Low-sensitivity assets only; sensitive ones stay native-blocks-only.

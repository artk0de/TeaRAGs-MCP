# Plugin icons

Per-plugin icon sources (`<plugin>.png`, 512×512 RGBA, transparent background)
derived from `public/logo.png`. Shipped by the harness generators
(`scripts/gen-harness-*.ts` copy them as `harness/<harness>/<plugin>/icon.png`
via `copyIconAssets`) wherever the target manifest can show one:

| Harness     | Field  | Where                                                                                                                               |
| ----------- | ------ | ----------------------------------------------------------------------------------------------------------------------------------- |
| ZCode       | `icon` | `harness/zcode/marketplace.json` entry → `./<plugin>/icon.png` (local directory marketplace; the official CDN points at HTTPS URLs) |
| Codex       | `logo` | `<plugin>/.codex-plugin/plugin.json` → `./icon.png` (same form as OpenAI's bundled plugins)                                         |
| Cursor      | `logo` | `<plugin>/.cursor-plugin/plugin.json` → `icon.png` (relative path per the plugin reference)                                         |
| Claude Code | —      | marketplace/plugin schema has no icon field; the Claude packages ship none                                                          |

## Derivation

- **tea-rags** — the logo itself, content-cropped and re-centred:
  `magick public/logo.png -crop 660x790+190+40 +repage -resize x500 -gravity center -background none -extent 512x512`
- **tea-rags-setup** — tea-rags plus an install badge (cream separation ring,
  dark disc, gold ring, white down-arrow-into-tray) centred at (385, 358) on the
  badge circle's lower-right edge, above the wordmark; drawn as
  `install-badge.svg` and composited:
  `rsvg-convert -w 512 -h 512 install-badge.svg | magick composite tea-rags.png - PNG32:tea-rags-setup.png`
- **dinopowers** — the logo's circular badge (crop `399x454+58+18` of the
  tea-rags icon, scaled to 299×340 at (22, 30)) plus a drawn flexed right arm
  (black sleeve, gold cuff, cream fist, gold pump-sparkles) and a claw paw
  gripping a 165px copy of the full tea-rags icon at (18, 330); the arm and paw
  are vector overlays in `dinopowers.svg` around the two embedded rasters,
  rendered at 1024 and downsampled:
  `rsvg-convert -w 1024 -h 1024 dinopowers.svg | magick - -resize 512x512 PNG32:dinopowers.png`

Palette sampled from the logo: badge cream `#FEFAD8`, skin `#F9EA9A`, gold
`#CC991C`, coat/hat dark `#26221B`–`#675B47`.

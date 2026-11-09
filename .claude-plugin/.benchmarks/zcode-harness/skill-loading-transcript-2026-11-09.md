# Skill-loading arm transcript — 2026-11-09 (bd tea-rags-mcp-21k3y)

**Fingerprint:** repo HEAD `5ba0ac24a` + uncommitted
`scripts/harness/transform.ts` (+38/−2: `renderFrontmatter` emits `>-` block
scalars), regenerated `harness/zcode` (117 files) + codex/cursor/.claude-plugin
trees. Installed cache: `tea-rags@tea-rags` 0.55.9, `dinopowers@tea-rags` 0.25.2
via `zcode.cjs plugins install` from marketplace `tea-rags`
(`~/.npm-global/lib/node_modules/tea-rags/harness/zcode` → repo symlink).
**Model:** N/A — deterministic loader probe (`zcode.cjs skills list`, the same
frontmatter reader that builds the model's skill list). **Actor session:** ZCode
0.17.0, GLM-5.3.

## Root cause (observed before fix)

`renderFrontmatter` emitted flat `description: "long text"`; `formatPackage`
runs Prettier (`proseWrap: always`, printWidth 80) over every shipped `.md`,
which reflows long values to `description:` + indented quoted continuation
lines. ZCode's frontmatter reader takes flat `key: value` lines and `>`/`|`
blocks only (zcode-guide diagnosing-skills §2) → description reads as missing →
the skill is dropped. Observed live:
`Skill not found: dinopowers:systematic-debugging`; session list had **0**
`tea-rags:*`/`dinopowers:*` entries while hooks of the same plugins ran fine.
superpowers (short flat descriptions, under the wrap width) loaded — the natural
control.

## Transcript

| Case        | Command                                                                           | Before fix                                                                       | After fix  |
| ----------- | --------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- | ---------- |
| SL1         | `zcode.cjs skills list \| grep -c '^- tea-rags:'`                                 | 0                                                                                | **17**     |
| SL2         | `zcode.cjs skills list \| grep -c '^- dinopowers:'`                               | 0 (invoke → `Skill not found`)                                                   | **10**     |
| SL3 control | `zcode.cjs skills list \| grep -c '^- superpowers:'`                              | 15                                                                               | **15**     |
| total       | `zcode.cjs skills list \| grep -c '^- '`                                          | 34                                                                               | **61**     |
| SL4         | `vitest run tests/scripts/gen-harness-zcode.test.ts -t "flat frontmatter reader"` | 1 failed (`dino-brainstorming: "description:" — value must sit on the key line`) | **passed** |

Before-fix totals were observed in the live session at 19:0x after
`Skill not found`; the loader counted only 34 skills with the broken cache.
After `plugins install` re-copied the regenerated tree, the same command returns
61 — 17+10 newly loaded, superpowers and official plugins unchanged (34+27=61).

## Verdicts

- **SL1–SL4: PASS (4/4), control held.** Failed attempt retained above (RED run
  of SL4 against the pre-fix generator output; loader counts 0/27 pre-fix).
- Limitations: a running session's skill list is snapshotted at start — the
  wrapper skills become invocable in **new** ZCode sessions only; model-side
  _triggering_ of the wrappers is not re-measured here (covered by the
  dinopowers-\* suites once restarted). `plugins update` is version-driven, so
  byte changes without a version bump need `plugins install` (or a release bump)
  to reach an installed cache.

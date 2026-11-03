# Verification and review limits

RISK renderCodexHarness unassessed (ignored/nonProduction source) → defensive call: real generated-package/native evals and62 generator checks.
RISK optional body template documentation not codegraph-judged → pinned by isolated source fingerprints, selected behavior and body-budget gate.
N-TH-WAY find_similar(positiveCode = generated override logic): only generator/frontmatter tests; no alternative production implementation found.
PINS original61 generator tests green before changes; new body-size test RED then62 green. Targeted body-budget pins green after corrections.
PARTNER tests/scripts/gen-harness-codex.test.ts — edited: package entrypoint budget and retained references.
PARTNER harness/codex/tea-rags/hooks/hooks.json — not touched because the14 registered handlers are byte-identical to base.
PARTNER tests/hooks/search-drift.test.sh — not touched because search-drift execution and its generated copies do not change.
PARTNER scripts/gen-harness-cursor.ts — not touched: optional body lookup exists only in renderCodexHarness.
PARTNER scripts/harness/transform.ts — not touched: existing parseFrontmatter/toHarnessText/toCodexSkill metadata contracts reused unchanged.
PARTNER harness/codex/tea-rags/scripts/codex-rules.txt — not touched: startup policy bytes are unchanged.
PARTNER harness/codex/tea-rags/scripts/turn-routing.txt — not touched: per-turn policy bytes are unchanged.
PARTNER plugins/tea-rags/scripts/search-drift.sh — not touched: exact base parity.
PARTNER .claude-plugin/tea-rags/scripts/search-drift.sh — not touched: exact base parity.
PARTNER harness/codex/tea-rags/scripts/search-drift.sh — not touched: exact base parity.
PARTNER harness/cursor/tea-rags/scripts/search-drift.sh — not touched: exact base parity.
PARTNER plugins/tea-rags/skills/explore/SKILL.md — not touched: canonical metadata/body preserved; optional Codex body supplies the harness-specific workflow.
PARTNER .claude-plugin/tea-rags/skills/explore/SKILL.md — not touched: canonical Claude body/description exact base parity.
PARTNER harness/cursor/tea-rags/skills/explore/SKILL.md — not touched: Cursor body/description exact base parity.
PARTNER harness/codex/tea-rags/skills/explore/references/usage-pattern.md — not touched: explicit usage/impact still routes there.
PARTNER plugins/tea-rags/skills/explore/references/usage-pattern.md — not touched: no common usage API changes.
PARTNER harness/codex/tea-rags/skills/explore/references/explain-pattern.md — not touched: explicit ownership/history retains that route.
PARTNER harness/codex/tea-rags/skills/explore/references/architecture-pattern.md — not touched: requested centrality still uses it, verified in C01 with earlier policy fingerprint.
PARTNER harness/codex/tea-rags/skills/filter-building/SKILL.md — not touched: no filter schema or preset change.
PARTNER plugin manifests — version0.55.6 follows versioning; generated companions updated.
GATE review_changes: introduced=0, partial=false

All five sections were built without truncation; explicit notJudged rows cover
documentation/manifest and nonproduction code. This is not a repository-wide
structural safety claim. No imports/public signatures/backend resource APIs or
hook executables were changed. Tests are affected-scope only as requested.
Source/header edits after the review are an exact restoration of the tested H2
body; its emitted SHA256 equals the frozen native H2 package. Review is repeated
before commit if any source logic changes. Raw journals stay private; exported
transcripts contain public tool actions, source hashes, finals and numeric usage.

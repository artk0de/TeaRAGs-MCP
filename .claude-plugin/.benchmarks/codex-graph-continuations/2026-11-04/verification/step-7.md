RISK code_md UNVERIFIABLE in codegraph (generated Bash with embedded Python;
generator classified nonProduction) → defensive AST parse plus conservative
fallback; pinned by the runtime regression test and native H03/H04. No
graph-wide safety claim. Targeted checks follow the user's standing instruction
to avoid full suites for small changes.

N-TH-WAY find_similar(positiveCode = generated code): returned frozen benchmark
MCP guard copies, outside the runtime plugin boundary; no new duplicate module
or cross-boundary import. Reuse existing code_md, MD_LITERAL, GLOB and Python
ast; no dependency added.

PINS tests-at-risk + 6a pins: relevant generator baseline 62/62 green; runtime
regression RED expected 0, observed 2; unchanged reproduction/control assertions
GREEN 63/63. End-to-end native H01 remains OPEN_ENVIRONMENT; H02 remains
OPEN_FIXTURE_ERROR. Native classifier cases H03/H04 pass under the corrected
plugin.

REPORT-ONLY cohesion tests/scripts/gen-harness-codex.test.ts — reported clusters
contain pre-existing tests, not the added read/write regression. Per
repair/splitCandidates.md, do not split pre-existing clusters in this fix. Bead
suggestion: separate existing Codex generator test concerns after confirming a
real maintenance problem.

PARTNER tests/hooks/search-drift.test.sh — not touched because the one-file hook
and search-drift are separate PreToolUse handlers; existing registration test
pins their order and matcher, unchanged by this diff. PARTNER
harness/codex/tea-rags/hooks/hooks.json — not touched because renderCodexHarness
still registers the same handler path; runtime script content changes without a
registration contract change. Registration is pinned by the existing generator
test. PARTNER scripts/gen-harness-cursor.ts — not touched because this constant
generates only the Codex hook; Cursor generator is byte-identical to HEAD.
PARTNER harness/codex/tea-rags/scripts/codex-rules.txt — not touched because
scheduling/routing instructions are restored to H2; byte-identical to HEAD.
PARTNER scripts/harness/transform.ts — not touched because no skill
transformation contract changes; byte-identical to HEAD. PARTNER
.claude-plugin/tea-rags/scripts/search-drift.sh — not touched; distinct handler
and byte-identical. PARTNER harness/codex/tea-rags/scripts/search-drift.sh — not
touched; distinct handler and byte-identical. PARTNER
harness/cursor/tea-rags/scripts/search-drift.sh — not touched; distinct handler
and byte-identical. PARTNER plugins/tea-rags/scripts/search-drift.sh — not
touched; distinct handler and byte-identical. PARTNER
harness/codex/tea-rags/scripts/turn-routing.txt — not touched; no routing/prompt
change in the accepted policy, byte-identical. PARTNER
src/mcp/resources/generated/agent-context.ts — not touched; backend injection
byte-identical, no MCP implementation change. PARTNER
plugins/tea-rags/rules/core.md — not touched; shared core byte-identical.
PARTNER harness/cursor/tea-rags/rules/tea-rags-core.mdc — not touched; Cursor
core byte-identical. PARTNER harness/codex/tea-rags/skills/explore/SKILL.md —
not touched; rejected H4/H5 changes removed, H2 body byte-identical. PARTNER
plugins/tea-rags/.claude-plugin/plugin.json — version manifest: known noise per
repair/silentCoupling.md; release version only. PARTNER
.claude-plugin/tea-rags/.claude-plugin/plugin.json — version manifest: same
release version. PARTNER harness/codex/tea-rags/.codex-plugin/plugin.json —
version manifest: same release version. PARTNER
harness/cursor/tea-rags/.cursor-plugin/plugin.json — version manifest: same
release version; no Cursor behavior change.

GATE review_changes: introduced=0, partial=true — initial seven-file review
truncated historical co-change partners. Version-manifest history is
detector-documented release noise. RE-REVIEW same five sections in individual
generator/test/generated-hook batches: all built, no truncation, introduced=0.
Non-production/unsupported-language files explicitly remain notJudged; this is
not a global architecture-clean claim. GATE review_changes: introduced=0,
partial=false (changed executable files, with the stated detector limitations).

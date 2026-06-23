# Benchmark — analytics-rerank + filter-building codegraph catalog (b65a TR7/TR8)

Doc-only reference updates: surface the codegraph composite presets and codegraph
filter keys in the two catalogue skills.

## Why no behavioral eval

`analytics-rerank` and `filter-building` are **reference catalogues consulted on
demand**, not intent-routing skills. There is no per-intent tool selection to
measure with a with/without subagent eval — the value is catalogue completeness
and correctness. Verification here is doc consistency + lint, not a tool-
selection benchmark. (The behavioral codegraph-presence finding was already
measured 3× this session for the routing skills.)

## Changes

| Skill | Epic | Change |
| --- | --- | --- |
| analytics-rerank | TR7 | Preset cheat sheet: added `blastRadius` (codegraph on / custom-weights off), `architecturalHub`, `entryPoint` rows + a codegraph-composite gating note. Impact-analysis recipe: prefer `blastRadius` (real fanIn) when codegraph on, custom weights as the approximate off-fallback. |
| filter-building | TR8 | Raw-filter section: added "Codegraph filters" examples (`codegraph.file.isHub`, `fanIn` range, `instability` range), gated on `codegraph.symbols` in prime; noted fanIn/isHub are the edge-truth replacements for the imports proxy. |

Plugin bump: covered by tea-rags 0.27.0 (same worktree release).

## Verification

- markdownlint: no new structural issues (jsonc fences tagged; remaining MD040
  flags are pre-existing bare fences in untouched sections).
- All codegraph entries carry the prime `codegraph.symbols` gate + off fallback,
  consistent with the search-cascade canon and signal-interpretation expansion.

This completes the non-blocked b65a work. Remaining: TR5/TR6 + gated D5 presets
blocked on C-AST `tea-rags-mcp-wtkz` (OPEN).

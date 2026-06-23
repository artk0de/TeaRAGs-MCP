# Benchmark — data-driven-generation codegraph impact (b65a TR4)

Replace Step 6 IMPACT's custom weights `{imports:0.5, churn:0.3, ownership:0.2}`
with the `blastRadius` preset (real `fanIn`) when codegraph is on; keep the
custom weights as the codegraph-OFF fallback.

## Summary

| Metric | Value |
| --- | --- |
| Eval cases | 4 (ON blastRadius, OFF fallback, control, edge leaf) |
| with-rule FIXED | 4/4 |
| Baseline | not re-measured per-skill — see note |

**Baseline note.** This is a localized one-step preset swap. The agent-behavior
baseline for codegraph presence was already characterized by 3 prior measured
runs this session (codegraph-presence-fallback 12/13 vs 13/13; risk-assessment
~5/8 vs ~7.5/8 vs 8/8). The consistent finding — an Opus-class model improvises
codegraph use when tools are present, so raw delta is modest; the value is
PRESCRIPTION (consistent preset choice over ad-hoc weights), grounding, and the
codegraph-OFF fallback guard — applies directly. A full two-arm baseline was
skipped here as disproportionate; the fixed-skill verify confirms correct
prescription.

## Change

`data-driven-generation/SKILL.md` Step 6 IMPACT:
- codegraph on → `rerank="blastRadius"` (real fanIn + churn + bugFix), warn on
  high-fanIn/isHub dependents.
- codegraph off → fall back to `{imports:0.5, churn:0.3, ownership:0.2}`, flagged
  approximate (import-proxy, not edge truth). Refs search-cascade Graph
  navigation + signal-interpretation codegraph signals.

Plugin bump: covered by tea-rags 0.27.0 (same uncommitted worktree release).

## Per-case verdicts (fixed)

| Case | ENV | verdict |
| --- | --- | --- |
| 1 impact-on-blastradius | B | PASS — blastRadius preset, edge truth |
| 2 impact-off-fallback | A | PASS — custom weights, flagged approximate |
| 3 control-impact-purpose | B | PASS — blastRadius + shared taskIds preserved |
| 4 edge-leaf-low-blast | B | PASS — low/isolated fanIn, honest |

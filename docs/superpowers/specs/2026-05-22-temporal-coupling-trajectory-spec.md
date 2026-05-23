# Temporal Coupling Trajectory — Spec (Planning Placeholder)

**Status:** Planning placeholder. Detailed sections drafted after codegraph
Slice 2 closes. **Date:** 2026-05-22 (planned) **Owner:** tea-rags **Parent
epic:** TBD — separate from codegraph (`tea-rags-mcp-l26`) and static
complexity.

## Why a separate trajectory

Temporal coupling (co-change) is a **process-derived graph signal**: which files
tend to change in the same commit, ranked by frequency and recency. Per
Co-Change Graph Entropy (arxiv 2504.18511, April 2025), co-change predicts
defects better than structural fan-in in 82.5% of projects studied.

This is **architecturally different** from:

- **Codegraph** (call/import graph, parsed AST) — structural, language-aware,
  extracted at index time from source code.
- **Git trajectory** (per-file churn / blame / ageDays) — per-file process
  metrics, no cross-file relationships.
- **Static complexity** (cyclomatic / cognitive AST visitors) — control-flow
  inside a chunk.

Temporal coupling produces a **process-derived graph** between files — edges
weighted by co-change frequency. It needs:

- Its own DuckDB table (or Qdrant payload structure) for the
  `(file_a, file_b, co_change_count, last_co_change)` graph.
- Its own enrichment provider that consumes git log + maps to file pairs.
- Its own derived signals (`temporalCoupling` strength per file).
- Optional own MCP tool (`get_temporal_neighbors(file)`).

Folding this into codegraph would distort codegraph's "AST-derived graph"
identity. Folding into git trajectory would distort git's "per-file process
metrics" identity. So it gets its own trajectory.

## Open scope questions (to resolve before drafting full spec)

1. **Storage**: reuse the DuckDB graph database (codegraph-owned) or stand up a
   separate one? Sharing reduces operational surface; separating isolates schema
   evolution. Probably share with a `cg_temporal_couples` table.

2. **Cap on stored pairs**: a 1k-file project with full co-change history
   produces millions of pairs. Cap to top-N partners per file? Or filter by
   co_change_count threshold?

3. **Window**: co-change over the entire git history vs windowed (last 6 months,
   configurable)? Per CodeScene Temporal Coupling docs, windowing matters — old
   co-change is noise.

4. **Squash-awareness**: same as git trajectory (squashOpts) — bundle commits
   within session-gap minutes before measuring co-change?

5. **Cross-language**: temporal coupling is language-agnostic; should be
   computed for every file regardless of extraction-hook coverage.

6. **Composite preset**: `temporalCoupling` preset (Tier 2 per research) ships
   with this trajectory. Weights composite: `similarity` 0.25,
   `temporalCoupling` 0.4, `churn` 0.2, `bugFix` 0.15.

## Tentative phases (refine on full draft)

- Phase 1: `cg_temporal_couples` table + git-log → pair extractor
- Phase 2: TemporalTrajectory + EnrichmentProvider + payload signal
  (`temporal.file.couplingStrength` aggregated as max / sum / top-K)
- Phase 3: `temporalCoupling` preset + `get_temporal_neighbors` MCP tool
- Phase 4: Composite update to `dangerous` / `changeRisk` / `safeToRefactor`
  presets — incorporate `temporalCoupling` weight when this trajectory is
  enabled

## Knowledge-base docs (when this lands)

- `signals/temporal-coupling.md` — NEW article with Co-Change Graph Entropy
  citation
- `presets/temporal-coupling.md` — explain the Tier 2 preset
- Updates to `dangerous.md`, `change-risk.md`, `safe-to-refactor.md`

## Research sources

- _Co-Change Graph Entropy: A New Process Metric for Defect Prediction_ — arxiv
  2504.18511, April 2025
- _CodeScene Temporal Coupling Documentation v3.2.9_

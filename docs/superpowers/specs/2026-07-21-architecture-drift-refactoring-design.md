# Architecture Drift Refactoring — Design

Date: 2026-07-21 · Epic: `tea-rags-mcp-4ozbi` · Source:
`tea-rags:risk-assessment` scan 2026-07-20 (8 preset scans × bugHunt / hotspots
/ techDebt / dangerous + structural axis: `find_cycles`, `decomposition`,
`architecturalHub`).

Scan verdict: zero Critical/High churn-convergence zones — drift is
STRUCTURAL, not churn-driven. Four groups, one child epic each, one
implementation plan per group. All groups governed by
`.claude/rules/test-invariants.md` (added together with this spec): tests
change only when a business invariant changes; behavior-preserving refactors
leave `tests/**` semantically untouched.

## Group 1 — SSoT: payload-path readers (`tea-rags-mcp-3f21g`)

**Problem.** `contracts/signal-utils.ts:104` `resolvePayloadValue` is
documented as "the single source of truth for payload addressing" and handles
all three shapes (flat dotted key → codegraph nested-symbols → plain nested
traversal). Three independent re-implementations bypass it:

- `domains/trajectory/git/stats/utils.ts#readPayloadPath` — own traversal
- `domains/trajectory/codegraph/symbols/rerank/derived-signals/helpers.ts` —
  own readers with INVERTED resolution order (nested-first); file bugFixRate
  100%, fanIn 10 (hub)
- `domains/ingest/infra/stats-recompute.ts:258` — local mirror ("kept local to
  avoid …")

**Decision: full consolidation.** All three become thin delegates of
`resolvePayloadValue`:

- `git/stats/utils.ts#readPayloadPath` body → `return
  resolvePayloadValue(payload, path)`.
- codegraph `helpers.ts`: public signatures `codegraphFileNum` /
  `codegraphFileBool` / `codegraphChunkNum` are KEPT (information hiding — 10
  consumers untouched); bodies delegate to the canonical resolver with suffix
  prefixing plus num/bool coercion; private `getSymbols` / `readNested` are
  deleted. Resolution order thereby unifies to canonical flat-first.
- `stats-recompute.ts` mirror → direct import from contracts (legal from any
  layer); the plan verifies and removes the "kept local" reason.

**Acceptance.** Full suite green; `git diff --stat -- tests/` empty;
behavioral no-op in production (real payloads never carry conflicting dual
shapes).

## Group 2 — Decompose CodegraphEnrichmentProvider (`tea-rags-mcp-6vfrj`)

**Problem.** `domains/trajectory/codegraph/symbols/provider.ts` ~2700 LOC, 68
commits/12d, changeDensity 41.87 (intense), 27 imports. One class owns
extraction sink, resolution orchestration, SCC/PageRank scheduling, run-state
bookkeeping. `resolveExtraction` 267 LOC, `asExtractionSink` 256 LOC (chunk
fanOut 18) — decomposition threshold is ≤87 LOC.

**Decision: collaborator-split modeled on the EnrichmentCoordinator split
(epic ywz0).** New collaborators next to the provider in `codegraph/symbols/`:

| Collaborator          | Absorbs                                              |
| --------------------- | ---------------------------------------------------- |
| `extraction-sink.ts`  | `asExtractionSink` + `bufferNodeDefs` /              |
|                       | `flushNodeRemainder` + `ensureRunSink`               |
| `resolution-runner.ts`| `resolveExtraction` orchestration                    |
| `graph-finalizer.ts`  | SCC / PageRank scheduling + finalize                 |
| `run-state.ts`        | `recordRunStats` / `clearRunState` lifecycle         |

Provider remains a thin `EnrichmentProvider` facade wiring collaborators in
its constructor. Relocation-migration order: relocate code → suite green →
redistribute tests LAST. `walkCommits` (312 LOC,
`trajectory/git/infra/walk-commits.ts:242`) is a separate mechanical
phase-slicing task inside this epic — no design decision required.

**Sequencing gate.** Starts strictly AFTER `worktree-cg-node-remainder-flush`
merges (its `endExtractionRun` seam lands first and aids the split).
`worktree-enrichment-recovery-pagination` already merged to main (`02ef3032`).

## Group 3 — Break metrics ↔ extractors cycle (`tea-rags-mcp-udhyf`)

**Problem.** The only cycle in the project import graph:
`trajectory/git/infra/metrics.ts` ↔ `metrics/extractors.ts`. Cause:
`isBugFixCommitOrBranch` lives in the parent while extractors needs it.

**Decision.** Move `isBugFixCommitOrBranch` (plus any co-used pure helpers)
from `metrics.ts` to `metrics/utils.ts` (leaf; extractors already imports it).
`metrics.ts` keeps a re-export for import stability — the cycle still breaks
because extractors takes the predicate from utils directly.

`debug-logger.ts` (fanIn 20, transitiveImpact 61, healthy churn) is NOT
touched: recorded as a deliberate infra hub in the epic watch-note with an
escalation criterion (concerning bugFixRate appears, or fanIn keeps growing).

**Acceptance.** `find_cycles scope=file` returns empty (DAG).

## Group 4 — Stabilize fragile hubs (`tea-rags-mcp-15h1s`)

**Problem.** Hubs with concerning bugFixRate:
`ingest/pipeline/enrichment/applier.ts` (`applyFileSignals` 133 LOC, bugFix
56%, fanIn 12), `infra/collection-name.ts` (50%, fanIn 11, transitiveImpact
57), `adapters/duckdb/pool.ts` (46%, fanIn 10), `adapters/qdrant/errors.ts`
(44%, fanIn 12).

**Decision: invariant tests first, then targeted extraction.**

- Phase 1 — behavioral tests pinning observable invariants, aimed at the
  bugFix-concentrated chunks: `applyFileSignals` (batching, missed-file
  tracking, per-provider key layout), `resolveCollectionName`
  (alias/path/collection precedence), duckdb pool (lease / refcount /
  build-fingerprint), qdrant errors (raw → typed mapping).
- Phase 2 — extraction ONLY where a method stays oversized after Phase 1
  (`applyFileSignals` 133 LOC > 87 threshold). No boundary redesign.

**Acceptance.** Coverage strictly up (thresholds never lowered); the
bugFix-concentrated chunks are covered by invariant tests.

## Execution order & forecast

`G3 (task, ~1–2 commits)` → `G1 (sub-epic, ~3–6)` → `G4 (sub-epic, ~5–10)` →
`G2 (epic-lite, ~10–20, waits for the merge gate)`. One plan and one worktree
per group.

Forecast (anchor: ywz0 coordinator split; substrate-exists discount applied):
P25 ≈ 4 burst days, P50 ≈ 6, P75 ≈ 8; calendar at 2.5–3.5 burst days/week with
parallel epics ≈ 1.5–2.5 weeks (P50 ≈ 2).

## Cross-cutting constraints

- `.claude/rules/test-invariants.md` governs every group: refactor-breaking
  tests are either wrong code or bad tests (implementation-asserting) — the
  latter are rewritten to assert invariants, justified per commit.
- Conventional commits: `refactor(<scope>)` for moves, `test(<scope>)` for
  Phase-1 hub tests; no BREAKING CHANGE footers expected (no user-facing
  behavior changes).
- Each plan syncs 1:1 into beads tasks under its group epic
  (plan-beads-sync).

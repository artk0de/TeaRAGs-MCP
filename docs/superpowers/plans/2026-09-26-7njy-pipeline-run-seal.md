# 7njy — one run-seal skeleton for IndexPipeline and ReindexPipeline

Bead: `tea-rags-mcp-7njy`. Supersedes the finalize half of
`2026-03-29-reindexing-decomposition.md`; that plan's `completePipeline()` wrote
the marker before `finalizeAlias`, which the alias-before-marker invariant in
`src/core/domains/ingest/operations/CLAUDE.md` forbids. Approved shape: Option A
(composition), behaviour-preserving.

## Scope

- Behaviour-preserving. Existing test expectations stay unchanged; `tests/`
  gains only the new seam's tests.
- Heartbeat and optimizer-resume order stay as they are in each pipeline. The
  divergence is tracked separately as `tea-rags-mcp-3vzch`.

## Affected files (tea-rags impact, rerank `blastRadius`)

| File                                                              | Churn | Age | transitiveImpact | Owner (blame)          |
| ----------------------------------------------------------------- | ----- | --- | ---------------- | ---------------------- |
| `src/core/domains/ingest/pipeline/base.ts`                        | —     | —   | —                | —                      |
| `src/core/domains/ingest/operations/indexing.ts`                  | 44    | 9d  | 20 (local)       | Arthur Korochansky 49% |
| `src/core/domains/ingest/operations/reindexing.ts`                | 52    | 1d  | 20 (local)       | Arthur Korochansky 56% |
| `src/core/domains/ingest/operations/reindex-parallel-executor.ts` | new   | —   | —                | —                      |

None is deep-silo (`.claude/rules/silo-pairing.md`). Reach is local, so the
existing facade-level suites are the regression net.

## Task 1 — `sealRun` / `completePipeline` seam in `BaseIndexingPipeline` (TDD)

- New `IndexingRunSealSpec`: `targetCollection` (marker), `collectionAlias` +
  `absolutePath` (registry), optional `modelInfo`, optional `promote()`,
  required `persist()`.
- `sealRun(spec)`: `promote?()` → `storeIndexingMarker(target, true, modelInfo)`
  → `persist()` → `recordRegistryEntry(alias, absolutePath)`. A throw from any
  step stops the sequence (no marker after a failed promote).
- `completePipeline(ctx, chunkMap, spec, onFlushed?)`: `finalizeProcessing` →
  `onFlushed?.()` → `sealRun(spec)` → read the enrichment status getter.
- RED first: `tests/core/domains/ingest/pipeline/base-run-seal.test.ts` drives a
  minimal test subclass and pins the order, the promote-failure stop, and that
  the status is read after the seal.

## Task 2 — IndexPipeline uses `completePipeline`

`promote = finalizeAlias`, `persist = saveSnapshot` (error still swallowed into
`stats.errors`), `onFlushed` = `logPipelineCompletion` + the final embedding
progress push. Still inside `HeartbeatGuard` + `OptimizerLifecycle`.

## Task 3 — ReindexPipeline uses `sealRun` / `completePipeline`

`closeRun` becomes `reindexSealSpec(ctx, { snapshot, retainPrevious })`, a spec
with no `promote` and `persist = updateSnapshot? + deleteCheckpoint`. The two
early returns call `sealRun`, `finalizeReindex` calls `completePipeline`.

## Task 4 — `executeReindexPipelines` free function (operations/)

Moves Phase A bucketing, Phase B two-level delete+add / modified execution,
Phase C assessment and the optimizer pause/resume window out of the class. The
class keeps `initProcessing`, handoff seeding and quarantine-store wiring (they
need the base), then calls the executor. Log lines and their order are
unchanged. New unit test pins the two-level ordering (modified starts only after
delete settles) and the partial counters.

## Verification

`npx vitest run --maxWorkers=2 tests/core/domains/ingest`, `npx tsc --noEmit`,
`git diff --stat -- tests/` shows only the two new files. Live after merge: one
incremental reindex and one `--force` reindex.

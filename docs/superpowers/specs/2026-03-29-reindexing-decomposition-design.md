# Reindexing Decomposition Design

**Date:** 2026-03-29 **Status:** Draft **Scope:** Decompose `ReindexPipeline`
and unify shared steps with `IndexPipeline`

## Problem

`ReindexPipeline` (393 LOC, 13 methods) is a bug magnet: bugFixRate 50%
(concerning), 3/3 risk assessment presets flagged it as Critical. The largest
method `executeParallelPipelines` (93 LOC) handles parallel orchestration,
logging, and error coordination in one place.

`IndexPipeline` (310 LOC) duplicates finalization logic with different ordering,
making the two pipelines inconsistent and harder to maintain.

## Goals

1. Isolate the parallel reindex execution into a standalone testable module
2. Unify shared finalization into `BaseIndexingPipeline`
3. Co-locate logging with the logic it describes
4. Both pipelines follow the same phase order after refactoring

## Non-Goals

- Changing public API signatures (`reindexChanges`, `indexCodebase`)
- Modifying `file-processor.ts`, `deletion-strategy.ts`, or `factory.ts`
- Adding new features or changing behavior

## Design

### Module 1: `completePipeline()` on BaseIndexingPipeline

New protected method in `pipeline/base.ts`:

```typescript
protected async completePipeline(
  processingCtx: ProcessingContext,
  chunkMap: Map<string, ChunkLookupEntry[]>,
  collectionName: string,
  absolutePath: string,
): Promise<EnrichmentStatusResult> {
  const getEnrichmentStatus = await this.finalizeProcessing(
    processingCtx, chunkMap, collectionName, absolutePath,
  );
  await storeIndexingMarker(this.qdrant, this.embeddings, collectionName, true);
  return getEnrichmentStatus();
}
```

Both pipelines call `completePipeline()`, then their specific post-steps:

- **IndexPipeline:** `completePipeline()` -> `finalizeAlias()` ->
  `saveSnapshot()`
- **ReindexPipeline:** `completePipeline()` -> `synchronizer.updateSnapshot()`
  -> `deleteCheckpoint()`

### Module 2: `reindex-parallel-executor.ts`

New file: `src/core/domains/ingest/pipeline/reindex-parallel-executor.ts`

Standalone function extracted from `ReindexPipeline.executeParallelPipelines`:

```typescript
export interface ReindexExecutionParams {
  qdrant: QdrantManager;
  collectionName: string;
  absolutePath: string;
  changes: FileChanges;
  deleteConfig: DeletionConfig;
  chunkerPool: ChunkerPool;
  chunkPipeline: ChunkPipeline;
  processOpts: { enableGitMetadata: boolean; concurrency: number };
  progressCallback?: ProgressCallback;
}

export interface ReindexExecutionResult {
  chunksAdded: number;
  chunksDeleted: number;
  chunkMap: Map<string, ChunkLookupEntry[]>;
}

export async function executeReindexPipelines(
  params: ReindexExecutionParams,
): Promise<ReindexExecutionResult>;
```

**Execution strategy** (moved as-is from ReindexPipeline):

- Level 1: `performDeletion()` + `processRelativeFiles(added)` in parallel
- Level 2: `processRelativeFiles(modified)` after deletion completes

Logging functions `logParallelStart()` and `logPipelineStats()` move into this
module as local (non-exported) functions, co-located with the logic they
describe.

### Module 3: Shared logging in BaseIndexingPipeline

- `reportScanProgress()` -> move from ReindexPipeline to BaseIndexingPipeline
  (IndexPipeline has analogous logic in `scanAndReport`)
- `logPipelineCompletion()` -> unify IndexPipeline's version with a shared
  protected method in BaseIndexingPipeline

### Resulting structure

```
pipeline/base.ts                        ~270 LOC (+completePipeline, +shared logging)
pipeline/reindex-parallel-executor.ts   ~100 LOC (new)
../reindexing.ts                        ~200 LOC (was 393)
../indexing.ts                          ~220 LOC (was 310)
```

### Phase consistency

Both pipelines after refactoring:

```
prepare -> heartbeat.start -> execute -> heartbeat.stop -> completePipeline -> post-steps -> cleanup
```

## Affected Files

| File                                                                   | Change                                                                      |
| ---------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| `src/core/domains/ingest/pipeline/base.ts`                             | Add `completePipeline()`, `reportScanProgress()`, `logPipelineCompletion()` |
| `src/core/domains/ingest/pipeline/reindex-parallel-executor.ts`        | New file: `executeReindexPipelines()` + local logging                       |
| `src/core/domains/ingest/reindexing.ts`                                | Remove 6 methods, delegate to executor and base                             |
| `src/core/domains/ingest/indexing.ts`                                  | Use `completePipeline()` and shared logging from base                       |
| `tests/core/domains/ingest/pipeline/reindex-parallel-executor.test.ts` | New test file                                                               |
| `tests/core/domains/ingest/reindexing.test.ts`                         | Minor import adjustments if needed                                          |
| `tests/core/domains/ingest/indexing.test.ts`                           | Minor import adjustments if needed                                          |

## Testing Strategy

- **New:** `reindex-parallel-executor.test.ts` -- tests 2-level parallel
  strategy in isolation (mock qdrant, processRelativeFiles, performDeletion)
- **Existing:** `reindexing.test.ts` and `indexing.test.ts` must pass without
  behavioral changes. May need minor adjustments for changed internal imports.
- **Integration:** `enrichment-module.test.ts`, `enrichment-await.test.ts` --
  must pass unchanged (they test end-to-end flows)

## Risks

- **Ordering change in IndexPipeline:** Currently `finalizeProcessing` happens
  before `stopHeartbeat` in IndexPipeline but after in ReindexPipeline. Unifying
  to `heartbeat.stop -> completePipeline` changes IndexPipeline's order.
  `finalizeProcessing` starts async enrichment and flushes pipelines --
  heartbeat is not needed for these operations. Low risk but needs test
  verification.
- **Import changes in tests:** Tests that mock `ReindexPipeline` internals may
  need updates if mocked methods moved. The facade test mocks the class itself,
  so no impact expected.

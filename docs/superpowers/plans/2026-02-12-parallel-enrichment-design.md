# Parallel Enrichment Design

## Problem

Enrichment (git metadata) runs sequentially AFTER indexing completes. For large
repos (taxdome: 13K commits), this adds 10-30s of idle time where git log
reading could overlap with embedding.

## Current Flow (Sequential)

```
T=0    [scan → chunk → embed → store]     Phase 1
T=X    [git log → apply → chunk churn]    Phase 2 (background, fire-and-forget)
```

Total = Phase1 + Phase2. No overlap.

## Target Flow (Parallel/Streaming)

```
T=0    [scan → chunk → embed → store]       Phase 1
T=0    [git log reading ──────────]          Phase 2a (starts immediately!)
       [streaming apply as data meets >>>]   apply when both ready
T=5s   [chunk churn batch 1 (50 files)]      Phase 2b incremental
T=10s  [chunk churn batch 2 (50 files)]
T=Xs   [chunk churn final batch]
```

Total = max(Phase1, GitLog) + apply + chunkChurn. Savings = min(Phase1, GitLog)
— the overlap.

## Architecture

### 1. Pipeline Callback

Add `onBatchUpserted` to ChunkPipeline. Called inside `createBatchHandler()`
right after successful `qdrant.addPointsOptimized()`.

```typescript
// chunk-pipeline.ts
private onBatchUpserted?: (items: ChunkItem[]) => void;

setOnBatchUpserted(cb: (items: ChunkItem[]) => void): void {
  this.onBatchUpserted = cb;
}

// In createBatchHandler(), after upsert:
this.onBatchUpserted?.(batch.items);
```

No changes to WorkerPool, BatchResult, or BatchAccumulator.

### 2. Streaming EnrichmentModule

Two parallel data streams:

- Stream A: `buildFileMetadataMap()` → all files' git metadata (batch)
- Stream B: pipeline callbacks → chunks confirmed in Qdrant (per-batch)

```typescript
class EnrichmentModule {
  private gitLogPromise: Promise<Map> | null = null;
  private gitLogResult: Map | null = null;
  private pendingChunks: Map<string, ChunkLookupEntry[]>; // waiting for git log

  // Called at T=0, before pipeline starts
  prefetchGitLog(absolutePath: string): void;

  // Called by pipeline callback on each upserted batch
  onChunksStored(collectionName, absolutePath, items): void;

  // Called periodically (every 50 files) for incremental chunk churn
  processChunkChurnBatch(absolutePath, chunkMap): void;
}
```

Three timing scenarios:

- Git log finishes first → first batches queued, then streaming apply
- Simultaneous → mix of queuing and streaming
- Embedding finishes first → all queued → burst apply when git log ready

### 3. Incremental Chunk Churn (Phase 2b)

Instead of waiting for complete chunkMap, process in batches of ~50 files. Uses
pathspec optimization from Step 0b:

```
git log --numstat --since=... -- file1 file2 ... file50
```

Triggered every 50 files during indexing + final batch after pipeline flush.

### 4. Debug Logging

New enrichment metrics for pipeline debug report:

- `overlapMs` — how much git log overlapped with embedding
- `overlapRatio` — 0.0-1.0, fraction of time saved
- `streamingApplies` — batches applied via callback (real-time)
- `flushApplies` — batches applied from pending queue
- `chunkChurnBatches` — incremental chunk churn batch count

### 5. Orchestration (IndexingModule)

```
1. Scan files
2. Create collection
3. enrichment.prefetchGitLog(path)          ← NEW: start git log
4. pipeline = new ChunkPipeline(...)
5. pipeline.setOnBatchUpserted(callback)    ← NEW: wire callback
6. pipeline.start()
7. parallelLimit(files, processFile)        ← existing streaming
   - every 50 files: enrichment.processChunkChurnBatch()  ← NEW
8. pipeline.flush() + shutdown()
9. enrichment.processChunkChurnBatch()      ← NEW: final batch
```

ReindexModule gets analogous changes.

## Files Changed

| File                 | Change                                               |
| -------------------- | ---------------------------------------------------- |
| chunk-pipeline.ts    | + onBatchUpserted callback                           |
| enrichment-module.ts | Full rewrite: streaming, prefetch, pending queue     |
| indexing-module.ts   | Wire prefetch + callback + periodic chunk churn      |
| reindex-module.ts    | Same orchestration changes                           |
| debug-logger.ts      | New overlap/streaming metrics                        |
| Tests                | Streaming scenarios, callback wiring, overlap timing |

## Not Changed

WorkerPool, BatchAccumulator, BatchResult, QdrantManager, public CodeIndexer
API.

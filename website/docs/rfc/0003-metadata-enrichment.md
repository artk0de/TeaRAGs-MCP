---
title: "RFC 0003: Parallel Git Enrichment"
sidebar_position: 3
slug: /rfc/0003-metadata-enrichment
---

# RFC 0003: Parallel Git Enrichment

## Status

Implemented

## Problem

Git metadata enrichment runs sequentially **after** the indexing pipeline completes. For large repositories (e.g. 13K+ commits), this adds 10--30 seconds of idle time where the git log read could overlap with embedding computation. The two phases share no data dependency at the start, yet the current architecture serializes them:

```text
T=0    [scan -> chunk -> embed -> store]     Phase 1
T=X    [git log -> apply -> chunk churn]     Phase 2 (starts only after Phase 1)
```

Total wall time = Phase 1 + Phase 2. No overlap occurs.

## Proposed Solution

Restructure enrichment into a parallel, streaming pipeline that starts git log prefetching at T=0 and applies metadata incrementally as both data streams converge.

### Target Flow

```text
T=0    [scan -> chunk -> embed -> store]       Phase 1
T=0    [git log reading ──────────]            Phase 2a (starts immediately)
       [streaming apply as data meets >>>]     apply when both ready
T=5s   [chunk churn batch 1 (50 files)]        Phase 2b incremental
T=10s  [chunk churn batch 2 (50 files)]
T=Xs   [chunk churn final batch]
```

Total = max(Phase 1, git log) + apply + chunk churn.
Savings = min(Phase 1, git log) -- the overlap.

## Architecture

### 1. Pipeline Callback (`onBatchUpserted`)

A new callback on `ChunkPipeline`, invoked inside `createBatchHandler()` immediately after a successful `qdrant.addPointsOptimized()` call. This provides a real-time signal that a batch of chunks has been persisted and is ready for metadata attachment.

```typescript
// chunk-pipeline.ts
private onBatchUpserted?: (items: ChunkItem[]) => void;

setOnBatchUpserted(cb: (items: ChunkItem[]) => void): void {
  this.onBatchUpserted = cb;
}

// In createBatchHandler(), after upsert:
this.onBatchUpserted?.(batch.items);
```

No changes to `WorkerPool`, `BatchResult`, or `BatchAccumulator`.

### 2. Streaming EnrichmentModule

Two parallel data streams feed into the enrichment module:

- **Stream A:** `buildFileMetadataMap()` produces all files' git metadata (batch read of git log).
- **Stream B:** Pipeline callbacks deliver chunks confirmed in Qdrant (per-batch, real-time).

```typescript
class EnrichmentModule {
  private gitLogPromise: Promise<Map> | null = null;
  private gitLogResult: Map | null = null;
  private pendingChunks: Map<string, ChunkLookupEntry[]>;

  // Called at T=0, before pipeline starts
  prefetchGitLog(absolutePath: string): void;

  // Called by pipeline callback on each upserted batch
  onChunksStored(collectionName, absolutePath, items): void;

  // Called periodically (every 50 files) for incremental chunk churn
  processChunkChurnBatch(absolutePath, chunkMap): void;
}
```

Three timing scenarios arise naturally:

| Scenario | Behavior |
|----------|----------|
| Git log finishes first | First batches queue in `pendingChunks`, then streaming apply begins |
| Simultaneous completion | Mix of queuing and streaming |
| Embedding finishes first | All chunks queue, burst apply when git log resolves |

### 3. Incremental Chunk Churn (Phase 2b)

Instead of waiting for the complete chunk map, chunk churn processing happens in batches of approximately 50 files. Each batch uses pathspec optimization:

```text
git log --numstat --since=... -- file1 file2 ... file50
```

Batches trigger every 50 files during indexing, with a final batch after pipeline flush.

### 4. Debug Logging

New enrichment metrics appear in the pipeline debug report:

| Metric | Description |
|--------|-------------|
| `overlapMs` | Milliseconds of git log that overlapped with embedding |
| `overlapRatio` | 0.0--1.0 fraction of time saved via parallelism |
| `streamingApplies` | Batches applied via callback (real-time) |
| `flushApplies` | Batches applied from the pending queue |
| `chunkChurnBatches` | Number of incremental chunk churn batches processed |

### 5. Orchestration

The `IndexingModule` wires the parallel pipeline:

```text
1. Scan files
2. Create collection
3. enrichment.prefetchGitLog(path)          <- start git log at T=0
4. pipeline = new ChunkPipeline(...)
5. pipeline.setOnBatchUpserted(callback)    <- wire streaming callback
6. pipeline.start()
7. parallelLimit(files, processFile)        <- existing streaming
   - every 50 files: enrichment.processChunkChurnBatch()
8. pipeline.flush() + shutdown()
9. enrichment.processChunkChurnBatch()      <- final batch
```

`ReindexModule` receives analogous changes.

## Files Changed

| File | Change |
|------|--------|
| `chunk-pipeline.ts` | `onBatchUpserted` callback |
| `enrichment-module.ts` | Full rewrite: streaming, prefetch, pending queue |
| `indexing-module.ts` | Wire prefetch + callback + periodic chunk churn |
| `reindex-module.ts` | Same orchestration changes |
| `debug-logger.ts` | New overlap/streaming metrics |
| Tests | Streaming scenarios, callback wiring, overlap timing |

## Invariants Preserved

`WorkerPool`, `BatchAccumulator`, `BatchResult`, `QdrantManager`, and the public `CodeIndexer` API remain unchanged. The optimization is entirely internal to the indexing pipeline.

## Trade-offs

- **Increased complexity** in `EnrichmentModule` due to the pending queue and dual-stream synchronization. Mitigated by clear state machine semantics and comprehensive debug metrics.
- **Memory overhead** from `pendingChunks` map when embedding completes before git log. Bounded by total chunk count, which is already held in memory during indexing.
- **Batch size of 50 files** is a heuristic. Too small increases git process spawns; too large delays chunk churn feedback. The value is tunable without architectural changes.

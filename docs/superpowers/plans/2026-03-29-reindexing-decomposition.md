# Reindexing Decomposition Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use
> superpowers:subagent-driven-development (recommended) or
> superpowers:executing-plans to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** Decompose ReindexPipeline into isolated modules and unify shared steps
with IndexPipeline for consistent phase ordering and better testability.

**Architecture:** Extract parallel execution into standalone
`reindex-parallel-executor.ts`, add shared `completePipeline()` to
BaseIndexingPipeline, co-locate logging with logic. Both pipelines follow
`prepare → heartbeat.start → execute → heartbeat.stop → completePipeline → post-steps → cleanup`.

**Tech Stack:** TypeScript, Vitest

**Spec:** `docs/superpowers/specs/2026-03-29-reindexing-decomposition-design.md`

---

## File Map

| File                                                                   | Action | Responsibility                                      |
| ---------------------------------------------------------------------- | ------ | --------------------------------------------------- |
| `src/core/domains/ingest/pipeline/base.ts`                             | Modify | Add `completePipeline()`, `logPipelineCompletion()` |
| `src/core/domains/ingest/pipeline/reindex-parallel-executor.ts`        | Create | `executeReindexPipelines()` + co-located logging    |
| `src/core/domains/ingest/reindexing.ts`                                | Modify | Thin orchestrator delegating to executor + base     |
| `src/core/domains/ingest/indexing.ts`                                  | Modify | Use `completePipeline()` + shared logging from base |
| `tests/core/domains/ingest/pipeline/reindex-parallel-executor.test.ts` | Create | Unit tests for parallel executor                    |
| `tests/core/domains/ingest/reindexing.test.ts`                         | Verify | Must pass unchanged                                 |
| `tests/core/domains/ingest/indexing.test.ts`                           | Verify | Must pass unchanged                                 |

---

### Task 1: Add `completePipeline()` and `logPipelineCompletion()` to BaseIndexingPipeline

**Files:**

- Modify: `src/core/domains/ingest/pipeline/base.ts:14,153-161`
- Test: existing `tests/core/domains/ingest/reindexing.test.ts`,
  `tests/core/domains/ingest/indexing.test.ts`

- [ ] **Step 1: Add import for `storeIndexingMarker`**

In `src/core/domains/ingest/pipeline/base.ts`, add the import:

```typescript
import { storeIndexingMarker, updateHeartbeat } from "./indexing-marker.js";
```

(Replace the existing `import { updateHeartbeat } from "./indexing-marker.js";`
on line 20.)

- [ ] **Step 2: Add `logPipelineCompletion()` protected method**

Add after `finalizeProcessing()` (after line 161), before the private section:

```typescript
  /** Shared pipeline completion log — used by both IndexPipeline and ReindexPipeline. */
  protected logPipelineCompletion(ctx: ProcessingContext, label: string): void {
    if (isDebug()) {
      const stats = ctx.chunkPipeline.getStats();
      console.error(
        `[${label}] Pipeline completed: ${stats.itemsProcessed} chunks in ${stats.batchesProcessed} batches, ` +
          `${stats.throughput.toFixed(1)} chunks/s`,
      );
    }
  }
```

This requires adding the `isDebug` import. Add to existing imports:

```typescript
import { isDebug } from "./infra/runtime.js";
```

- [ ] **Step 3: Add `completePipeline()` protected method**

Add after `logPipelineCompletion()`:

```typescript
  /**
   * Shared finalization: flush pipelines → start enrichment → store completion marker.
   * Both IndexPipeline and ReindexPipeline call this, then their specific post-steps.
   */
  protected async completePipeline(
    processingCtx: ProcessingContext,
    chunkMap: Map<string, ChunkLookupEntry[]>,
    collectionName: string,
    absolutePath: string,
  ): Promise<EnrichmentStatusResult> {
    const getEnrichmentStatus = await this.finalizeProcessing(
      processingCtx,
      chunkMap,
      collectionName,
      absolutePath,
    );
    await storeIndexingMarker(this.qdrant, this.embeddings, collectionName, true);
    return getEnrichmentStatus();
  }
```

- [ ] **Step 4: Run tests to verify no regressions**

Run:
`npx vitest run tests/core/domains/ingest/indexing.test.ts tests/core/domains/ingest/reindexing.test.ts`

Expected: All tests PASS (new methods added but not yet called — no behavioral
change).

- [ ] **Step 5: Commit**

```bash
git add src/core/domains/ingest/pipeline/base.ts
git commit -m "refactor(ingest): add completePipeline() and logPipelineCompletion() to BaseIndexingPipeline"
```

---

### Task 2: Create `reindex-parallel-executor.ts`

**Files:**

- Create: `src/core/domains/ingest/pipeline/reindex-parallel-executor.ts`
- Test: `tests/core/domains/ingest/pipeline/reindex-parallel-executor.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/core/domains/ingest/pipeline/reindex-parallel-executor.test.ts`:

```typescript
import { describe, expect, it, vi } from "vitest";

// Import mocked modules for assertions
import { processRelativeFiles } from "../../../../../src/core/domains/ingest/pipeline/file-processor.js";
import {
  executeReindexPipelines,
  type ReindexExecutionParams,
} from "../../../../../src/core/domains/ingest/pipeline/reindex-parallel-executor.js";
import { performDeletion } from "../../../../../src/core/domains/ingest/sync/deletion-strategy.js";

// Mock file-processor
vi.mock(
  "../../../../../src/core/domains/ingest/pipeline/file-processor.js",
  () => ({
    processRelativeFiles: vi.fn().mockResolvedValue(0),
  }),
);

// Mock deletion-strategy
vi.mock(
  "../../../../../src/core/domains/ingest/sync/deletion-strategy.js",
  () => ({
    performDeletion: vi.fn().mockResolvedValue(0),
  }),
);

function createMockParams(
  overrides?: Partial<ReindexExecutionParams>,
): ReindexExecutionParams {
  return {
    qdrant: {} as any,
    collectionName: "test_collection",
    absolutePath: "/test/path",
    changes: {
      added: [],
      modified: [],
      deleted: [],
      newlyIgnored: [],
      newlyUnignored: [],
    },
    deleteConfig: { batchSize: 500, concurrency: 8 },
    chunkerPool: { shutdown: vi.fn() } as any,
    chunkPipeline: {
      getStats: vi.fn().mockReturnValue({
        itemsProcessed: 0,
        batchesProcessed: 0,
        throughput: 0,
      }),
      getPendingCount: vi.fn().mockReturnValue(0),
    } as any,
    processOpts: { enableGitMetadata: false, concurrency: 50 },
    ...overrides,
  };
}

describe("executeReindexPipelines", () => {
  it("should return zero counts when no changes", async () => {
    const params = createMockParams();
    const result = await executeReindexPipelines(params);

    expect(result.chunksAdded).toBe(0);
    expect(result.chunksDeleted).toBe(0);
    expect(result.chunkMap.size).toBe(0);
  });

  it("should call performDeletion with modified + deleted + newlyIgnored files", async () => {
    const params = createMockParams({
      changes: {
        added: [],
        modified: ["mod.ts"],
        deleted: ["del.ts"],
        newlyIgnored: ["ign.ts"],
        newlyUnignored: [],
      },
    });

    await executeReindexPipelines(params);

    expect(performDeletion).toHaveBeenCalledWith(
      params.qdrant,
      "test_collection",
      ["mod.ts", "del.ts", "ign.ts"],
      params.deleteConfig,
      undefined,
    );
  });

  it("should process added and modified files separately", async () => {
    const params = createMockParams({
      changes: {
        added: ["new.ts"],
        modified: ["mod.ts"],
        deleted: [],
        newlyIgnored: [],
        newlyUnignored: [],
      },
    });

    vi.mocked(processRelativeFiles)
      .mockResolvedValueOnce(3) // added
      .mockResolvedValueOnce(2); // modified

    const result = await executeReindexPipelines(params);

    expect(result.chunksAdded).toBe(5);
    expect(processRelativeFiles).toHaveBeenCalledTimes(2);

    // First call: added files with "added" label
    expect(vi.mocked(processRelativeFiles).mock.calls[0]?.[0]).toEqual([
      "new.ts",
    ]);
    expect(vi.mocked(processRelativeFiles).mock.calls[0]?.[6]).toBe("added");

    // Second call: modified files with "modified" label
    expect(vi.mocked(processRelativeFiles).mock.calls[1]?.[0]).toEqual([
      "mod.ts",
    ]);
    expect(vi.mocked(processRelativeFiles).mock.calls[1]?.[6]).toBe("modified");
  });

  it("should aggregate deletion count from performDeletion", async () => {
    vi.mocked(performDeletion).mockResolvedValue(7);

    const params = createMockParams({
      changes: {
        added: [],
        modified: [],
        deleted: ["a.ts", "b.ts"],
        newlyIgnored: [],
        newlyUnignored: [],
      },
    });

    const result = await executeReindexPipelines(params);
    expect(result.chunksDeleted).toBe(7);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run:
`npx vitest run tests/core/domains/ingest/pipeline/reindex-parallel-executor.test.ts`

Expected: FAIL — module not found.

- [ ] **Step 3: Write the implementation**

Create `src/core/domains/ingest/pipeline/reindex-parallel-executor.ts`:

```typescript
/**
 * Reindex Parallel Executor — extracted from ReindexPipeline.executeParallelPipelines().
 *
 * Standalone function: all dependencies via params, no `this`.
 * Testable in isolation without pipeline infrastructure.
 */

import type { QdrantManager } from "../../../adapters/qdrant/client.js";
import type {
  ChunkLookupEntry,
  FileChanges,
  ProgressCallback,
} from "../../../types.js";
import {
  performDeletion,
  type DeletionConfig,
} from "../sync/deletion-strategy.js";
import type { ChunkPipeline } from "./chunk-pipeline.js";
import type { ChunkerPool } from "./chunker/infra/pool.js";
import {
  processRelativeFiles,
  type FileProcessorOptions,
} from "./file-processor.js";
import { pipelineLog } from "./infra/debug-logger.js";
import { isDebug } from "./infra/runtime.js";

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
): Promise<ReindexExecutionResult> {
  const {
    qdrant,
    collectionName,
    absolutePath,
    changes,
    deleteConfig,
    progressCallback,
  } = params;
  const { chunkerPool, chunkPipeline, processOpts } = params;
  const chunkMap = new Map<string, ChunkLookupEntry[]>();

  const filesToDelete = [
    ...changes.modified,
    ...changes.deleted,
    ...changes.newlyIgnored,
  ];
  const addedFiles = [...changes.added];
  const modifiedFiles = [...changes.modified];

  const parallelStart = Date.now();
  logParallelStart(filesToDelete, addedFiles, modifiedFiles);

  // Level 1: delete old chunks + process added files in parallel
  const deleteStartTime = Date.now();
  let chunksDeleted = 0;
  const deletePromise = performDeletion(
    qdrant,
    collectionName,
    filesToDelete,
    deleteConfig,
    progressCallback,
  ).then((count) => {
    chunksDeleted = count;
  });
  const addPromise = processRelativeFiles(
    addedFiles,
    absolutePath,
    chunkerPool,
    chunkPipeline,
    processOpts,
    chunkMap,
    "added",
  );

  pipelineLog.reindexPhase("DELETE_AND_ADD_STARTED", {
    deleteFiles: filesToDelete.length,
    addFiles: addedFiles.length,
  });

  await deletePromise;

  pipelineLog.reindexPhase("DELETE_COMPLETE", {
    durationMs: Date.now() - deleteStartTime,
    deleted: filesToDelete.length,
  });

  if (isDebug()) {
    console.error(
      `[Reindex] Delete complete, starting modified indexing (add still running in parallel)`,
    );
  }

  // Level 2: process modified files (after delete completes)
  const modifiedStartTime = Date.now();
  const modifiedPromise = processRelativeFiles(
    modifiedFiles,
    absolutePath,
    chunkerPool,
    chunkPipeline,
    processOpts,
    chunkMap,
    "modified",
  );

  pipelineLog.reindexPhase("MODIFIED_STARTED", {
    modifiedFiles: modifiedFiles.length,
    addStillRunning: true,
  });

  const [addedChunks, modifiedChunks] = await Promise.all([
    addPromise,
    modifiedPromise,
  ]);

  pipelineLog.reindexPhase("ADD_AND_MODIFIED_COMPLETE", {
    addedChunks,
    modifiedChunks,
    addDurationMs: Date.now() - parallelStart,
    modifiedDurationMs: Date.now() - modifiedStartTime,
  });

  logPipelineStats(chunkPipeline, parallelStart);

  return { chunksAdded: addedChunks + modifiedChunks, chunksDeleted, chunkMap };
}

// ── Co-located logging (not exported) ─────────────────────

function logParallelStart(
  filesToDelete: string[],
  addedFiles: string[],
  modifiedFiles: string[],
): void {
  pipelineLog.reindexPhase("PARALLEL_START", {
    deleted: filesToDelete.length,
    added: addedFiles.length,
    modified: modifiedFiles.length,
  });

  if (isDebug()) {
    console.error(
      `[Reindex] Starting parallel pipelines: ` +
        `delete=${filesToDelete.length}, added=${addedFiles.length}, modified=${modifiedFiles.length}`,
    );
  }
}

function logPipelineStats(
  chunkPipeline: ChunkPipeline,
  parallelStart: number,
): void {
  if (isDebug()) {
    const pipelineStats = chunkPipeline.getStats();
    console.error(
      `[Reindex] ChunkPipeline before flush: ` +
        `pending=${chunkPipeline.getPendingCount()}, ` +
        `processed=${pipelineStats.itemsProcessed}, ` +
        `batches=${pipelineStats.batchesProcessed}`,
    );
    console.error(
      `[Reindex] Parallel pipelines completed in ${Date.now() - parallelStart}ms ` +
        `(pipeline: ${pipelineStats.itemsProcessed} chunks in ${pipelineStats.batchesProcessed} batches, ` +
        `${pipelineStats.throughput.toFixed(1)} chunks/s)`,
    );
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run:
`npx vitest run tests/core/domains/ingest/pipeline/reindex-parallel-executor.test.ts`

Expected: All 4 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/core/domains/ingest/pipeline/reindex-parallel-executor.ts tests/core/domains/ingest/pipeline/reindex-parallel-executor.test.ts
git commit -m "refactor(ingest): extract executeReindexPipelines() into standalone module"
```

---

### Task 3: Refactor ReindexPipeline to use new modules

**Files:**

- Modify: `src/core/domains/ingest/reindexing.ts`
- Test: existing `tests/core/domains/ingest/reindexing.test.ts`

- [ ] **Step 1: Replace imports**

Replace the imports section (lines 9-19) of `reindexing.ts`:

```typescript
import type {
  ChangeStats,
  ChunkLookupEntry,
  FileChanges,
  ProgressCallback,
} from "../../types.js";
import {
  NotIndexedError,
  ReindexFailedError,
  SnapshotMissingError,
} from "./errors.js";
import {
  BaseIndexingPipeline,
  type PipelineTuning,
  type ProcessingContext,
} from "./pipeline/base.js";
import { storeIndexingMarker } from "./pipeline/indexing-marker.js";
import { pipelineLog } from "./pipeline/infra/debug-logger.js";
import { isDebug } from "./pipeline/infra/runtime.js";
import { executeReindexPipelines } from "./pipeline/reindex-parallel-executor.js";
import type { FileScanner } from "./pipeline/scanner.js";
import {
  performDeletion,
  type DeletionConfig,
} from "./sync/deletion-strategy.js";
import type { ParallelFileSynchronizer } from "./sync/parallel-synchronizer.js";
import { SnapshotCleaner } from "./sync/snapshot-cleaner.js";
```

Removed: `processRelativeFiles` import (moved into executor).

- [ ] **Step 2: Rewrite `reindexChanges()` to use `completePipeline()` and
      `executeReindexPipelines()`**

Replace the `reindexChanges` method (lines 42-107) with:

```typescript
  async reindexChanges(path: string, progressCallback?: ProgressCallback): Promise<ChangeStats> {
    const startTime = Date.now();
    const { absolutePath, collectionName } = await this.resolveContext(path);
    const stats: ChangeStats = {
      filesAdded: 0,
      filesModified: 0,
      filesDeleted: 0,
      filesNewlyIgnored: 0,
      filesNewlyUnignored: 0,
      chunksAdded: 0,
      chunksDeleted: 0,
      durationMs: 0,
      status: "completed",
    };

    try {
      const ctx = await this.prepareReindexContext(absolutePath, collectionName);
      const resumeFromCheckpoint = await this.checkForCheckpoint(ctx.synchronizer);

      this.reportScanProgress(progressCallback, resumeFromCheckpoint);

      const changes = await this.detectFileChanges(ctx);
      stats.filesAdded = changes.added.length;
      stats.filesModified = changes.modified.length;
      stats.filesDeleted = changes.deleted.length;
      stats.filesNewlyIgnored = changes.newlyIgnored.length;
      stats.filesNewlyUnignored = changes.newlyUnignored.length;

      if (this.hasNoChanges(stats)) {
        await storeIndexingMarker(this.qdrant, this.embeddings, ctx.collectionName, true);
        await ctx.synchronizer.deleteCheckpoint();
        stats.durationMs = Date.now() - startTime;
        return stats;
      }

      // Deletion-only: no files to add/modify → skip pipeline init and enrichment
      if (changes.added.length === 0 && changes.modified.length === 0) {
        await this.executeDeletionOnly(ctx, changes, stats, progressCallback);
        await storeIndexingMarker(this.qdrant, this.embeddings, ctx.collectionName, true);
        await ctx.synchronizer.updateSnapshot(ctx.currentFiles);
        await ctx.synchronizer.deleteCheckpoint();
        stats.enrichmentStatus = "skipped";
        stats.durationMs = Date.now() - startTime;
        return stats;
      }

      // Main path: parallel delete + process
      const changedPaths = [...changes.added, ...changes.modified];
      const pCtx = this.initProcessing(ctx.collectionName, ctx.absolutePath, ctx.scanner, changedPaths);

      this.startHeartbeat(ctx.collectionName);
      const result = await executeReindexPipelines({
        qdrant: this.qdrant,
        collectionName: ctx.collectionName,
        absolutePath: ctx.absolutePath,
        changes,
        deleteConfig: this.deleteConfig,
        chunkerPool: pCtx.chunkerPool,
        chunkPipeline: pCtx.chunkPipeline,
        processOpts: {
          enableGitMetadata: this.config.enableGitMetadata === true,
          concurrency: this.tuning.fileConcurrency,
        },
        progressCallback,
      });
      stats.chunksAdded = result.chunksAdded;
      stats.chunksDeleted = result.chunksDeleted;

      this.stopHeartbeat();
      this.logPipelineCompletion(pCtx, "Reindex");

      const enrichmentResult = await this.completePipeline(
        pCtx,
        result.chunkMap,
        ctx.collectionName,
        ctx.absolutePath,
      );
      await ctx.synchronizer.updateSnapshot(ctx.currentFiles);
      await ctx.synchronizer.deleteCheckpoint();

      stats.enrichmentStatus = enrichmentResult.status;
      stats.enrichmentMetrics = enrichmentResult.metrics;
      stats.durationMs = Date.now() - startTime;

      if (isDebug()) {
        console.error(
          `[Reindex] Complete: ${stats.filesAdded} added, ` +
            `${stats.filesModified} modified, ${stats.filesDeleted} deleted${
              stats.filesNewlyIgnored > 0 ? `, ${stats.filesNewlyIgnored} newly ignored` : ""
            }${
              stats.filesNewlyUnignored > 0 ? `, ${stats.filesNewlyUnignored} newly unignored` : ""
            }. Created ${stats.chunksAdded} chunks in ${(stats.durationMs / 1000).toFixed(1)}s`,
        );
      }

      return stats;
    } catch (error) {
      this.wrapUnexpectedError(error, ReindexFailedError);
    } finally {
      this.stopHeartbeat();
      const cleaner = new SnapshotCleaner(this.snapshotDir, collectionName);
      await cleaner.cleanupAfterIndexing();
    }
  }
```

- [ ] **Step 3: Remove extracted methods**

Delete these methods from ReindexPipeline (they now live in
`reindex-parallel-executor.ts` or `BaseIndexingPipeline`):

- `executeParallelPipelines()` (lines 182-275)
- `finalizeReindex()` (lines 279-312)
- `logParallelStart()` (lines 362-375)
- `logPipelineStats()` (lines 377-392)
- `reportScanProgress()` (lines 352-360) — keep for now (reindex-specific
  checkpoint message)

- [ ] **Step 4: Run tests to verify no regressions**

Run: `npx vitest run tests/core/domains/ingest/reindexing.test.ts`

Expected: All tests PASS — public behavior unchanged.

- [ ] **Step 5: Run full ingest test suite**

Run: `npx vitest run tests/core/domains/ingest/`

Expected: All tests PASS including integration tests
(`enrichment-module.test.ts`, `enrichment-await.test.ts`).

- [ ] **Step 6: Commit**

```bash
git add src/core/domains/ingest/reindexing.ts
git commit -m "refactor(ingest): ReindexPipeline delegates to executor and completePipeline()"
```

---

### Task 4: Refactor IndexPipeline to use `completePipeline()` and shared logging

**Files:**

- Modify: `src/core/domains/ingest/indexing.ts`
- Test: existing `tests/core/domains/ingest/indexing.test.ts`

- [ ] **Step 1: Remove `storeIndexingMarker` import**

In `indexing.ts`, remove line 18:

```typescript
import { storeIndexingMarker } from "./pipeline/indexing-marker.js";
```

`storeIndexingMarker` is now called inside `completePipeline()` from base.

- [ ] **Step 2: Rewrite finalization in `indexCodebase()`**

Replace lines 95-112 (from
`const getEnrichmentStatus = await this.finalizeProcessing(` through
`return stats;`) with:

```typescript
this.stopHeartbeat();
this.logPipelineCompletion(ctx, "Index");

const enrichmentResult = await this.completePipeline(
  ctx,
  result.chunkMap,
  setup.targetCollection,
  absolutePath,
);
await this.finalizeAlias(collectionName, setup);
await this.saveSnapshot(
  absolutePath,
  collectionName,
  files,
  stats,
  setup.aliasVersion,
);

stats.enrichmentStatus = enrichmentResult.status;
stats.enrichmentMetrics = enrichmentResult.metrics;
stats.durationMs = Date.now() - startTime;
return stats;
```

This changes the phase order to:
`stopHeartbeat → logCompletion → completePipeline (finalizeProcessing + marker) → alias → snapshot`
— matching the unified phase order from the spec.

- [ ] **Step 3: Remove the private `logPipelineCompletion()` method**

Delete lines 284-292 (the private `logPipelineCompletion` method). It's now
replaced by the shared `logPipelineCompletion(ctx, label)` from
`BaseIndexingPipeline`.

- [ ] **Step 4: Run tests to verify no regressions**

Run: `npx vitest run tests/core/domains/ingest/indexing.test.ts`

Expected: All tests PASS — public behavior unchanged.

- [ ] **Step 5: Run full test suite**

Run: `npx vitest run`

Expected: All tests PASS.

- [ ] **Step 6: Commit**

```bash
git add src/core/domains/ingest/indexing.ts
git commit -m "refactor(ingest): IndexPipeline uses completePipeline() and shared logging"
```

---

### Task 5: Final verification and type-check

**Files:** All modified files

- [ ] **Step 1: Type-check**

Run: `npx tsc --noEmit`

Expected: No type errors.

- [ ] **Step 2: Lint**

Run:
`npx eslint src/core/domains/ingest/pipeline/base.ts src/core/domains/ingest/pipeline/reindex-parallel-executor.ts src/core/domains/ingest/reindexing.ts src/core/domains/ingest/indexing.ts`

Expected: No lint errors.

- [ ] **Step 3: Full test suite**

Run: `npx vitest run`

Expected: All tests PASS, coverage thresholds met.

- [ ] **Step 4: Verify LOC targets**

Check file sizes match spec expectations:

```bash
wc -l src/core/domains/ingest/pipeline/base.ts src/core/domains/ingest/pipeline/reindex-parallel-executor.ts src/core/domains/ingest/reindexing.ts src/core/domains/ingest/indexing.ts
```

Expected approximate:

- `base.ts` ~270 LOC (was 236)
- `reindex-parallel-executor.ts` ~110 LOC (new)
- `reindexing.ts` ~220 LOC (was 394)
- `indexing.ts` ~290 LOC (was 311)

- [ ] **Step 5: Commit any remaining fixes**

If lint/type fixes were needed:

```bash
git add -u
git commit -m "style(ingest): fix lint/type issues from decomposition refactor"
```

# Reindex Resilience Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `dinopowers:executing-plans`
> to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for
> tracking.

**Goal:** Eliminate orphan-chunk duplication caused by silent delete failures
during incremental reindex on large deltas. Pipeline must either finish with a
consistent collection or surface a typed failure — never leave the collection in
a split state.

**Root cause (from 2026-04-23 log forensics):** `performDeletion` in
`sync/deletion-strategy.ts` silently swallows per-file failures at fallback
Level 2 (lines 89-102). When `deletePointsByPathsBatched` and
`deletePointsByPaths` both time out (300s Qdrant requestTimeout during yellow
phase), L2 iterates file-by-file with per-iteration try/catch and only logs
`failed` counts. The function returns `totalBefore - totalAfter` regardless, so
the caller's `await deletePromise` resolves successfully. Modified-files upsert
then proceeds unaware, producing orphan duplicates for every file whose delete
actually failed. On the 2026-04-23 incident this doubled-tripled collection size
(52k → 140k points in peak).

**Architecture:** Four-layer intervention keeping the current parallel pipeline:

1. **Observability** — per-file telemetry so future incidents are diagnosable
   from logs
2. **Failure surfacing** — `performDeletion` returns a typed `DeletionOutcome`
   with `succeeded` and `failed` path sets; no silent L2 swallow
3. **Per-file barrier (A1)** — `ReindexCoordinator` holds the failed set;
   `file-processor` consults it before allowing `addChunk` for modified files;
   failed files marked as `stale` for next run
4. **Adaptive upsert batch sizing (D2)** — `ChunkPipeline` halves
   `upsertBatchSize` on `QdrantOptimizationInProgressError` (from
   yellow-handling plan), restores on N consecutive successes

Plus orthogonal **enrichment status flag recovery (E)** — reset `in_progress` at
pipeline start if `startedAt > completedAt` and age > threshold.

**Non-goals:**

- Deterministic point IDs (A3) — tracked as `tea-rags-mcp-grvw`, backlog
- Full sequential delete-then-upsert (B1) — rejected (2× wall time, search gap)
- Versioned incremental collection (C1) — force-reindex already covers manual
  recovery
- Schema migrations — this plan adds no Qdrant payload fields
- UI/MCP tool changes — internal coordination only

**Tech Stack:** TypeScript, @qdrant/js-client-rest, Vitest, existing
`pipelineLog` + error hierarchy.

**Spec:** inline (no separate design doc — refactoring-scope change).

**Cross-plan dependency:** Phase 4 consumes `QdrantOptimizationInProgressError`
from `docs/superpowers/plans/2026-04-23-qdrant-yellow-handling.md` Task 1.1. The
two plans share that error class; yellow-handling plan must merge Task 1.1
before this plan's Phase 4 starts. No other coupling.

---

## File Structure

**New files:**

- `src/core/domains/ingest/sync/reindex-coordinator.ts` — `ReindexCoordinator`
  class (Phase 3)
- `src/core/domains/ingest/sync/deletion-outcome.ts` — `DeletionOutcome` type +
  helpers (Phase 2)
- `src/core/domains/ingest/pipeline/adaptive-batch-sizer.ts` —
  `AdaptiveBatchSizer` (Phase 4)
- Tests mirror source structure.

**Modified files (grouped by Phase):**

| File                                                     | Phases | Why                                                         |
| -------------------------------------------------------- | ------ | ----------------------------------------------------------- |
| `src/core/domains/ingest/pipeline/file-processor.ts`     | 1, 3   | Emit `FILE_INGESTED`, consult coordinator before `addChunk` |
| `src/core/domains/ingest/pipeline/infra/debug-logger.ts` | 1      | Top-N slow-file tracker + `FILE_INGESTED` step helper       |
| `src/core/domains/ingest/sync/deletion-strategy.ts`      | 2      | Return `DeletionOutcome`, stop swallowing L2 failures       |
| `src/core/domains/ingest/reindexing.ts`                  | 2, 3   | Consume `DeletionOutcome`, wire `ReindexCoordinator`        |
| `src/core/domains/ingest/pipeline/chunk-pipeline.ts`     | 4      | Integrate `AdaptiveBatchSizer` on upsert path               |
| `src/core/domains/ingest/pipeline/status-module.ts`      | 5      | Reset stale `in_progress` on init                           |

---

## Phase 1 — Per-file telemetry (observability baseline)

**Why first:** every subsequent phase benefits from per-file data in post-mortem
analysis. Lands fast (no behaviour change), ships value immediately.

### Task 1.1: Add `FILE_INGESTED` event + top-N slow-file tracker

**Files:**

- Modify: `src/core/domains/ingest/pipeline/infra/debug-logger.ts`
- Modify: `src/core/domains/ingest/pipeline/file-processor.ts:108-190`
- Test: `tests/core/domains/ingest/pipeline/infra/debug-logger.test.ts`

**Impact signal:** `file-processor.ts` is moderate-churn shared code — minimal
diff, emit event only, no control-flow changes.

- [ ] **Step 1: Write the failing test for top-N tracker**

Create or extend
`tests/core/domains/ingest/pipeline/infra/debug-logger.test.ts`:

```ts
describe("SlowFileTracker", () => {
  it("keeps top-N files by parseMs, evicts faster ones on overflow", () => {
    const tracker = new SlowFileTracker(3);
    tracker.record({ path: "a.ts", parseMs: 100, chunks: 5, bytes: 1000 });
    tracker.record({ path: "b.ts", parseMs: 500, chunks: 10, bytes: 2000 });
    tracker.record({ path: "c.ts", parseMs: 50, chunks: 3, bytes: 500 });
    tracker.record({ path: "d.ts", parseMs: 300, chunks: 7, bytes: 1500 });

    const top = tracker.snapshot();
    expect(top).toHaveLength(3);
    expect(top.map((e) => e.path)).toEqual(["b.ts", "d.ts", "a.ts"]);
  });

  it("includes slow files in pipelineLog SUMMARY block", () => {
    // Integration via pipelineLog.finalize()
  });
});
```

- [ ] **Step 2: Implement `SlowFileTracker`**

Add to `debug-logger.ts`:

```ts
export interface FileIngestRecord {
  path: string;
  language: string;
  bytes: number;
  chunks: number;
  parseMs: number;
  skipped?: boolean;
  skipReason?: string;
}

export class SlowFileTracker {
  private readonly heap: FileIngestRecord[] = [];
  constructor(private readonly capacity: number = 20) {}

  record(entry: FileIngestRecord): void {
    if (entry.skipped) return; // skipped files don't count as "slow"
    this.heap.push(entry);
    this.heap.sort((a, b) => b.parseMs - a.parseMs);
    if (this.heap.length > this.capacity) this.heap.length = this.capacity;
  }

  snapshot(): readonly FileIngestRecord[] {
    return [...this.heap];
  }

  reset(): void {
    this.heap.length = 0;
  }
}
```

Wire into `pipelineLog`:

```ts
// In DebugLogger class:
private readonly slowFiles = new SlowFileTracker(20);

fileIngested(ctx: LogContext, record: FileIngestRecord): void {
  this.step(ctx, "FILE_INGESTED", record);
  this.slowFiles.record(record);
}

// Extend existing finalize/summary output to include:
//   SLOW_FILES_TOP_20: <JSON array of {path, parseMs, chunks, bytes, language}>
```

- [ ] **Step 3: Emit `FILE_INGESTED` from file-processor**

In `file-processor.ts`, after `result.filesProcessed++` at line 182:

```ts
pipelineLog.fileIngested(LOG_CTX, {
  path: relativePath,
  language,
  bytes: Buffer.byteLength(code, "utf8"),
  chunks: chunksToAdd.length,
  parseMs: parseDuration,
});
```

Where `parseDuration = Date.now() - parseStart` (already captured at line 122).

Also emit on skip paths (secrets detected, chunk limit hit) with `skipped: true`
and `skipReason`.

- [ ] **Step 4: Run tests**

```bash
npx vitest run tests/core/domains/ingest/pipeline/infra/debug-logger.test.ts
```

Expected: PASS.

- [ ] **Step 5: Manual smoke test**

Run a small reindex, grep the log for `FILE_INGESTED` — expect one line per
processed file. Inspect `SUMMARY` block — expect `SLOW_FILES_TOP_20` JSON array
with actual file paths ranked by `parseMs`.

- [ ] **Step 6: Commit**

```bash
git add src/core/domains/ingest/pipeline/infra/debug-logger.ts src/core/domains/ingest/pipeline/file-processor.ts tests/core/domains/ingest/pipeline/infra/debug-logger.test.ts
git commit -m "feat(pipeline): per-file telemetry with top-N slow-file tracker

Emit FILE_INGESTED event per processed file (path, language, bytes,
chunks, parseMs). Aggregate top-20 slowest files in pipelineLog and
include them in SUMMARY block as SLOW_FILES_TOP_20. Enables per-file
diagnostics for indexing performance without grepping batch events."
```

---

## Phase 2 — Surface delete failures (stop silent swallow)

### Task 2.1: Introduce `DeletionOutcome` type

**Files:**

- Create: `src/core/domains/ingest/sync/deletion-outcome.ts`
- Create: `tests/core/domains/ingest/sync/deletion-outcome.test.ts`

- [ ] **Step 1: Write tests first**

```ts
describe("DeletionOutcome", () => {
  it("defaults to all-succeeded for empty input", () => {
    const outcome = createDeletionOutcome([]);
    expect(outcome.succeeded.size).toBe(0);
    expect(outcome.failed.size).toBe(0);
    expect(outcome.isFullSuccess()).toBe(true);
  });

  it("marks specific paths as failed", () => {
    const outcome = createDeletionOutcome(["a.ts", "b.ts", "c.ts"]);
    outcome.markFailed("b.ts");
    expect(outcome.succeeded).toEqual(new Set(["a.ts", "c.ts"]));
    expect(outcome.failed).toEqual(new Set(["b.ts"]));
    expect(outcome.isFullSuccess()).toBe(false);
  });

  it("markAllFailed flips every path to failed", () => {
    const outcome = createDeletionOutcome(["a.ts", "b.ts"]);
    outcome.markAllFailed();
    expect(outcome.succeeded.size).toBe(0);
    expect(outcome.failed.size).toBe(2);
  });
});
```

- [ ] **Step 2: Implement**

```ts
export interface DeletionOutcome {
  readonly succeeded: Set<string>;
  readonly failed: Set<string>;
  markFailed(path: string): void;
  markAllFailed(): void;
  isFullSuccess(): boolean;
  chunksDeleted: number; // filled in at end by performDeletion
}

export function createDeletionOutcome(
  attemptedPaths: string[],
): DeletionOutcome {
  const succeeded = new Set(attemptedPaths);
  const failed = new Set<string>();
  return {
    succeeded,
    failed,
    chunksDeleted: 0,
    markFailed(path) {
      if (succeeded.delete(path)) failed.add(path);
    },
    markAllFailed() {
      for (const p of succeeded) failed.add(p);
      succeeded.clear();
    },
    isFullSuccess() {
      return failed.size === 0;
    },
  };
}
```

- [ ] **Step 3: Run tests, commit**

```bash
npx vitest run tests/core/domains/ingest/sync/deletion-outcome.test.ts
git add src/core/domains/ingest/sync/deletion-outcome.ts tests/core/domains/ingest/sync/deletion-outcome.test.ts
git commit -m "feat(contracts): DeletionOutcome type tracks per-path delete success"
```

---

### Task 2.2: Rewrite `performDeletion` to return `DeletionOutcome`

**Files:**

- Modify: `src/core/domains/ingest/sync/deletion-strategy.ts`
- Modify: `tests/core/domains/ingest/sync/deletion-strategy.test.ts`

**Dependency:** Task 2.1.

**Behaviour change (BREAKING at internal API level):** `performDeletion`
signature changes from `Promise<number>` to `Promise<DeletionOutcome>`. All
callers must be updated (currently only `reindexing.ts:229` and
`reindexing.ts:338`).

- [ ] **Step 1: Update tests to expect new return type**

In `tests/core/domains/ingest/sync/deletion-strategy.test.ts`, replace every
`expect(result).toBe(N)` with assertions on `DeletionOutcome`:

```ts
it("returns outcome with all paths succeeded on happy path", async () => {
  const outcome = await performDeletion(
    qdrant,
    "col",
    ["a.ts", "b.ts"],
    config,
  );
  expect(outcome.isFullSuccess()).toBe(true);
  expect(outcome.succeeded).toEqual(new Set(["a.ts", "b.ts"]));
  expect(outcome.failed.size).toBe(0);
});

it("marks specific paths failed at L2 individual deletion stage", async () => {
  // Make L0 + L1 throw, L2 individual: a.ts succeeds, b.ts throws
  qdrant.deletePointsByPathsBatched = vi
    .fn()
    .mockRejectedValue(new Error("batch boom"));
  qdrant.deletePointsByPaths = vi
    .fn()
    .mockRejectedValue(new Error("bulk boom"));
  qdrant.deletePointsByFilter = vi
    .fn()
    .mockImplementationOnce(() => Promise.resolve()) // a.ts ok
    .mockImplementationOnce(() => Promise.reject(new Error("filter boom"))); // b.ts fails

  const outcome = await performDeletion(
    qdrant,
    "col",
    ["a.ts", "b.ts"],
    config,
  );

  expect(outcome.isFullSuccess()).toBe(false);
  expect(outcome.succeeded).toEqual(new Set(["a.ts"]));
  expect(outcome.failed).toEqual(new Set(["b.ts"]));
});

it("markAllFailed on L1 success still counts all as succeeded (no per-path info at bulk stage)", async () => {
  qdrant.deletePointsByPathsBatched = vi
    .fn()
    .mockRejectedValue(new Error("batch boom"));
  qdrant.deletePointsByPaths = vi.fn().mockResolvedValue(undefined); // bulk succeeded

  const outcome = await performDeletion(
    qdrant,
    "col",
    ["a.ts", "b.ts"],
    config,
  );
  expect(outcome.isFullSuccess()).toBe(true);
});
```

- [ ] **Step 2: Rewrite `performDeletion`**

Replace body (lines 22-117) with:

```ts
export async function performDeletion(
  qdrant: QdrantManager,
  collectionName: string,
  filesToDelete: string[],
  deleteConfig: DeletionConfig,
  progressCallback?: ProgressCallback,
): Promise<DeletionOutcome> {
  const outcome = createDeletionOutcome(filesToDelete);
  if (filesToDelete.length === 0) return outcome;

  const totalBefore = (await qdrant.getCollectionInfo(collectionName)).pointsCount;

  progressCallback?.({ /* unchanged */ });

  try {
    const deleteResult = await qdrant.deletePointsByPathsBatched(collectionName, filesToDelete, {
      batchSize: deleteConfig.batchSize,
      concurrency: deleteConfig.concurrency,
      onProgress: /* unchanged */,
    });
    if (isDebug()) {
      console.error(`[Reindex] Deleted ${deleteResult.deletedPaths} paths...`);
    }
  } catch (error) {
    pipelineLog.fallback({ component: "Reindex" }, 1, `deletePointsByPathsBatched failed: ${String(error)}`);

    try {
      await qdrant.deletePointsByPaths(collectionName, filesToDelete);
      pipelineLog.step({ component: "Reindex" }, "FALLBACK_L1_SUCCESS", { paths: filesToDelete.length });
    } catch (fallbackError) {
      pipelineLog.fallback({ component: "Reindex" }, 2, `deletePointsByPaths failed: ${String(fallbackError)}`);

      let deleted = 0;
      let failed = 0;
      for (const relativePath of filesToDelete) {
        try {
          await qdrant.deletePointsByFilter(collectionName, {
            must: [{ key: "relativePath", match: { value: relativePath } }],
          });
          deleted++;
        } catch {
          outcome.markFailed(relativePath); // <-- THE CRITICAL CHANGE
          failed++;
        }
      }

      pipelineLog.step({ component: "Reindex" }, "FALLBACK_L2_COMPLETE", {
        deleted,
        failed,
        failedPaths: [...outcome.failed].slice(0, 50), // sample for log
      });
    }
  }

  const totalAfter = (await qdrant.getCollectionInfo(collectionName)).pointsCount;
  outcome.chunksDeleted = Math.max(0, totalBefore - totalAfter);
  return outcome;
}
```

Note: `getCollectionInfo().pointsCount` already used per yellow-handling plan
Task 1.6 — keep it here too for consistency.

- [ ] **Step 3: Update callers in `reindexing.ts`**

Line 229 (`executeParallelReindex`):

```ts
const deletePromise = performDeletion(
  this.qdrant,
  ctx.collectionName,
  filesToDelete,
  this.deleteConfig,
  progressCallback,
).then((outcome) => {
  // outcome is passed up through the enclosing scope — store on a captured var
  deletionOutcome = outcome;
  chunksDeleted = outcome.chunksDeleted;
  return outcome;
});
```

Line 338 (`executeDeletionOnly`):

```ts
const outcome = await performDeletion(...);
if (!outcome.isFullSuccess()) {
  // Deletion-only path: surface partial failure as a typed error so caller decides.
  throw new PartialDeletionError(outcome);
}
stats.chunksDeleted = outcome.chunksDeleted;
```

Add new typed error `PartialDeletionError` to
`src/core/domains/ingest/errors.ts`:

```ts
export class PartialDeletionError extends IngestError {
  constructor(public readonly outcome: DeletionOutcome) {
    super({
      code: "INGEST_PARTIAL_DELETION",
      message: `Failed to delete ${outcome.failed.size} of ${outcome.succeeded.size + outcome.failed.size} files`,
      hint: "Rerun reindex to retry, or /tea-rags:force-reindex for full rebuild.",
      httpStatus: 500,
    });
  }
}
```

- [ ] **Step 4: Run test suites**

```bash
npx vitest run tests/core/domains/ingest/sync/
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/core/domains/ingest/sync/deletion-strategy.ts src/core/domains/ingest/reindexing.ts src/core/domains/ingest/errors.ts tests/
git commit -m "fix(ingest): surface per-path delete failures via DeletionOutcome

performDeletion L2 individual-deletion stage used to catch per-file
errors and only log a failed-count. Callers got back a chunks-deleted
number and had no way to know which files silently failed — leading to
orphan chunks when upsert proceeded for files whose old chunks were
never removed (2026-04-23 incident: 52k chunks → 140k peak).

DeletionOutcome tracks succeeded and failed path sets; reindexing.ts
consumes it to drive per-file coordination. Deletion-only path throws
PartialDeletionError on partial failure instead of silently returning."
```

---

## Phase 3 — Per-file barrier (A1)

### Task 3.1: `ReindexCoordinator`

**Files:**

- Create: `src/core/domains/ingest/sync/reindex-coordinator.ts`
- Create: `tests/core/domains/ingest/sync/reindex-coordinator.test.ts`

**Dependency:** Phase 2 (consumes `DeletionOutcome`).

- [ ] **Step 1: Tests**

```ts
describe("ReindexCoordinator", () => {
  it("defaults to allowing all paths (green state, no delete attempted)", () => {
    const c = new ReindexCoordinator();
    expect(c.canUpsertForFile("any/path.ts")).toBe(true);
  });

  it("blocks upsert for paths that failed deletion", () => {
    const c = new ReindexCoordinator();
    const outcome = createDeletionOutcome(["a.ts", "b.ts"]);
    outcome.markFailed("b.ts");
    c.applyDeletionOutcome(outcome);

    expect(c.canUpsertForFile("a.ts")).toBe(true);
    expect(c.canUpsertForFile("b.ts")).toBe(false);
  });

  it("records skipped files for reporting", () => {
    const c = new ReindexCoordinator();
    const outcome = createDeletionOutcome(["a.ts"]);
    outcome.markFailed("a.ts");
    c.applyDeletionOutcome(outcome);

    c.canUpsertForFile("a.ts"); // triggers skip
    expect(c.skippedFiles()).toEqual(["a.ts"]);
  });
});
```

- [ ] **Step 2: Implement**

```ts
export class ReindexCoordinator {
  private readonly blockedPaths = new Set<string>();
  private readonly skipped: string[] = [];

  applyDeletionOutcome(outcome: DeletionOutcome): void {
    for (const failed of outcome.failed) this.blockedPaths.add(failed);
  }

  canUpsertForFile(relativePath: string): boolean {
    if (this.blockedPaths.has(relativePath)) {
      this.skipped.push(relativePath);
      return false;
    }
    return true;
  }

  skippedFiles(): readonly string[] {
    return [...this.skipped];
  }

  hasBlockedPaths(): boolean {
    return this.blockedPaths.size > 0;
  }
}
```

- [ ] **Step 3: Commit**

```bash
git add src/core/domains/ingest/sync/reindex-coordinator.ts tests/
git commit -m "feat(ingest): ReindexCoordinator gates upsert on delete success per file"
```

---

### Task 3.2: Wire coordinator into reindex + file-processor

**Files:**

- Modify: `src/core/domains/ingest/reindexing.ts`
- Modify: `src/core/domains/ingest/pipeline/file-processor.ts`
- Modify: `src/core/domains/ingest/pipeline/types.ts` (thread coordinator
  through `FileProcessorOptions`)
- Test: `tests/core/domains/ingest/pipeline/file-processor.test.ts`,
  `tests/core/domains/ingest/reindexing.test.ts`

- [ ] **Step 1: Thread coordinator through options**

Extend `FileProcessorOptions`:

```ts
export interface FileProcessorOptions {
  // ... existing fields ...
  coordinator?: ReindexCoordinator;
}
```

- [ ] **Step 2: Gate `addChunk` in file-processor**

In `processFiles` (file-processor.ts:108-190), before the
`for (const chunk of chunksToAdd)` loop:

```ts
if (
  options.coordinator &&
  !options.coordinator.canUpsertForFile(relativePath)
) {
  pipelineLog.step(LOG_CTX, "FILE_SKIPPED_DELETE_FAILED", {
    path: relativePath,
  });
  return; // skip this entire file — its old chunks still live in Qdrant
}
```

This runs only for modified-files pass. Added-files pass doesn't set coordinator
(no old chunks to collide).

- [ ] **Step 3: Wire in `reindexing.ts:executeParallelReindex`**

```ts
const coordinator = new ReindexCoordinator();

const deletePromise = performDeletion(...).then((outcome) => {
  coordinator.applyDeletionOutcome(outcome);
  deletionOutcome = outcome;
  chunksDeleted = outcome.chunksDeleted;
});

// addedFiles: no coordinator (new files, no old chunks)
const addPromise = processRelativeFiles(addedFiles, ..., processOpts, chunkMap, "added");

await deletePromise; // barrier: coordinator is now populated

// modifiedFiles: coordinator gates upsert per-file
const modifiedOpts = { ...processOpts, coordinator };
const modifiedPromise = processRelativeFiles(modifiedFiles, ..., modifiedOpts, chunkMap, "modified");
```

- [ ] **Step 4: Log skipped files count at end**

After `ADD_AND_MODIFIED_COMPLETE`:

```ts
if (coordinator.hasBlockedPaths()) {
  const skipped = coordinator.skippedFiles();
  pipelineLog.step(LOG_CTX, "REINDEX_PARTIAL_COMPLETE", {
    skippedFilesCount: skipped.length,
    skippedSample: skipped.slice(0, 20),
  });
  stats.filesSkippedDueToDeleteFailure = skipped.length;
}
```

Extend `ChangeStats` DTO with optional
`filesSkippedDueToDeleteFailure?: number`.

- [ ] **Step 5: Tests**

Two new integration-style tests:

```ts
it("modified files whose delete failed are skipped from upsert", async () => {
  // Mock deletion to fail for b.ts
  // Run executeParallelReindex with modified=[a.ts, b.ts]
  // Assert: chunkPipeline.addChunk called only with a.ts chunks
  // Assert: stats.filesSkippedDueToDeleteFailure === 1
});

it("added files are always processed regardless of coordinator state", async () => {
  // Even if coordinator has blockedPaths for modified set,
  // added files pass goes through untouched.
});
```

- [ ] **Step 6: Commit**

```bash
git add src/core/domains/ingest/reindexing.ts src/core/domains/ingest/pipeline/file-processor.ts src/core/domains/ingest/pipeline/types.ts tests/
git commit -m "fix(ingest): gate modified-file upsert on successful delete via coordinator

ReindexCoordinator is populated from DeletionOutcome after deletePromise
resolves. For each modified file, file-processor consults coordinator
before chunking/adding chunks — files whose delete failed are skipped
entirely (their old chunks remain, marked stale for next run). Added
files are never gated (no old chunks to collide with).

Eliminates the 2026-04-23 orphan-duplication class of bugs: delete-fail
no longer causes parallel upsert to double-populate the collection."
```

---

## Phase 4 — Adaptive upsert batch sizing (D2)

### Task 4.1: `AdaptiveBatchSizer`

**Files:**

- Create: `src/core/domains/ingest/pipeline/adaptive-batch-sizer.ts`
- Create: `tests/core/domains/ingest/pipeline/adaptive-batch-sizer.test.ts`

**Dependency:** `QdrantOptimizationInProgressError` from yellow-handling plan
(Task 1.1). If that plan hasn't merged, block this Task until it does.

- [ ] **Step 1: Tests**

```ts
describe("AdaptiveBatchSizer", () => {
  it("starts at configured batch size", () => {
    const sizer = new AdaptiveBatchSizer({
      initial: 512,
      min: 32,
      recoveryThreshold: 5,
    });
    expect(sizer.current()).toBe(512);
  });

  it("halves on yellow error, floors at min", () => {
    const sizer = new AdaptiveBatchSizer({
      initial: 512,
      min: 32,
      recoveryThreshold: 5,
    });
    sizer.onFailure(new QdrantOptimizationInProgressError("col"));
    expect(sizer.current()).toBe(256);
    sizer.onFailure(new QdrantOptimizationInProgressError("col"));
    expect(sizer.current()).toBe(128);
    // Continue until floor
    sizer.onFailure(new QdrantOptimizationInProgressError("col"));
    sizer.onFailure(new QdrantOptimizationInProgressError("col"));
    expect(sizer.current()).toBe(32);
    sizer.onFailure(new QdrantOptimizationInProgressError("col"));
    expect(sizer.current()).toBe(32); // floored
  });

  it("doubles after N consecutive successes, caps at initial", () => {
    const sizer = new AdaptiveBatchSizer({
      initial: 512,
      min: 32,
      recoveryThreshold: 3,
    });
    sizer.onFailure(new QdrantOptimizationInProgressError("col")); // 256
    sizer.onSuccess();
    sizer.onSuccess(); // still 256
    sizer.onSuccess(); // 512 after 3rd success
    expect(sizer.current()).toBe(512);
    sizer.onSuccess();
    sizer.onSuccess();
    sizer.onSuccess();
    expect(sizer.current()).toBe(512); // capped at initial
  });

  it("ignores non-yellow errors (doesn't adjust)", () => {
    const sizer = new AdaptiveBatchSizer({
      initial: 512,
      min: 32,
      recoveryThreshold: 3,
    });
    sizer.onFailure(new Error("random"));
    expect(sizer.current()).toBe(512);
  });
});
```

- [ ] **Step 2: Implement**

```ts
export interface AdaptiveBatchSizerConfig {
  initial: number;
  min: number;
  recoveryThreshold: number;
}

export class AdaptiveBatchSizer {
  private size: number;
  private consecutiveSuccesses = 0;

  constructor(private readonly config: AdaptiveBatchSizerConfig) {
    this.size = config.initial;
  }

  current(): number {
    return this.size;
  }

  onSuccess(): void {
    this.consecutiveSuccesses++;
    if (
      this.consecutiveSuccesses >= this.config.recoveryThreshold &&
      this.size < this.config.initial
    ) {
      this.size = Math.min(this.config.initial, this.size * 2);
      this.consecutiveSuccesses = 0;
    }
  }

  onFailure(error: unknown): void {
    if (!(error instanceof QdrantOptimizationInProgressError)) return;
    this.size = Math.max(this.config.min, Math.floor(this.size / 2));
    this.consecutiveSuccesses = 0;
  }
}
```

- [ ] **Step 3: Commit**

```bash
git add src/core/domains/ingest/pipeline/adaptive-batch-sizer.ts tests/
git commit -m "feat(pipeline): AdaptiveBatchSizer halves upsert batch on Qdrant yellow"
```

---

### Task 4.2: Integrate sizer into `ChunkPipeline`

**Files:**

- Modify: `src/core/domains/ingest/pipeline/chunk-pipeline.ts`
- Test: `tests/core/domains/ingest/pipeline/chunk-pipeline.test.ts`

- [ ] **Step 1: Instantiate sizer in pipeline constructor**

```ts
this.batchSizer = new AdaptiveBatchSizer({
  initial: config.upsertBatchSize,
  min: Math.max(32, Math.floor(config.upsertBatchSize / 16)),
  recoveryThreshold: 5,
});
```

- [ ] **Step 2: Read current size in batch-accumulator**

Wherever `ChunkPipeline` currently reads `this.config.upsertBatchSize` to decide
when to flush a batch, replace with `this.batchSizer.current()`.

- [ ] **Step 3: Report to sizer in upsert retry path**

In the BATCH retry loop (search for `BATCH_FAILED` emit site in
`chunk-pipeline.ts`), wrap the upsert call:

```ts
try {
  await this.qdrant.addPointsWithSparse(...);
  this.batchSizer.onSuccess();
} catch (error) {
  this.batchSizer.onFailure(error);
  throw error; // existing retry logic continues
}
```

- [ ] **Step 4: Emit sizer state transitions in log**

Add a `BATCH_SIZE_ADJUSTED` event whenever `sizer.current()` changes:

```ts
const before = this.batchSizer.current();
this.batchSizer.onFailure(error);
const after = this.batchSizer.current();
if (before !== after) {
  pipelineLog.step(LOG_CTX, "BATCH_SIZE_ADJUSTED", {
    from: before,
    to: after,
    reason: "yellow",
  });
}
```

- [ ] **Step 5: Integration test**

```ts
it("halves batch size after repeated yellow failures", async () => {
  const pipeline = makeChunkPipeline({ upsertBatchSize: 512 });
  mockQdrant.addPointsWithSparse
    .mockRejectedValueOnce(new QdrantOptimizationInProgressError("col"))
    .mockResolvedValue(undefined);

  await pipeline.flushAll();

  // Expect batch-size adjustment event in log
  expect(pipelineLog.events()).toContainEqual(
    expect.objectContaining({
      name: "BATCH_SIZE_ADJUSTED",
      data: { from: 512, to: 256, reason: "yellow" },
    }),
  );
});
```

- [ ] **Step 6: Commit**

```bash
git add src/core/domains/ingest/pipeline/chunk-pipeline.ts tests/
git commit -m "feat(pipeline): ChunkPipeline reduces upsert batch size on Qdrant yellow

Dynamic backoff on QdrantOptimizationInProgressError — batch halves each
yellow failure (floor: 1/16 of initial), doubles back after 5 consecutive
successes (cap: initial). BATCH_SIZE_ADJUSTED events surface transitions
in the pipeline log."
```

---

## Phase 5 — Enrichment status recovery (E)

### Task 5.1: Reset stale `in_progress` on pipeline start

**Files:**

- Modify: `src/core/domains/ingest/pipeline/status-module.ts`
- Test: `tests/core/domains/ingest/pipeline/status-module.test.ts`

**Observation:** `get_index_status` currently shows
`enrichment.status=in_progress` with `completedAt < startedAt` long after a
crash. Status module reads payload marker but doesn't recover.

- [ ] **Step 1: Test**

```ts
describe("StatusModule stale in_progress recovery", () => {
  it("resets in_progress to 'failed' if startedAt age > staleThreshold and no completedAt", async () => {
    const ageMs = 2 * 60 * 60 * 1000; // 2 hours
    mockMarker.get.mockResolvedValue({
      enrichment: {
        status: "in_progress",
        startedAt: new Date(Date.now() - ageMs).toISOString(),
      },
    });

    const status = await statusModule.readStatus();

    expect(status.enrichment.status).toBe("failed");
    expect(status.enrichment.recoveryReason).toContain("stale in_progress");
    expect(mockMarker.update).toHaveBeenCalledWith(
      expect.objectContaining({
        enrichment: expect.objectContaining({ status: "failed" }),
      }),
    );
  });

  it("leaves in_progress alone if within threshold (active pipeline)", async () => {
    mockMarker.get.mockResolvedValue({
      enrichment: {
        status: "in_progress",
        startedAt: new Date().toISOString(),
      },
    });
    const status = await statusModule.readStatus();
    expect(status.enrichment.status).toBe("in_progress");
  });
});
```

- [ ] **Step 2: Implement recovery**

In `status-module.ts` where marker is read:

```ts
const STALE_IN_PROGRESS_MS = 60 * 60 * 1000; // 1 hour

function recoverStaleInProgress(marker: IndexingMarker): IndexingMarker {
  if (
    marker.enrichment?.status === "in_progress" &&
    marker.enrichment.startedAt &&
    Date.now() - new Date(marker.enrichment.startedAt).getTime() >
      STALE_IN_PROGRESS_MS
  ) {
    return {
      ...marker,
      enrichment: {
        ...marker.enrichment,
        status: "failed",
        recoveryReason: "stale in_progress (exceeded recovery threshold)",
      },
    };
  }
  return marker;
}
```

Call before returning the status DTO; persist the corrected marker via
`markerCodec.update`.

Extend `IndexingMarker.enrichment` type with optional `recoveryReason?: string`.

- [ ] **Step 3: Commit**

```bash
git add src/core/domains/ingest/pipeline/status-module.ts src/core/domains/ingest/pipeline/indexing-marker.ts tests/
git commit -m "fix(ingest): recover stale enrichment.in_progress flag on status read

If enrichment.status is in_progress and startedAt is older than 1h with
no completedAt, flip to 'failed' with recoveryReason so get_index_status
reports accurately after a crash. Previously the flag stayed stuck
in_progress indefinitely."
```

---

## Beads Sync (before execution starts)

Per `.claude/rules/.local/plan-beads-sync.md`:

- [ ] **Create epic**

```bash
bd create --title="Epic: Reindex resilience (delete-upsert race)" \
  --description="Fix orphan-chunk duplication from 2026-04-23 incident. Per-file telemetry, DeletionOutcome, ReindexCoordinator barrier, adaptive batch sizing, enrichment flag recovery. Plan: docs/superpowers/plans/2026-04-23-reindex-resilience.md" \
  --type=feature --priority=1
# Capture returned id as $EPIC
bd label add $EPIC architecture
bd label add $EPIC bugfix
```

- [ ] **Create task per plan section**

Tasks (in order, P1 for bugfix core, P2 for observability + polish):

| Plan Task | Title                                                         | Labels                | Priority |
| --------- | ------------------------------------------------------------- | --------------------- | -------- |
| 1.1       | Per-file FILE_INGESTED telemetry + SlowFileTracker            | dx, metrics           | P2       |
| 2.1       | DeletionOutcome type                                          | api, bugfix           | P1       |
| 2.2       | performDeletion returns DeletionOutcome (stop silent swallow) | bugfix, ingest        | P1       |
| 3.1       | ReindexCoordinator class                                      | architecture, bugfix  | P1       |
| 3.2       | Wire coordinator into reindex + file-processor                | bugfix, ingest        | P1       |
| 4.1       | AdaptiveBatchSizer class                                      | performance, pipeline | P2       |
| 4.2       | Integrate AdaptiveBatchSizer into ChunkPipeline               | performance, pipeline | P2       |
| 5.1       | Recover stale enrichment.in_progress flag                     | bugfix, dx            | P2       |

- [ ] **Link dependencies**

```bash
bd dep add <task2.2> <task2.1>
bd dep add <task3.1> <task2.1>
bd dep add <task3.2> <task3.1>
bd dep add <task3.2> <task2.2>
bd dep add <task4.1> <yellow-handling-task-1.1>   # CROSS-PLAN
bd dep add <task4.2> <task4.1>
# Link all to epic:
for id in <task ids>; do bd dep add $id $EPIC; done
```

Phase 5 (Task 5.1) has no dependencies — can run first or in parallel.

---

## Execution order (single track)

Recommended sequence for executing-plans subagent:

1. Phase 5 Task 5.1 (independent, lowest risk, immediate UX win)
2. Phase 1 Task 1.1 (observability baseline for everything else)
3. Phase 2 Task 2.1 → 2.2 (stop the bleed)
4. Phase 3 Task 3.1 → 3.2 (eliminate the race — THIS IS THE MAIN FIX)
5. Phase 4 Task 4.1 → 4.2 (defence in depth; requires yellow-handling Task 1.1
   merged)

After Phase 3: orphan duplication is impossible regardless of Qdrant health.
Phase 4 reduces probability of triggering the scenario in the first place.

---

## Session close

- [ ] `git status` — clean tree
- [ ] `bd close` all completed tasks
- [ ] `bd close $EPIC`
- [ ] Do NOT push — ephemeral branch, requires explicit user request per project
      rules.

---

## Execution choice

**Plan saved to `docs/superpowers/plans/2026-04-23-reindex-resilience.md`.**

Two execution options:

1. **Subagent-Driven** — dispatch a fresh subagent per Task, review between.
   Uses `dinopowers:subagent-driven-development`.
2. **Inline Execution** — execute Tasks in this session using
   `dinopowers:executing-plans`.

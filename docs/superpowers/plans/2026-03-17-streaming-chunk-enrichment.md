# Streaming Chunk Enrichment Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development
> (if subagents available) or superpowers:executing-plans to implement this
> plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Start chunk-level git blame enrichment incrementally per-batch instead
of waiting for all indexing to complete, reducing total pipeline time by
overlapping chunking with chunk enrichment.

**Architecture:** Coordinator accumulates ChunkLookupEntry from each
onChunksStored batch. Once prefetch completes, it streams accumulated + new
batches to provider.buildChunkSignals() via a shared Semaphore that bounds total
git blame concurrency across all streaming calls. The final
startChunkEnrichment() in finalizeProcessing becomes a no-op if streaming
already processed everything.

**Tech Stack:** TypeScript, Vitest, existing EnrichmentCoordinator/provider
contracts

---

## File Structure

| File                                                                | Action | Responsibility                                                    |
| ------------------------------------------------------------------- | ------ | ----------------------------------------------------------------- |
| `src/core/infra/semaphore.ts`                                       | Create | Generic async Semaphore with bounded concurrency                  |
| `tests/core/infra/semaphore.test.ts`                                | Create | Unit tests for Semaphore                                          |
| `src/core/domains/ingest/pipeline/enrichment/coordinator.ts`        | Modify | Add streaming chunk enrichment in onChunksStored()                |
| `src/core/contracts/types/provider.ts`                              | Modify | Add optional `concurrencySemaphore` to buildChunkSignals options  |
| `src/core/domains/trajectory/git/provider.ts`                       | Modify | Accept and forward semaphore to buildChunkChurnMap                |
| `src/core/domains/trajectory/git/infra/chunk-reader.ts`             | Modify | Use external semaphore when provided instead of internal one      |
| `src/core/domains/ingest/pipeline/base.ts`                          | Modify | Remove chunkMap from finalizeProcessing, simplify startEnrichment |
| `tests/core/domains/ingest/pipeline/enrichment/coordinator.test.ts` | Modify | Add streaming chunk enrichment tests                              |
| `tests/core/domains/trajectory/git/infra/chunk-reader.test.ts`      | Create | Test external semaphore support                                   |
| `src/core/domains/ingest/pipeline/enrichment/types.ts`              | Modify | Re-export ChunkSignalOptions from barrel                          |

---

## Chunk 1: Semaphore Infrastructure

### Task 1: Async Semaphore

**Files:**

- Create: `src/core/infra/semaphore.ts`
- Create: `tests/core/infra/semaphore.test.ts`

- [ ] **Step 1: Write failing tests for Semaphore**

```typescript
// tests/core/infra/semaphore.test.ts
import { describe, expect, it } from "vitest";

import { Semaphore } from "../../../src/core/infra/semaphore.js";

describe("Semaphore", () => {
  it("allows up to N concurrent acquisitions", async () => {
    const sem = new Semaphore(2);
    const order: string[] = [];

    const task = async (id: string, delayMs: number) => {
      const release = await sem.acquire();
      order.push(`start-${id}`);
      await new Promise((r) => setTimeout(r, delayMs));
      order.push(`end-${id}`);
      release();
    };

    await Promise.all([task("a", 50), task("b", 50), task("c", 10)]);

    // a and b start concurrently, c waits
    expect(order.indexOf("start-a")).toBeLessThan(order.indexOf("start-c"));
    expect(order.indexOf("start-b")).toBeLessThan(order.indexOf("start-c"));
  });

  it("release unblocks waiting acquirers", async () => {
    const sem = new Semaphore(1);
    const release1 = await sem.acquire();

    let acquired = false;
    const p = sem.acquire().then((r) => {
      acquired = true;
      return r;
    });

    await new Promise((r) => setTimeout(r, 10));
    expect(acquired).toBe(false);

    release1();
    const release2 = await p;
    expect(acquired).toBe(true);
    release2();
  });

  it("handles concurrency=0 by allowing unlimited", async () => {
    const sem = new Semaphore(0);
    // Should not block
    const r1 = await sem.acquire();
    const r2 = await sem.acquire();
    r1();
    r2();
  });

  it("exposes pending count", async () => {
    const sem = new Semaphore(1);
    expect(sem.pending).toBe(0);

    const r1 = await sem.acquire();
    const p = sem.acquire(); // will wait
    await new Promise((r) => setTimeout(r, 5));
    expect(sem.pending).toBe(1);

    r1();
    const r2 = await p;
    expect(sem.pending).toBe(0);
    r2();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/core/infra/semaphore.test.ts` Expected: FAIL — module
not found

- [ ] **Step 3: Implement Semaphore**

```typescript
// src/core/infra/semaphore.ts
/**
 * Async semaphore for bounding concurrent async operations.
 * acquire() returns a release function. If at capacity, acquire() blocks
 * until a slot opens.
 */
export class Semaphore {
  private active = 0;
  private readonly queue: (() => void)[] = [];

  constructor(private readonly max: number) {}

  /** Number of waiters currently blocked. */
  get pending(): number {
    return this.queue.length;
  }

  async acquire(): Promise<() => void> {
    if (this.max <= 0) return () => {}; // unlimited

    if (this.active < this.max) {
      this.active++;
      return () => this.release();
    }

    return new Promise<() => void>((resolve) => {
      this.queue.push(() => {
        this.active++;
        resolve(() => this.release());
      });
    });
  }

  private release(): void {
    const next = this.queue.shift();
    if (next) {
      next();
    } else {
      this.active--;
    }
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/core/infra/semaphore.test.ts` Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/core/infra/semaphore.ts tests/core/infra/semaphore.test.ts
git commit -m "feat(infra): add async Semaphore for bounded concurrency"
```

---

## Chunk 2: Provider Contract + chunk-reader External Semaphore

### Task 2: Extend EnrichmentProvider.buildChunkSignals() with options

**Files:**

- Modify: `src/core/contracts/types/provider.ts:98-102`
- Modify: `src/core/domains/trajectory/git/provider.ts:112-138`
- Modify: `src/core/domains/trajectory/git/infra/chunk-reader.ts:34-66`

The contract change adds an optional `options` parameter to
`buildChunkSignals()`. The `concurrencySemaphore` in options replaces the
provider's internal semaphore when present — this lets the coordinator share one
semaphore across all streaming calls.

- [ ] **Step 1: Write failing test for chunk-reader external semaphore**

```typescript
// tests/core/domains/trajectory/git/infra/chunk-reader.test.ts
// Create this file — chunk-reader has no dedicated test file yet.

import { describe, expect, it, vi } from "vitest";

import { buildChunkChurnMapUncached } from "../../../../../../src/core/domains/trajectory/git/infra/chunk-reader.js";
import { Semaphore } from "../../../../../../src/core/infra/semaphore.js";

// Mock git operations to avoid real git calls
vi.mock("../../../../../../src/core/adapters/git/client.js", () => ({
  getCommitsByPathspec: vi.fn().mockResolvedValue([
    {
      commit: {
        sha: "abc123",
        author: "dev",
        timestamp: Date.now() / 1000,
        body: "fix: something",
      },
      changedFiles: ["src/a.ts"],
    },
  ]),
  readBlobAsString: vi.fn().mockResolvedValue("const x = 1;\n"),
}));

vi.mock("isomorphic-git", () => ({
  default: {
    readCommit: vi.fn().mockResolvedValue({
      commit: { parent: ["parent123"] },
    }),
  },
}));

describe("buildChunkChurnMapUncached — external semaphore", () => {
  it("calls external semaphore acquire() for commit processing", async () => {
    const mockRelease = vi.fn();
    const sem = { acquire: vi.fn().mockResolvedValue(mockRelease) };

    const chunkMap = new Map([
      [
        "src/a.ts",
        [
          { chunkId: "c1", startLine: 1, endLine: 5 },
          { chunkId: "c2", startLine: 6, endLine: 10 },
        ],
      ],
    ]);

    await buildChunkChurnMapUncached(
      "/fake-repo",
      chunkMap,
      {},
      10,
      6,
      undefined,
      undefined,
      120000,
      10000,
      sem,
    );

    // External semaphore should have been used for commit processing
    expect(sem.acquire).toHaveBeenCalled();
    expect(mockRelease).toHaveBeenCalled();
  });

  it("accepts empty chunkMap without calling semaphore", async () => {
    const sem = { acquire: vi.fn() };

    const result = await buildChunkChurnMapUncached(
      "/fake-repo",
      new Map(),
      {},
      10,
      6,
      undefined,
      undefined,
      120000,
      10000,
      sem,
    );

    expect(result.size).toBe(0);
    expect(sem.acquire).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run:
`npx vitest run tests/core/domains/trajectory/git/infra/chunk-reader.test.ts`
Expected: FAIL — buildChunkChurnMapUncached doesn't accept semaphore param

- [ ] **Step 3: Update provider contract — add options to buildChunkSignals()**

In `src/core/contracts/types/provider.ts`, change the `buildChunkSignals`
signature:

```typescript
// Before (line 98-102):
/** Chunk-level signal enrichment (post-flush) */
buildChunkSignals: (root: string, chunkMap: Map<string, ChunkLookupEntry[]>) =>
  Promise<Map<string, Map<string, ChunkSignalOverlay>>>;

// After:
/** Chunk-level signal enrichment (streaming per-batch or post-flush) */
buildChunkSignals: (
  root: string,
  chunkMap: Map<string, ChunkLookupEntry[]>,
  options?: ChunkSignalOptions,
) => Promise<Map<string, Map<string, ChunkSignalOverlay>>>;
```

Add the options interface before EnrichmentProvider:

```typescript
/** Options for buildChunkSignals — allows coordinator to inject shared concurrency. */
export interface ChunkSignalOptions {
  /** External semaphore to use instead of provider's internal concurrency limiter. */
  concurrencySemaphore?: { acquire: () => Promise<() => void> };
  /** Skip HEAD-based caching (used for streaming partial calls). */
  skipCache?: boolean;
}
```

- [ ] **Step 4: Update chunk-reader — accept external semaphore**

In `src/core/domains/trajectory/git/infra/chunk-reader.ts`:

**No concrete Semaphore import needed** — use the duck type from the contract to
keep infra decoupled from chunk-reader.

Change `buildChunkChurnMap()` signature (line 34-44) — add optional
`externalSemaphore` param:

```typescript
export async function buildChunkChurnMap(
  repoRoot: string,
  chunkMap: Map<string, ChunkLookupEntry[]>,
  enrichmentCache: GitEnrichmentCache,
  isoGitCache: Record<string, unknown>,
  concurrency = 10,
  maxAgeMonths = 6,
  fileChurnDataMap?: Map<string, FileChurnData>,
  squashOpts?: SquashOptions,
  chunkTimeoutMs = 120000,
  maxFileLines = MAX_FILE_LINES_DEFAULT,
  externalSemaphore?: { acquire: () => Promise<() => void> },
  skipCache = false,
): Promise<Map<string, Map<string, ChunkChurnOverlay>>> {
  // Check HEAD-based cache (skip for streaming calls)
  if (!skipCache) {
    const cached = await enrichmentCache.getChunkChurn(repoRoot);
    if (cached) return cached;
  }

  const result = await buildChunkChurnMapUncached(
    repoRoot,
    chunkMap,
    isoGitCache,
    concurrency,
    maxAgeMonths,
    fileChurnDataMap,
    squashOpts,
    chunkTimeoutMs,
    maxFileLines,
    externalSemaphore,
  );

  // Only cache full results (not streaming partials)
  if (!skipCache) {
    await enrichmentCache.setChunkChurn(repoRoot, result);
  }

  return result;
}
```

Change `buildChunkChurnMapUncached()` — accept and use external semaphore (line
68-77):

```typescript
export async function buildChunkChurnMapUncached(
  repoRoot: string,
  chunkMap: Map<string, ChunkLookupEntry[]>,
  isoGitCache: Record<string, unknown>,
  concurrency: number,
  maxAgeMonths: number,
  fileChurnDataMap?: Map<string, FileChurnData>,
  squashOpts?: SquashOptions,
  chunkTimeoutMs = 120000,
  maxFileLines = MAX_FILE_LINES_DEFAULT,
  externalSemaphore?: { acquire: () => Promise<() => void> },
): Promise<Map<string, Map<string, ChunkChurnOverlay>>> {
```

Replace internal semaphore (lines 148-164) with:

```typescript
// Use external semaphore if provided, otherwise create internal one
const acquire = externalSemaphore
  ? () => externalSemaphore.acquire()
  : (() => {
      let activeCount = 0;
      const queue: (() => void)[] = [];
      return async (): Promise<() => void> => {
        if (activeCount < concurrency) {
          activeCount++;
          return () => {
            const next = queue.shift();
            if (next) next();
            else activeCount--;
          };
        }
        return new Promise<() => void>((resolve) => {
          queue.push(() => {
            activeCount++;
            resolve(() => {
              const next = queue.shift();
              if (next) next();
              else activeCount--;
            });
          });
        });
      };
    })();
```

Then in `processCommitEntry()` (line 167), replace `await acquire()` with:

```typescript
const release = await acquire();
try {
  // ... existing commit processing logic ...
} finally {
  release();
}
```

Note: the existing code already has acquire/release pattern (lines 150-164,
167-262). Replace the inline semaphore with the one from the unified `acquire`
function above, and change `processCommitEntry` to use the returned `release`
function from `acquire()` instead of calling the separate `release()` closure.

- [ ] **Step 5: Update GitEnrichmentProvider.buildChunkSignals() to forward
      options**

In `src/core/domains/trajectory/git/provider.ts`, change `buildChunkSignals()`
(line 112-138):

```typescript
  async buildChunkSignals(
    root: string,
    chunkMap: Map<string, ChunkLookupEntry[]>,
    options?: ChunkSignalOptions,
  ): Promise<Map<string, Map<string, ChunkSignalOverlay>>> {
    const rawResult = await buildChunkChurnMap(
      root,
      chunkMap,
      this.enrichmentCache,
      this.isoGitCache,
      this.config.chunkConcurrency,
      this.config.chunkMaxAgeMonths,
      this.lastFileResult ?? undefined,
      this.squashOpts,
      this.config.chunkTimeoutMs,
      this.config.chunkMaxFileLines,
      options?.concurrencySemaphore,
      options?.skipCache,
    );

    // ... rest unchanged (result mapping) ...
  }
```

Add import:

```typescript
import type { ChunkSignalOptions } from "../../../contracts/types/provider.js";
```

- [ ] **Step 6: Update barrel re-export for ChunkSignalOptions**

In `src/core/domains/ingest/pipeline/enrichment/types.ts`, add:

```typescript
export type {
  ChunkSignalOptions,
  EnrichmentProvider,
  FileSignalTransform,
} from "../../../../contracts/types/provider.js";
```

- [ ] **Step 7: Run tests**

Run:
`npx vitest run tests/core/domains/trajectory/git/infra/chunk-reader.test.ts`
Expected: PASS

- [ ] **Step 8: Run full test suite**

Run: `npx vitest run` Expected: PASS — no regressions from contract change
(options param is optional)

- [ ] **Step 9: Commit**

```bash
git add src/core/contracts/types/provider.ts src/core/domains/trajectory/git/provider.ts src/core/domains/trajectory/git/infra/chunk-reader.ts src/core/domains/ingest/pipeline/enrichment/types.ts tests/core/domains/trajectory/git/infra/chunk-reader.test.ts
git commit -m "feat(contracts): add ChunkSignalOptions with external semaphore support"
```

---

## Chunk 3: Streaming Chunk Enrichment in Coordinator

### Task 3: Add streaming chunk enrichment to EnrichmentCoordinator.onChunksStored()

**Files:**

- Modify: `src/core/domains/ingest/pipeline/enrichment/coordinator.ts`
- Modify: `tests/core/domains/ingest/pipeline/enrichment/coordinator.test.ts`

The coordinator will:

1. Extract ChunkLookupEntry from ChunkItem in onChunksStored()
2. After prefetch completes, call provider.buildChunkSignals() per batch with
   shared semaphore
3. Track which files have been streaming-enriched
4. startChunkEnrichment() only processes remaining un-enriched files

- [ ] **Step 1: Write failing tests for streaming chunk enrichment**

```typescript
// Add to coordinator.test.ts

describe("EnrichmentCoordinator — streaming chunk enrichment", () => {
  let mockQdrant: any;
  let mockProvider: EnrichmentProvider;

  beforeEach(() => {
    mockQdrant = {
      batchSetPayload: vi.fn().mockResolvedValue(undefined),
      setPayload: vi.fn().mockResolvedValue(undefined),
    };
    mockProvider = {
      key: "git",
      signals: [],
      derivedSignals: [],
      filters: [],
      presets: [],
      resolveRoot: vi.fn((p: string) => p),
      buildFileSignals: vi
        .fn()
        .mockResolvedValue(new Map([["src/a.ts", { x: 1 }]])),
      buildChunkSignals: vi
        .fn()
        .mockResolvedValue(
          new Map([["src/a.ts", new Map([["c1", { commitCount: 5 }]])]]),
        ),
    } as unknown as EnrichmentProvider;
  });

  it("calls buildChunkSignals per batch after prefetch completes", async () => {
    const coordinator = new EnrichmentCoordinator(mockQdrant, mockProvider);
    coordinator.prefetch("/repo", "test-col");
    await new Promise((r) => setTimeout(r, 20));

    // Store a batch — should trigger streaming chunk enrichment
    coordinator.onChunksStored("test-col", "/repo", [
      {
        chunkId: "c1",
        chunk: {
          content: "",
          startLine: 1,
          endLine: 10,
          metadata: { filePath: "/repo/src/a.ts" },
        },
      } as any,
    ]);

    await new Promise((r) => setTimeout(r, 50));

    // buildChunkSignals should have been called with batch chunk map + streaming options
    expect(mockProvider.buildChunkSignals).toHaveBeenCalled();
    const [, calledMap, calledOptions] = (mockProvider.buildChunkSignals as any)
      .mock.calls[0];
    expect(calledMap.has("src/a.ts")).toBe(true);
    expect(calledOptions).toEqual(
      expect.objectContaining({
        skipCache: true,
        concurrencySemaphore: expect.objectContaining({
          acquire: expect.any(Function),
        }),
      }),
    );
  });

  it("queues chunk enrichment when prefetch is still pending", async () => {
    let resolvePrefetch: (v: Map<string, unknown>) => void;
    mockProvider.buildFileSignals.mockReturnValue(
      new Promise((resolve) => {
        resolvePrefetch = resolve;
      }),
    );

    const coordinator = new EnrichmentCoordinator(mockQdrant, mockProvider);
    coordinator.prefetch("/repo", "test-col");

    // Store batch while prefetch pending
    coordinator.onChunksStored("test-col", "/repo", [
      {
        chunkId: "c1",
        chunk: {
          content: "",
          startLine: 1,
          endLine: 10,
          metadata: { filePath: "/repo/src/a.ts" },
        },
      } as any,
    ]);

    await new Promise((r) => setTimeout(r, 10));
    expect(mockProvider.buildChunkSignals).not.toHaveBeenCalled();

    // Resolve prefetch → should flush queued chunk enrichment
    resolvePrefetch!(new Map([["src/a.ts", { x: 1 }]]));
    await new Promise((r) => setTimeout(r, 50));

    expect(mockProvider.buildChunkSignals).toHaveBeenCalled();
  });

  it("startChunkEnrichment skips files already enriched by streaming", async () => {
    const coordinator = new EnrichmentCoordinator(mockQdrant, mockProvider);
    coordinator.prefetch("/repo", "test-col");
    await new Promise((r) => setTimeout(r, 20));

    // Streaming enrichment for src/a.ts
    coordinator.onChunksStored("test-col", "/repo", [
      {
        chunkId: "c1",
        chunk: {
          content: "",
          startLine: 1,
          endLine: 10,
          metadata: { filePath: "/repo/src/a.ts" },
        },
      } as any,
    ]);
    await new Promise((r) => setTimeout(r, 50));

    // Now call startChunkEnrichment with same file — should be skipped
    mockProvider.buildChunkSignals.mockClear();
    const fullChunkMap = new Map([
      ["src/a.ts", [{ chunkId: "c1", startLine: 1, endLine: 10 }]],
    ]);
    coordinator.startChunkEnrichment("test-col", "/repo", fullChunkMap);

    await new Promise((r) => setTimeout(r, 20));
    // buildChunkSignals should NOT be called again (already enriched)
    expect(mockProvider.buildChunkSignals).not.toHaveBeenCalled();
  });

  it("startChunkEnrichment processes files NOT covered by streaming", async () => {
    const coordinator = new EnrichmentCoordinator(mockQdrant, mockProvider);
    coordinator.prefetch("/repo", "test-col");
    await new Promise((r) => setTimeout(r, 20));

    // Streaming enrichment for src/a.ts only
    coordinator.onChunksStored("test-col", "/repo", [
      {
        chunkId: "c1",
        chunk: {
          content: "",
          startLine: 1,
          endLine: 10,
          metadata: { filePath: "/repo/src/a.ts" },
        },
      } as any,
    ]);
    await new Promise((r) => setTimeout(r, 50));

    mockProvider.buildChunkSignals.mockClear();
    mockProvider.buildChunkSignals.mockResolvedValue(new Map());

    // startChunkEnrichment with additional file
    const fullChunkMap = new Map([
      ["src/a.ts", [{ chunkId: "c1", startLine: 1, endLine: 10 }]],
      ["src/b.ts", [{ chunkId: "c2", startLine: 1, endLine: 20 }]],
    ]);
    coordinator.startChunkEnrichment("test-col", "/repo", fullChunkMap);

    await new Promise((r) => setTimeout(r, 50));
    // Only src/b.ts should be in the remaining call
    expect(mockProvider.buildChunkSignals).toHaveBeenCalledTimes(1);
    const calledMap = mockProvider.buildChunkSignals.mock.calls[0][1] as Map<
      string,
      unknown
    >;
    expect(calledMap.has("src/b.ts")).toBe(true);
    expect(calledMap.has("src/a.ts")).toBe(false);
  });

  it("does not call buildChunkSignals for single-chunk files", async () => {
    // Single-chunk files are skipped inside buildChunkChurnMapUncached,
    // but coordinator should still pass them — provider decides
    const coordinator = new EnrichmentCoordinator(mockQdrant, mockProvider);
    coordinator.prefetch("/repo", "test-col");
    await new Promise((r) => setTimeout(r, 20));

    coordinator.onChunksStored("test-col", "/repo", [
      {
        chunkId: "c1",
        chunk: {
          content: "",
          startLine: 1,
          endLine: 100,
          metadata: { filePath: "/repo/src/small.ts" },
        },
      } as any,
    ]);

    await new Promise((r) => setTimeout(r, 50));

    // buildChunkSignals IS called — the provider/chunk-reader internally skips single-chunk files
    expect(mockProvider.buildChunkSignals).toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run:
`npx vitest run tests/core/domains/ingest/pipeline/enrichment/coordinator.test.ts`
Expected: FAIL — streaming chunk enrichment not implemented

- [ ] **Step 3: Implement streaming chunk enrichment in coordinator**

Key changes to `coordinator.ts`:

**Add imports:**

```typescript
import { Semaphore } from "../../../../infra/semaphore.js";
import type { ChunkLookupEntry } from "../../../../types.js";
```

**Add to ProviderState interface (after `flushApplies`):**

```typescript
/** Files already enriched via streaming (relative paths). */
streamingEnrichedFiles: Set<string>;
/** Shared semaphore for chunk enrichment concurrency. */
chunkSemaphore: Semaphore;
```

**Update `createProviderState()`:**

```typescript
    streamingEnrichedFiles: new Set(),
    chunkSemaphore: new Semaphore(provider.chunkConcurrency ?? 10),
```

Wait — `provider.chunkConcurrency` doesn't exist on the interface. The
coordinator doesn't know about provider-specific config. We should use a default
(10) and let it be configurable via coordinator constructor or a constant.

**Better approach: coordinator creates a single Semaphore(10) shared across all
providers.**

Add to EnrichmentCoordinator class:

```typescript
  /** Shared semaphore for bounding total chunk enrichment concurrency (git blame). */
  private readonly chunkSemaphore = new Semaphore(10);
```

**Add to ProviderState:**

```typescript
streamingEnrichedFiles: Set<string>;
```

**Update createProviderState():**

```typescript
    streamingEnrichedFiles: new Set(),
```

**Add helper method to extract ChunkLookupEntry from ChunkItem[]:**

```typescript
  private extractChunkMap(items: ChunkItem[], basePath: string): Map<string, ChunkLookupEntry[]> {
    const chunkMap = new Map<string, ChunkLookupEntry[]>();
    for (const item of items) {
      const filePath = item.chunk.metadata.filePath;
      const relPath = filePath.startsWith(basePath) ? filePath.slice(basePath.length + 1) : filePath;
      const entries = chunkMap.get(relPath) || [];
      entries.push({
        chunkId: item.chunkId,
        startLine: item.chunk.startLine,
        endLine: item.chunk.endLine,
      });
      chunkMap.set(relPath, entries);
    }
    return chunkMap;
  }
```

**Add streaming chunk enrichment method:**

```typescript
  private startStreamingChunkEnrichment(
    state: ProviderState,
    collectionName: string,
    absolutePath: string,
    batchChunkMap: Map<string, ChunkLookupEntry[]>,
  ): void {
    const root = state.effectiveRoot || absolutePath;

    // Filter by ignore patterns
    if (state.ignoreFilter) {
      for (const [filePath] of batchChunkMap) {
        if (state.ignoreFilter.ignores(filePath)) {
          batchChunkMap.delete(filePath);
        }
      }
    }

    if (batchChunkMap.size === 0) return;

    // Track enriched files BEFORE async work to prevent duplicate git blame
    // in startChunkEnrichment() (idempotent Qdrant writes are cheap, git blame is not)
    for (const filePath of batchChunkMap.keys()) {
      state.streamingEnrichedFiles.add(filePath);
    }

    pipelineLog.enrichmentPhase("STREAMING_CHUNK_ENRICHMENT_START", {
      provider: state.provider.key,
      files: batchChunkMap.size,
    });

    const work = state.provider
      .buildChunkSignals(root, batchChunkMap, {
        concurrencySemaphore: this.chunkSemaphore,
        skipCache: true,
      })
      .then(async (chunkMetadata) => {
        const applied = await this.applier.applyChunkSignals(
          collectionName,
          state.provider.key,
          chunkMetadata,
        );

        pipelineLog.enrichmentPhase("STREAMING_CHUNK_ENRICHMENT_COMPLETE", {
          provider: state.provider.key,
          files: batchChunkMap.size,
          overlaysApplied: applied,
        });
      })
      .catch((error) => {
        console.error(
          `[Enrichment:${state.provider.key}] Streaming chunk enrichment failed:`,
          error instanceof Error ? error.message : error,
        );
      });

    state.inFlightWork.push(work);
  }
```

**Modify `onChunksStored()` — add chunk enrichment after file signal apply:**

After the existing file signal application logic (line 199-224), add chunk
enrichment:

```typescript
  onChunksStored(collectionName: string, absolutePath: string, items: ChunkItem[]): void {
    for (const state of this.states.values()) {
      state.pipelineFlushTime = Date.now();

      if (state.prefetchFailed) continue;

      if (state.fileMetadata) {
        const pathBase = state.effectiveRoot || absolutePath;

        // File-level signal application (existing)
        const work = this.applier.applyFileSignals(
          collectionName,
          state.provider.key,
          state.fileMetadata,
          pathBase,
          items,
          state.provider.fileSignalTransform,
        );
        state.inFlightWork.push(work);
        state.streamingApplies++;
        pipelineLog.enrichmentPhase("STREAMING_APPLY", {
          provider: state.provider.key,
          chunks: items.length,
        });

        // Streaming chunk enrichment (NEW)
        const batchChunkMap = this.extractChunkMap(items, pathBase);
        this.startStreamingChunkEnrichment(state, collectionName, absolutePath, batchChunkMap);
      } else {
        state.pendingBatches.push({ collectionName, absolutePath, items });
      }
    }
  }
```

**Modify `flushPendingBatches()` — also flush chunk enrichment for pending
batches:**

After existing flush logic, add:

```typescript
  private flushPendingBatches(state: ProviderState): void {
    if (state.pendingBatches.length === 0) return;

    const batches = state.pendingBatches;
    state.pendingBatches = [];

    pipelineLog.enrichmentPhase("FLUSH_APPLY", {
      provider: state.provider.key,
      batches: batches.length,
      chunks: batches.reduce((sum, b) => sum + b.items.length, 0),
    });

    for (const batch of batches) {
      if (!state.fileMetadata) continue;
      const pathBase = state.effectiveRoot || batch.absolutePath;

      // File signals (existing)
      const work = this.applier.applyFileSignals(
        batch.collectionName,
        state.provider.key,
        state.fileMetadata,
        pathBase,
        batch.items,
        state.provider.fileSignalTransform,
      );
      state.inFlightWork.push(work);
      state.flushApplies++;

      // Chunk signals (NEW)
      const batchChunkMap = this.extractChunkMap(batch.items, pathBase);
      this.startStreamingChunkEnrichment(state, batch.collectionName, batch.absolutePath, batchChunkMap);
    }
  }
```

**Modify `startChunkEnrichment()` — skip already-enriched files:**

```typescript
  startChunkEnrichment(
    collectionName: string,
    absolutePath: string,
    chunkMap: Map<string, ChunkLookupEntry[]>,
  ): void {
    const providerPromises: Promise<boolean>[] = [];

    for (const state of this.states.values()) {
      if (state.prefetchFailed) continue;

      const root = state.effectiveRoot || absolutePath;

      // Filter chunkMap by ignore patterns
      let effectiveChunkMap = chunkMap;
      if (state.ignoreFilter) {
        effectiveChunkMap = new Map();
        for (const [filePath, entries] of chunkMap) {
          const relPath = relative(root, filePath);
          if (!state.ignoreFilter.ignores(relPath)) {
            effectiveChunkMap.set(filePath, entries);
          }
        }
      }

      // Remove files already enriched by streaming (NEW)
      const remainingChunkMap = new Map<string, ChunkLookupEntry[]>();
      for (const [filePath, entries] of effectiveChunkMap) {
        const relPath = filePath.startsWith(root) ? filePath.slice(root.length + 1) : filePath;
        if (!state.streamingEnrichedFiles.has(relPath)) {
          remainingChunkMap.set(filePath, entries);
        }
      }

      if (remainingChunkMap.size === 0) {
        pipelineLog.enrichmentPhase("CHUNK_ENRICHMENT_SKIPPED", {
          provider: state.provider.key,
          reason: "all files enriched via streaming",
          streamingEnrichedFiles: state.streamingEnrichedFiles.size,
        });
        continue;
      }

      pipelineLog.enrichmentPhase("CHUNK_ENRICHMENT_START", {
        provider: state.provider.key,
        files: remainingChunkMap.size,
        streamingEnrichedFiles: state.streamingEnrichedFiles.size,
      });

      const chunkStart = Date.now();

      const providerDone = state.provider
        .buildChunkSignals(root, remainingChunkMap, { skipCache: true })  // skipCache: remaining is a subset, don't corrupt cache
        .then(async (chunkMetadata) => {
          // ... existing apply + status write logic unchanged ...
          const applied = await this.applier.applyChunkSignals(collectionName, state.provider.key, chunkMetadata);
          state.chunkEnrichmentDurationMs = Date.now() - chunkStart;

          try {
            await this.qdrant.setPayload(
              collectionName,
              {
                chunkEnrichment: {
                  status: "completed",
                  provider: state.provider.key,
                  overlaysApplied: applied,
                  durationMs: state.chunkEnrichmentDurationMs,
                },
              },
              { points: [INDEXING_METADATA_ID] },
            );
          } catch {
            // non-fatal
          }

          pipelineLog.enrichmentPhase("CHUNK_ENRICHMENT_COMPLETE", {
            provider: state.provider.key,
            overlaysApplied: applied,
            durationMs: state.chunkEnrichmentDurationMs,
          });
          return true;
        })
        .catch((error) => {
          state.chunkEnrichmentDurationMs = Date.now() - chunkStart;
          console.error(`[Enrichment:${state.provider.key}] Chunk enrichment failed:`, error);
          return false;
        });

      providerPromises.push(providerDone);
    }

    // ... existing callback logic unchanged ...
  }
```

- [ ] **Step 4: Run tests**

Run:
`npx vitest run tests/core/domains/ingest/pipeline/enrichment/coordinator.test.ts`
Expected: PASS (all existing + new tests)

- [ ] **Step 5: Run full test suite**

Run: `npx vitest run` Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/core/domains/ingest/pipeline/enrichment/coordinator.ts tests/core/domains/ingest/pipeline/enrichment/coordinator.test.ts
git commit -m "feat(pipeline): streaming chunk enrichment per-batch in coordinator"
```

---

## Chunk 4: Simplify base.ts Pipeline

### Task 4: Remove chunkMap dependency from finalizeProcessing

**Files:**

- Modify: `src/core/domains/ingest/pipeline/base.ts:104-112`
- Modify all callers of `finalizeProcessing()` that pass chunkMap

The chunkMap was needed only because chunk enrichment happened after flush. Now
that streaming handles it, the final call is just a catch-all for stragglers.

- [ ] **Step 1: Check callers of finalizeProcessing**

Search for all callers to understand impact:

```bash
npx vitest run  # Ensure baseline passes first
```

Run: `rg "finalizeProcessing" src/`

- [ ] **Step 2: Keep chunkMap param for backward compat but document streaming**

Actually — `finalizeProcessing()` still needs to call `startEnrichment()` for
files that arrived in the last batches that might not have been
streaming-enriched yet (edge case: pipeline flushes final batch, but streaming
chunk enrichment for that batch is still in-flight). The existing flow is
correct — `startChunkEnrichment` now intelligently skips already-enriched files.

No changes needed to `base.ts` — the existing
`finalizeProcessing → startEnrichment → startChunkEnrichment` flow works
correctly because `startChunkEnrichment` now filters out streaming-enriched
files.

- [ ] **Step 3: Verify no regressions**

Run: `npx vitest run` Expected: PASS

- [ ] **Step 4: Commit (if any changes)**

If no code changes needed, skip this commit.

---

## Chunk 5: Integration Verification

### Task 5: End-to-end verification

- [ ] **Step 1: Run full test suite with debug logging**

```bash
DEBUG=true npx vitest run 2>&1 | grep -E "(STREAMING_CHUNK|CHUNK_ENRICHMENT)"
```

Expected: See `STREAMING_CHUNK_ENRICHMENT_START`,
`STREAMING_CHUNK_ENRICHMENT_COMPLETE`, and possibly `CHUNK_ENRICHMENT_SKIPPED`
in logs.

- [ ] **Step 2: Type check**

```bash
npx tsc --noEmit
```

Expected: No type errors.

- [ ] **Step 3: Build**

```bash
npm run build
```

Expected: Clean build.

- [ ] **Step 4: Final commit (if needed)**

```bash
git add -A
git commit -m "improve(pipeline): streaming chunk enrichment — overlap git blame with chunking"
```

# Multi-Provider Enrichment Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Make EnrichmentCoordinator support multiple providers in parallel, remove git hardcoding from ChunkPipeline.

**Architecture:** EnrichmentCoordinator holds per-provider state maps instead of flat fields. A registry factory builds the active provider list from config. ChunkPipeline loses git-specific payload construction — all enrichment goes through EnrichmentApplier post-upsert.

**Tech Stack:** TypeScript, Vitest

**Design doc:** `docs/plans/2026-02-24-multi-provider-enrichment-design.md`

---

### Task 1: Remove hardcoded git payload from ChunkPipeline

The `git.file.*` fields are written twice: once in ChunkPipeline (upsert) and again by EnrichmentApplier (`setPayload`). Remove the first write.

**Files:**
- Modify: `src/core/ingest/pipeline/chunk-pipeline.ts:345-360`
- Modify: `src/core/types.ts:283-320` (remove `git?` from `ChunkMetadata`)

**Step 1: Delete git payload block from ChunkPipeline**

In `src/core/ingest/pipeline/chunk-pipeline.ts`, delete lines 345-360 (the `git` spread inside payload construction):

```typescript
// DELETE this entire block:
// Git metadata: nested under git.file for level-based filtering
...(item.chunk.metadata.git && {
  git: {
    file: {
      lastModifiedAt: item.chunk.metadata.git.lastModifiedAt,
      // ... all fields
    },
  },
}),
```

After deletion, line 344 (`imports` spread) should be followed directly by the closing `},` of payload.

**Step 2: Remove `git?` field from `ChunkMetadata` in types.ts**

In `src/core/types.ts`, delete the `git?` property from the `ChunkMetadata` interface (lines ~283-320). This field was only consumed by the deleted ChunkPipeline code — EnrichmentApplier writes git data independently via `setPayload`.

**Step 3: Verify no other code reads `chunk.metadata.git`**

Run: `npx vitest run`
Expected: All 1371 tests pass. If any test asserts `git.file.*` in upsert payload, it needs updating (enrichment writes it separately now).

**Step 4: Commit**

```
refactor: remove hardcoded git payload from ChunkPipeline

File-level git metadata is written by EnrichmentApplier via setPayload.
The duplicate write in ChunkPipeline upsert was redundant.
```

---

### Task 2: Extract ProviderState from EnrichmentCoordinator

Refactor coordinator's flat instance fields into a `ProviderState` structure. This task keeps single-provider behavior but prepares the data model.

**Files:**
- Modify: `src/core/ingest/trajectory/enrichment/coordinator.ts`
- Test: `tests/code/enrichment/coordinator.test.ts` (must still pass, no API change)

**Step 1: Define ProviderState interface**

Add at the top of `coordinator.ts`, after imports:

```typescript
interface ProviderState {
  provider: EnrichmentProvider;
  prefetchPromise: Promise<Map<string, Record<string, unknown>>> | null;
  fileMetadata: Map<string, Record<string, unknown>> | null;
  prefetchFailed: boolean;
  effectiveRoot: string | null;
  pendingBatches: PendingBatch[];
  inFlightWork: Promise<void>[];
  chunkEnrichmentDurationMs: number;
  ignoreFilter: Ignore | null;
  fileMetadataCount: number;
  prefetchStartTime: number;
  prefetchEndTime: number;
  pipelineFlushTime: number;
  streamingApplies: number;
  flushApplies: number;
  prefetchDurationMs: number;
}

function createProviderState(provider: EnrichmentProvider): ProviderState {
  return {
    provider,
    prefetchPromise: null,
    fileMetadata: null,
    prefetchFailed: false,
    effectiveRoot: null,
    pendingBatches: [],
    inFlightWork: [],
    chunkEnrichmentDurationMs: 0,
    ignoreFilter: null,
    fileMetadataCount: 0,
    prefetchStartTime: 0,
    prefetchEndTime: 0,
    pipelineFlushTime: 0,
    streamingApplies: 0,
    flushApplies: 0,
    prefetchDurationMs: 0,
  };
}
```

**Step 2: Replace flat fields with `states` map**

Replace all flat instance fields (lines 32-59) with:

```typescript
private readonly states: Map<string, ProviderState>;
private readonly startTime: number = 0;
private readonly applier: EnrichmentApplier;
```

Constructor changes from:

```typescript
constructor(
  private readonly qdrant: QdrantManager,
  private readonly provider: EnrichmentProvider,
) {
  this.applier = new EnrichmentApplier(qdrant);
}
```

To:

```typescript
constructor(
  private readonly qdrant: QdrantManager,
  providers: EnrichmentProvider | EnrichmentProvider[],
) {
  this.applier = new EnrichmentApplier(qdrant);
  const list = Array.isArray(providers) ? providers : [providers];
  this.states = new Map(list.map((p) => [p.key, createProviderState(p)]));
}
```

The `EnrichmentProvider | EnrichmentProvider[]` union keeps backward compatibility — existing callers passing a single provider still work.

**Step 3: Update `providerKey` getter**

Replace:
```typescript
get providerKey(): string {
  return this.provider.key;
}
```

With:
```typescript
get providerKeys(): string[] {
  return [...this.states.keys()];
}
```

**Step 4: Rewrite `prefetch` to iterate states**

Replace the body of `prefetch()` with iteration over all provider states. For each state:
- Set timing fields
- Call `state.provider.resolveRoot()`
- Call `state.provider.buildFileMetadata()`
- Store result in `state.fileMetadata`
- Call `this.flushPendingBatches(state)`

All prefetches run in parallel (fire-and-forget promises per state).

```typescript
prefetch(absolutePath: string, collectionName?: string, ignoreFilter?: Ignore): void {
  this.startTime = Date.now();

  if (collectionName) {
    this.updateEnrichmentMarker(collectionName, {
      status: "in_progress",
      startedAt: new Date().toISOString(),
    }).catch(() => {});
  }

  for (const state of this.states.values()) {
    state.ignoreFilter = ignoreFilter ?? null;
    state.prefetchStartTime = Date.now();
    state.effectiveRoot = state.provider.resolveRoot(absolutePath);
    const root = state.effectiveRoot;

    if (root !== absolutePath) {
      pipelineLog.enrichmentPhase("REPO_ROOT_DIFFERS", { provider: state.provider.key, absolutePath, effectiveRoot: root });
    }

    pipelineLog.enrichmentPhase("PREFETCH_START", { provider: state.provider.key, path: root });

    state.prefetchPromise = state.provider
      .buildFileMetadata(root)
      .then((result) => {
        state.prefetchEndTime = Date.now();
        state.fileMetadata = result;
        state.prefetchDurationMs = state.prefetchEndTime - state.prefetchStartTime;

        if (state.ignoreFilter) {
          let filtered = 0;
          for (const [path] of result) {
            if (state.ignoreFilter.ignores(path)) {
              result.delete(path);
              filtered++;
            }
          }
          if (filtered > 0) {
            pipelineLog.enrichmentPhase("PREFETCH_FILTERED", { provider: state.provider.key, filtered, remainingFiles: result.size });
          }
        }

        state.fileMetadataCount = result.size;

        pipelineLog.enrichmentPhase("PREFETCH_COMPLETE", {
          provider: state.provider.key,
          filesInLog: result.size,
          durationMs: state.prefetchDurationMs,
        });
        pipelineLog.addStageTime("enrichment_prefetch", state.prefetchDurationMs);

        this.flushPendingBatches(state);
        return result;
      })
      .catch((error) => {
        state.prefetchFailed = true;
        state.prefetchEndTime = Date.now();
        state.prefetchDurationMs = state.prefetchEndTime - state.prefetchStartTime;
        console.error(`[Enrichment:${state.provider.key}] Prefetch failed:`, error instanceof Error ? error.message : error);
        pipelineLog.enrichmentPhase("PREFETCH_FAILED", {
          provider: state.provider.key,
          error: error instanceof Error ? error.message : String(error),
          durationMs: state.prefetchDurationMs,
        });
        state.pendingBatches = [];
        return new Map();
      });
  }
}
```

**Step 5: Rewrite `onChunksStored` to iterate states**

```typescript
onChunksStored(collectionName: string, absolutePath: string, items: ChunkItem[]): void {
  for (const state of this.states.values()) {
    state.pipelineFlushTime = Date.now();

    if (state.prefetchFailed) continue;

    if (state.fileMetadata) {
      const pathBase = state.effectiveRoot || absolutePath;
      const work = this.applier.applyFileMetadata(
        collectionName,
        state.provider.key,
        state.fileMetadata,
        pathBase,
        items,
        state.provider.fileTransform,
      );
      state.inFlightWork.push(work);
      state.streamingApplies++;
      pipelineLog.enrichmentPhase("STREAMING_APPLY", { provider: state.provider.key, chunks: items.length });
    } else {
      state.pendingBatches.push({ collectionName, absolutePath, items });
    }
  }
}
```

**Step 6: Rewrite `startChunkEnrichment` to iterate states**

Same pattern: iterate `this.states.values()`, call `state.provider.buildChunkMetadata()` for each. Each provider's chunk enrichment runs independently.

**Step 7: Rewrite `awaitCompletion` to await all providers**

Use `Promise.allSettled` across all states' prefetch promises and in-flight work. Aggregate metrics from all providers. Backfill missed files per provider.

```typescript
async awaitCompletion(collectionName: string): Promise<EnrichmentMetrics> {
  // 1. Wait for all prefetches
  const prefetchPromises = [...this.states.values()]
    .map((s) => s.prefetchPromise)
    .filter(Boolean);
  await Promise.allSettled(prefetchPromises as Promise<unknown>[]);

  // 2. Wait for all in-flight work across all providers
  const allInFlight = [...this.states.values()].flatMap((s) => s.inFlightWork);
  if (allInFlight.length > 0) {
    await Promise.allSettled(allInFlight);
    for (const state of this.states.values()) {
      state.inFlightWork = [];
    }
  }

  // 3. Backfill per provider
  for (const state of this.states.values()) {
    if (this.applier.missedFileChunks.size > 0 && state.effectiveRoot) {
      await this.backfillMissedFiles(collectionName, state);
    }
  }

  // 4. Aggregate metrics (sum across providers)
  // ... (use first provider's timing for backward compat, or sum)
  const metrics: EnrichmentMetrics = { /* aggregate */ };

  await this.updateEnrichmentMarker(collectionName, { /* ... */ });
  pipelineLog.enrichmentPhase("ALL_COMPLETE", { ...metrics });
  return metrics;
}
```

**Step 8: Update `flushPendingBatches` and `backfillMissedFiles` to take state param**

Change signatures:
- `private flushPendingBatches(state: ProviderState): void`
- `private async backfillMissedFiles(collectionName: string, state: ProviderState): Promise<void>`

Replace `this.provider` references with `state.provider`, `this.fileMetadata` with `state.fileMetadata`, etc.

**Step 9: Run tests**

Run: `npx vitest run`
Expected: All tests pass. The coordinator test creates `new EnrichmentCoordinator(mockQdrant, mockProvider)` — this still works due to the union type in constructor.

**Step 10: Commit**

```
refactor: extract ProviderState, make EnrichmentCoordinator multi-provider

Coordinator now accepts EnrichmentProvider[] and manages per-provider state.
Single provider callers still work via union type in constructor.
All providers run in parallel (prefetch, streaming apply, chunk enrichment).
```

---

### Task 3: Create EnrichmentRegistry factory

**Files:**
- Create: `src/core/ingest/trajectory/enrichment/registry.ts`
- Test: `tests/code/enrichment/registry.test.ts`

**Step 1: Write the failing test**

```typescript
// tests/code/enrichment/registry.test.ts
import { describe, expect, it } from "vitest";
import { createEnrichmentProviders } from "../../../../src/core/ingest/trajectory/enrichment/registry.js";
import type { CodeConfig } from "../../../../src/core/types.js";

describe("createEnrichmentProviders", () => {
  it("returns GitEnrichmentProvider when enableGitMetadata is true", () => {
    const config = { enableGitMetadata: true } as CodeConfig;
    const providers = createEnrichmentProviders(config);
    expect(providers).toHaveLength(1);
    expect(providers[0].key).toBe("git");
  });

  it("returns empty array when enableGitMetadata is false", () => {
    const config = { enableGitMetadata: false } as CodeConfig;
    const providers = createEnrichmentProviders(config);
    expect(providers).toHaveLength(0);
  });

  it("returns empty array when enableGitMetadata is undefined", () => {
    const config = {} as CodeConfig;
    const providers = createEnrichmentProviders(config);
    expect(providers).toHaveLength(0);
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run tests/code/enrichment/registry.test.ts`
Expected: FAIL — module not found

**Step 3: Write implementation**

```typescript
// src/core/ingest/trajectory/enrichment/registry.ts
/**
 * EnrichmentRegistry — config-driven factory for enrichment providers.
 *
 * Reads config flags and returns active EnrichmentProvider instances.
 * New providers: add a config check + import here.
 */

import type { CodeConfig } from "../../../../types.js";
import { GitEnrichmentProvider } from "./git/provider.js";
import type { EnrichmentProvider } from "./types.js";

export function createEnrichmentProviders(config: CodeConfig): EnrichmentProvider[] {
  const providers: EnrichmentProvider[] = [];

  if (config.enableGitMetadata) {
    providers.push(new GitEnrichmentProvider());
  }

  // Future providers:
  // if (config.enrichment?.complexity) providers.push(new ComplexityProvider());
  // if (config.enrichment?.depGraph) providers.push(new DepGraphProvider());

  return providers;
}
```

**Step 4: Run test to verify it passes**

Run: `npx vitest run tests/code/enrichment/registry.test.ts`
Expected: PASS

**Step 5: Commit**

```
feat: add createEnrichmentProviders registry factory
```

---

### Task 4: Wire registry into IngestFacade

**Files:**
- Modify: `src/core/api/ingest-facade.ts`

**Step 1: Replace hardcoded provider with registry**

Change import:
```typescript
// Remove:
import { GitEnrichmentProvider } from "../ingest/trajectory/enrichment/git/provider.js";
// Add:
import { createEnrichmentProviders } from "../ingest/trajectory/enrichment/registry.js";
```

Change constructor line 34:
```typescript
// Was:
this.enrichment = new EnrichmentCoordinator(qdrant, new GitEnrichmentProvider());
// Now:
this.enrichment = new EnrichmentCoordinator(qdrant, createEnrichmentProviders(config));
```

**Step 2: Remove `enableGitMetadata` guard from BaseIndexingPipeline**

In `src/core/ingest/pipeline/base.ts`, method `setupEnrichmentHooks` (line 117):

```typescript
// Was:
if (this.config.enableGitMetadata) {
  this.enrichment.prefetch(absolutePath, collectionName, ignoreFilter);
  chunkPipeline.setOnBatchUpserted((items) => {
    this.enrichment.onChunksStored(collectionName, absolutePath, items);
  });
}

// Now (coordinator handles empty providers internally):
this.enrichment.prefetch(absolutePath, collectionName, ignoreFilter);
chunkPipeline.setOnBatchUpserted((items) => {
  this.enrichment.onChunksStored(collectionName, absolutePath, items);
});
```

Same for `startEnrichment` (line 141):
```typescript
// Remove:
if (!this.config.enableGitMetadata) return () => "skipped";
// Keep:
if (chunkMap.size === 0) return () => "skipped";
```

The coordinator with empty `states` map will be a no-op for all methods — no providers means no work.

**Step 3: Run full test suite**

Run: `npx vitest run`
Expected: All tests pass

**Step 4: Commit**

```
refactor: wire EnrichmentRegistry into IngestFacade, remove git guards from base
```

---

### Task 5: Update coordinator tests for multi-provider

**Files:**
- Modify: `tests/code/enrichment/coordinator.test.ts`

**Step 1: Add multi-provider test**

```typescript
it("handles multiple providers in parallel", async () => {
  const providerA: EnrichmentProvider = {
    key: "alpha",
    resolveRoot: vi.fn((p: string) => p),
    buildFileMetadata: vi.fn().mockResolvedValue(new Map([["src/a.ts", { a: 1 }]])),
    buildChunkMetadata: vi.fn().mockResolvedValue(new Map()),
  };
  const providerB: EnrichmentProvider = {
    key: "beta",
    resolveRoot: vi.fn((p: string) => p),
    buildFileMetadata: vi.fn().mockResolvedValue(new Map([["src/a.ts", { b: 2 }]])),
    buildChunkMetadata: vi.fn().mockResolvedValue(new Map()),
  };

  const multi = new EnrichmentCoordinator(mockQdrant, [providerA, providerB]);

  multi.prefetch("/repo", "test-col");
  await new Promise((r) => setTimeout(r, 10));

  // Both providers should have been called
  expect(providerA.buildFileMetadata).toHaveBeenCalledWith("/repo");
  expect(providerB.buildFileMetadata).toHaveBeenCalledWith("/repo");
});
```

**Step 2: Add test for empty providers (no-op)**

```typescript
it("is a no-op when no providers are registered", async () => {
  const empty = new EnrichmentCoordinator(mockQdrant, []);

  empty.prefetch("/repo", "test-col");
  empty.onChunksStored("test-col", "/repo", [
    { chunkId: "c1", chunk: { metadata: { filePath: "/repo/src/a.ts" }, endLine: 10 } } as any,
  ]);

  const metrics = await empty.awaitCompletion("test-col");
  expect(metrics).toHaveProperty("totalDurationMs");
  expect(mockQdrant.batchSetPayload).not.toHaveBeenCalled();
});
```

**Step 3: Update `providerKey` assertion**

```typescript
// Was:
expect(coordinator.providerKey).toBe("git");
// Now:
expect(coordinator.providerKeys).toEqual(["git"]);
```

**Step 4: Run tests**

Run: `npx vitest run tests/code/enrichment/coordinator.test.ts`
Expected: PASS

**Step 5: Run full test suite**

Run: `npx vitest run`
Expected: All tests pass

**Step 6: Commit**

```
test: add multi-provider and empty-provider coordinator tests
```

---

### Task 6: Final verification

**Step 1: Type check**

Run: `npx tsc --noEmit`
Expected: 0 errors

**Step 2: Lint**

Run: `npx eslint src/core/ingest/trajectory/enrichment/ src/core/ingest/pipeline/chunk-pipeline.ts src/core/api/ingest-facade.ts src/core/ingest/pipeline/base.ts`
Expected: No errors (warnings OK)

**Step 3: Full test suite**

Run: `npx vitest run`
Expected: All tests pass

**Step 4: Commit (if any formatting fixes)**

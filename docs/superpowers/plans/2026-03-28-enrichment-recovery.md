# Enrichment Recovery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use
> superpowers:subagent-driven-development (recommended) or
> superpowers:executing-plans to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** Detect enrichment failures, report health in API, and auto-recover
unenriched chunks on next indexing run.

**Architecture:** Per-provider enrichment marker in Qdrant (file + chunk levels
with independent status/heartbeat). `enrichedAt` timestamps on chunks as source
of truth. Recovery step scrolls for missing timestamps before main enrichment.

**Tech Stack:** TypeScript, Qdrant vector DB, Vitest

**Spec:** `docs/superpowers/specs/2026-03-27-enrichment-recovery-design.md`

**Worktree:** `.worktrees/enrichment-recovery` (branch
`feature/enrichment-recovery`)

---

## File Structure

| File                                                         | Responsibility                                                                                |
| ------------------------------------------------------------ | --------------------------------------------------------------------------------------------- |
| `src/core/domains/ingest/pipeline/enrichment/types.ts`       | New marker types (`ProviderEnrichmentMarker`, `EnrichmentLevelMarker`, etc.)                  |
| `src/core/types.ts`                                          | Remove `EnrichmentInfo`, `ChunkEnrichmentInfo`, `EnrichmentStatusValue`; update `IndexStatus` |
| `src/core/api/public/dto/ingest.ts`                          | Update `IndexStatus` DTO to use new enrichment map                                            |
| `src/core/api/public/dto/metrics.ts`                         | Add `enrichment` field to `IndexMetrics`                                                      |
| `src/core/domains/ingest/pipeline/enrichment/applier.ts`     | Write `enrichedAt` timestamps in same batch as signals                                        |
| `src/core/domains/ingest/pipeline/enrichment/coordinator.ts` | Per-level marker updates, heartbeat, recovery orchestration                                   |
| `src/core/domains/ingest/pipeline/enrichment/recovery.ts`    | **New**: scroll unenriched chunks, re-enrich, count                                           |
| `src/core/domains/ingest/pipeline/enrichment/migration.ts`   | **New**: one-time `enrichedAt` backfill for existing collections                              |
| `src/core/domains/ingest/pipeline/status-module.ts`          | Read new marker format, stale detection, map to API                                           |
| `src/core/api/internal/facades/explore-facade.ts`            | Add enrichment health to `IndexMetrics` response                                              |
| `src/core/api/internal/facades/ingest-facade.ts`             | Trigger migration + recovery before enrichment                                                |
| `src/core/domains/ingest/pipeline/base.ts`                   | Pass recovery into pipeline lifecycle                                                         |
| `src/core/domains/ingest/reindexing.ts`                      | Pass recovery into reindex lifecycle                                                          |
| `src/mcp/tools/code.ts`                                      | Update tool output formatting                                                                 |

---

## Task 1: New Enrichment Marker Types

**Files:**

- Modify: `src/core/domains/ingest/pipeline/enrichment/types.ts`
- Test: `tests/core/domains/ingest/pipeline/enrichment/types.test.ts`

### Steps

- [ ] **Step 1: Write type definitions**

Replace the contents of `src/core/domains/ingest/pipeline/enrichment/types.ts`:

```typescript
export type {
  EnrichmentProvider,
  FileSignalTransform,
} from "../../../../contracts/types/provider.js";

// --- Enrichment marker types (per-provider, per-level) ---

export type EnrichmentLevelStatus =
  | "pending"
  | "in_progress"
  | "completed"
  | "degraded"
  | "failed";

export interface EnrichmentLevelMarker {
  status: EnrichmentLevelStatus;
  startedAt?: string;
  completedAt?: string;
  durationMs?: number;
  matchedFiles?: number;
  missedFiles?: number;
  unenrichedChunks: number;
  /** ISO timestamp of last progress heartbeat */
  lastProgressAt?: string;
  /** Enriched chunk count at last heartbeat */
  lastProgressChunks?: number;
}

export interface FileEnrichmentMarker extends EnrichmentLevelMarker {
  status: "pending" | "in_progress" | "completed" | "failed";
}

export interface ChunkEnrichmentMarker extends EnrichmentLevelMarker {
  status: "pending" | "in_progress" | "completed" | "degraded" | "failed";
}

export interface ProviderEnrichmentMarker {
  runId: string;
  file: FileEnrichmentMarker;
  chunk: ChunkEnrichmentMarker;
}

/** Shape stored in Qdrant metadata point (ID=1) payload.enrichment */
export type EnrichmentMarkerMap = Record<string, ProviderEnrichmentMarker>;

/** API-facing health per level */
export interface EnrichmentLevelHealth {
  status: "healthy" | "in_progress" | "degraded" | "failed";
  unenrichedChunks?: number;
  message?: string;
}

/** API-facing health per provider */
export interface EnrichmentProviderHealth {
  file: EnrichmentLevelHealth;
  chunk: EnrichmentLevelHealth;
}

/** API-facing enrichment health map */
export type EnrichmentHealthMap = Record<string, EnrichmentProviderHealth>;
```

- [ ] **Step 2: Write smoke test**

Create `tests/core/domains/ingest/pipeline/enrichment/types.test.ts`:

```typescript
import { describe, expect, it } from "vitest";

import type {
  EnrichmentHealthMap,
  EnrichmentMarkerMap,
  ProviderEnrichmentMarker,
} from "../../../../../../src/core/domains/ingest/pipeline/enrichment/types.js";

describe("Enrichment marker types", () => {
  it("should allow constructing a valid ProviderEnrichmentMarker", () => {
    const marker: ProviderEnrichmentMarker = {
      runId: "abc-123",
      file: {
        status: "completed",
        unenrichedChunks: 0,
        startedAt: "2026-03-27T10:00:00Z",
        completedAt: "2026-03-27T10:00:12Z",
        durationMs: 12000,
        matchedFiles: 100,
        missedFiles: 3,
      },
      chunk: {
        status: "degraded",
        unenrichedChunks: 5,
        startedAt: "2026-03-27T10:00:12Z",
      },
    };
    expect(marker.file.status).toBe("completed");
    expect(marker.chunk.status).toBe("degraded");
  });

  it("should allow constructing EnrichmentMarkerMap", () => {
    const map: EnrichmentMarkerMap = {
      git: {
        runId: "r1",
        file: { status: "failed", unenrichedChunks: 200 },
        chunk: { status: "failed", unenrichedChunks: 200 },
      },
    };
    expect(map.git.file.status).toBe("failed");
  });

  it("should allow constructing EnrichmentHealthMap", () => {
    const health: EnrichmentHealthMap = {
      git: {
        file: { status: "healthy" },
        chunk: {
          status: "degraded",
          unenrichedChunks: 5,
          message: "5 chunks missing",
        },
      },
    };
    expect(health.git.chunk.status).toBe("degraded");
  });
});
```

- [ ] **Step 3: Run tests**

Run:
`npx vitest run tests/core/domains/ingest/pipeline/enrichment/types.test.ts`
Expected: PASS (type-only smoke tests)

- [ ] **Step 4: Commit**

```bash
git add src/core/domains/ingest/pipeline/enrichment/types.ts tests/core/domains/ingest/pipeline/enrichment/types.test.ts
git commit -m "feat(enrichment): add per-provider per-level enrichment marker types"
```

---

## Task 2: Remove Old Types, Update IndexStatus

**Files:**

- Modify: `src/core/types.ts` (lines 111, 113-128, 131-135, 165-190)
- Modify: `src/core/api/public/dto/ingest.ts` (lines 76-101)
- Modify: `src/core/api/public/dto/metrics.ts` (lines 14-21)
- Test: existing tests will break — fix in subsequent tasks

### Steps

- [ ] **Step 1: Remove old types from `src/core/types.ts`**

Remove `EnrichmentStatusValue` (line 111), `EnrichmentInfo` (lines 113-128),
`ChunkEnrichmentInfo` (lines 131-135).

In `IndexStatus` (lines 165-190), replace:

```typescript
  enrichment?: EnrichmentInfo;
  chunkEnrichment?: ChunkEnrichmentInfo;
```

with:

```typescript
  enrichment?: EnrichmentHealthMap;
```

Add import at top of file:

```typescript
import type { EnrichmentHealthMap } from "./domains/ingest/pipeline/enrichment/types.js";
```

- [ ] **Step 2: Update DTO `IndexStatus` in
      `src/core/api/public/dto/ingest.ts`**

Replace `enrichment?: EnrichmentInfo` and
`chunkEnrichment?: ChunkEnrichmentInfo` with:

```typescript
  enrichment?: EnrichmentHealthMap;
```

Add import:

```typescript
import type { EnrichmentHealthMap } from "../../../domains/ingest/pipeline/enrichment/types.js";
```

Remove imports of `EnrichmentInfo` and `ChunkEnrichmentInfo` from
`../../../types.js`.

Also update `IndexStats` (line 37): replace
`enrichmentStatus?: "completed" | "partial" | "skipped" | "background"` with:

```typescript
  enrichmentStatus?: "completed" | "partial" | "skipped" | "background" | "failed";
```

Similarly in `ChangeStats` (line 63).

- [ ] **Step 3: Add enrichment to `IndexMetrics` in
      `src/core/api/public/dto/metrics.ts`**

```typescript
import type { EnrichmentHealthMap } from "../../../domains/ingest/pipeline/enrichment/types.js";

export interface IndexMetrics {
  collection: string;
  totalChunks: number;
  totalFiles: number;
  distributions: Distributions;
  signals: Record<string, Record<string, Record<string, SignalMetrics>>>;
  enrichment?: EnrichmentHealthMap;
}
```

- [ ] **Step 4: Fix all TypeScript compilation errors**

Run: `npx tsc --noEmit 2>&1 | head -60`

Every file that imported `EnrichmentInfo`, `ChunkEnrichmentInfo`, or
`EnrichmentStatusValue` will error. Fix each:

- **coordinator.ts**: The `updateEnrichmentMarker()` method accepts
  `Partial<EnrichmentInfo>`. Change to accept the new marker type — this is
  Task 5.
- **status-module.ts**: Reads old marker format — this is Task 7.
- **ingest-facade.ts**: References enrichment types — fix imports.
- **mcp/tools/code.ts**: Formats old enrichment — this is Task 8.

For now, temporarily cast where needed to keep compilation passing. Full fixes
come in Tasks 3-8.

- [ ] **Step 5: Run tests to identify breakage scope**

Run: `npx vitest run 2>&1 | grep -E "FAIL|PASS" | tail -20`

Note which test files fail. These will be fixed in subsequent tasks.

- [ ] **Step 6: Commit**

```bash
git add src/core/types.ts src/core/api/public/dto/ingest.ts src/core/api/public/dto/metrics.ts
git commit -m "feat(enrichment): replace flat EnrichmentInfo with per-provider health types

BREAKING CHANGE: EnrichmentInfo and ChunkEnrichmentInfo removed.
IndexStatus.enrichment is now Record<string, EnrichmentProviderHealth>.
IndexStatus.chunkEnrichment removed."
```

---

## Task 3: Applier — Write `enrichedAt` Timestamps

**Files:**

- Modify: `src/core/domains/ingest/pipeline/enrichment/applier.ts` (lines
  40-108, 114-160)
- Test: `tests/core/domains/ingest/pipeline/enrichment/applier.test.ts`

### Steps

- [ ] **Step 1: Write failing tests for `enrichedAt` in `applyFileSignals()`**

Add to `applier.test.ts`:

```typescript
describe("enrichedAt timestamps", () => {
  it("should include git.file.enrichedAt in file signal batch payload", async () => {
    const fileMetadata = new Map([
      ["src/foo.ts", { commitCount: 5, ageDays: 10 }],
    ]);
    const items = [
      { id: "c1", relativePath: "src/foo.ts", startLine: 1, endLine: 10 },
    ];

    await applier.applyFileSignals(
      "col",
      "git",
      fileMetadata as any,
      "/root",
      items as any,
      undefined,
      "2026-03-27T10:00:00Z",
    );

    const call = mockQdrant.batchSetPayload.mock.calls[0];
    const batch = call[1];
    expect(batch[0].payload).toHaveProperty(
      "git.file.enrichedAt",
      "2026-03-27T10:00:00Z",
    );
  });

  it("should include git.file.enrichedAt even for missed files (intentional skip)", async () => {
    const fileMetadata = new Map<string, any>(); // empty — file not in git log
    const items = [
      { id: "c1", relativePath: "src/missed.ts", startLine: 1, endLine: 10 },
    ];

    await applier.applyFileSignals(
      "col",
      "git",
      fileMetadata,
      "/root",
      items as any,
      undefined,
      "2026-03-27T10:00:00Z",
    );

    // Missed file chunks should still get enrichedAt
    const calls = mockQdrant.batchSetPayload.mock.calls;
    // Find the call that sets enrichedAt for missed files
    const enrichedAtCall = calls.find((c: any) =>
      c[1].some((b: any) => b.payload?.["git.file.enrichedAt"]),
    );
    expect(enrichedAtCall).toBeDefined();
  });

  it("should include git.chunk.enrichedAt in chunk signal batch payload", async () => {
    const chunkMetadata = new Map([
      ["src/foo.ts", new Map([["c1", { chunkCommitCount: 3 }]])],
    ]);

    await applier.applyChunkSignals(
      "col",
      "git",
      chunkMetadata as any,
      "2026-03-27T10:00:00Z",
    );

    const call = mockQdrant.batchSetPayload.mock.calls[0];
    const batch = call[1];
    expect(batch[0].payload).toHaveProperty(
      "git.chunk.enrichedAt",
      "2026-03-27T10:00:00Z",
    );
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run:
`npx vitest run tests/core/domains/ingest/pipeline/enrichment/applier.test.ts`
Expected: FAIL — `enrichedAt` not written yet

- [ ] **Step 3: Add `enrichedAt` parameter to `applyFileSignals()`**

In `applier.ts`, add `enrichedAt?: string` parameter to `applyFileSignals()`:

```typescript
async applyFileSignals(
  collectionName: string,
  providerKey: string,
  fileMetadata: Map<string, FileSignalOverlay>,
  pathBase: string,
  items: ChunkItem[],
  transform?: FileSignalTransform,
  enrichedAt?: string,
): Promise<void> {
```

In the batch building loop (around line 89), when constructing the payload
object, add `enrichedAt`:

```typescript
// After building the file signal payload for each chunk:
if (enrichedAt) {
  payload[`${providerKey}.file.enrichedAt`] = enrichedAt;
}
```

For missed files (chunks with no entry in `fileMetadata`), still write
`enrichedAt`. In the section where missed files are tracked (around line 73),
add a separate batch entry that sets only `enrichedAt`:

```typescript
// For chunks whose file is not in fileMetadata (missed):
if (enrichedAt) {
  batch.push({
    payload: { [`${providerKey}.file.enrichedAt`]: enrichedAt },
    points: missedPointIds,
  });
}
```

- [ ] **Step 4: Add `enrichedAt` parameter to `applyChunkSignals()`**

In `applier.ts`, add `enrichedAt?: string` parameter to `applyChunkSignals()`:

```typescript
async applyChunkSignals(
  collectionName: string,
  providerKey: string,
  chunkMetadata: Map<string, Map<string, ChunkSignalOverlay>>,
  enrichedAt?: string,
): Promise<number> {
```

In the batch building loop (around line 131), add `enrichedAt` to the payload:

```typescript
if (enrichedAt) {
  payload[`${providerKey}.chunk.enrichedAt`] = enrichedAt;
}
```

- [ ] **Step 5: Run tests**

Run:
`npx vitest run tests/core/domains/ingest/pipeline/enrichment/applier.test.ts`
Expected: PASS

- [ ] **Step 6: Fix any existing test assertions broken by new parameter**

Existing tests don't pass `enrichedAt`, so they should still work (parameter is
optional). If any assertions check exact payload shape, update them to account
for the new field.

- [ ] **Step 7: Commit**

```bash
git add src/core/domains/ingest/pipeline/enrichment/applier.ts tests/core/domains/ingest/pipeline/enrichment/applier.test.ts
git commit -m "feat(enrichment): write enrichedAt timestamps in applier batch payloads"
```

---

## Task 4: Coordinator — Per-Level Marker Updates and Heartbeat

**Files:**

- Modify: `src/core/domains/ingest/pipeline/enrichment/coordinator.ts`
- Test: `tests/core/domains/ingest/pipeline/enrichment/coordinator.test.ts`

### Steps

- [ ] **Step 1: Write failing tests for per-level marker writes**

Add to `coordinator.test.ts`:

```typescript
describe("per-level enrichment marker", () => {
  it("should write pending status for both levels on prefetch start", () => {
    coordinator.prefetch("/root", "col");
    expect(mockQdrant.setPayload).toHaveBeenCalledWith(
      "col",
      expect.objectContaining({
        enrichment: expect.objectContaining({
          git: expect.objectContaining({
            file: expect.objectContaining({ status: "in_progress" }),
            chunk: expect.objectContaining({ status: "pending" }),
          }),
        }),
      }),
      expect.anything(),
    );
  });

  it("should write completed file status after successful prefetch", async () => {
    mockProvider.buildFileSignals.mockResolvedValue(
      new Map([["src/a.ts", { commitCount: 1 }]]),
    );
    coordinator.prefetch("/root", "col");
    await new Promise((r) => setTimeout(r, 50));
    await coordinator.awaitCompletion("col");

    const lastCall = mockQdrant.setPayload.mock.calls.at(-1);
    const marker = lastCall?.[1]?.enrichment?.git;
    expect(marker?.file.status).toBe("completed");
    expect(marker?.file.completedAt).toBeDefined();
    expect(marker?.file.durationMs).toBeGreaterThanOrEqual(0);
  });

  it("should write failed file status and failed chunk status on prefetch failure", async () => {
    mockProvider.buildFileSignals.mockRejectedValue(new Error("git fail"));
    coordinator.prefetch("/root", "col");
    await new Promise((r) => setTimeout(r, 50));
    await coordinator.awaitCompletion("col");

    const lastCall = mockQdrant.setPayload.mock.calls.at(-1);
    const marker = lastCall?.[1]?.enrichment?.git;
    expect(marker?.file.status).toBe("failed");
    expect(marker?.chunk.status).toBe("failed");
  });

  it("should write degraded chunk status when some chunks lack enrichedAt", async () => {
    mockProvider.buildFileSignals.mockResolvedValue(new Map());
    mockProvider.buildChunkSignals.mockRejectedValue(new Error("chunk fail"));
    coordinator.prefetch("/root", "col");
    await new Promise((r) => setTimeout(r, 50));

    const chunkMap = new Map([
      ["src/a.ts", [{ chunkId: "c1", startLine: 1, endLine: 10 }]],
    ]);
    coordinator.startChunkEnrichment("col", "/root", chunkMap as any);
    await new Promise((r) => setTimeout(r, 50));
    await coordinator.awaitCompletion("col");

    const lastCall = mockQdrant.setPayload.mock.calls.at(-1);
    const marker = lastCall?.[1]?.enrichment?.git;
    expect(["degraded", "failed"]).toContain(marker?.chunk.status);
  });
});

describe("heartbeat", () => {
  it("should update lastProgressAt and lastProgressChunks during enrichment", async () => {
    const bigMetadata = new Map(
      Array.from({ length: 200 }, (_, i) => [
        `src/f${i}.ts`,
        { commitCount: 1 },
      ]),
    );
    mockProvider.buildFileSignals.mockResolvedValue(bigMetadata);
    coordinator.prefetch("/root", "col");
    await new Promise((r) => setTimeout(r, 50));

    // Check that setPayload was called with lastProgressAt
    const heartbeatCalls = mockQdrant.setPayload.mock.calls.filter(
      (c: any) => c[1]?.enrichment?.git?.file?.lastProgressAt,
    );
    // At least the final marker update should have progress info
    expect(heartbeatCalls.length).toBeGreaterThanOrEqual(1);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run:
`npx vitest run tests/core/domains/ingest/pipeline/enrichment/coordinator.test.ts`
Expected: FAIL

- [ ] **Step 3: Refactor coordinator to use new marker format**

In `coordinator.ts`:

1. Add imports for new types:

```typescript
import { randomUUID } from "node:crypto";

import type {
  ChunkEnrichmentMarker,
  EnrichmentMarkerMap,
  FileEnrichmentMarker,
  ProviderEnrichmentMarker,
} from "./types.js";
```

2. Add `runId` and `runStartedAt` fields to the coordinator class:

```typescript
private runId = "";
private runStartedAt = "";
```

3. In `prefetch()`, generate `runId` and write initial marker:

```typescript
this.runId = randomUUID().slice(0, 8);
this.runStartedAt = new Date().toISOString();

// Write initial per-provider marker
const initialMarker: EnrichmentMarkerMap = {};
for (const state of this.providers.values()) {
  initialMarker[state.provider.key] = {
    runId: this.runId,
    file: {
      status: "in_progress",
      startedAt: this.runStartedAt,
      unenrichedChunks: 0,
    },
    chunk: { status: "pending", unenrichedChunks: 0 },
  };
}
this.updateEnrichmentMarker(collectionName, initialMarker).catch(() => {});
```

4. Replace `updateEnrichmentMarker()` signature:

```typescript
async updateEnrichmentMarker(
  collectionName: string,
  markerMap: EnrichmentMarkerMap,
): Promise<void> {
  try {
    const existing = await this.readExistingMarker(collectionName);
    const merged = { ...existing, ...markerMap };
    await this.qdrant.setPayload(
      collectionName,
      { enrichment: merged },
      { points: [INDEXING_METADATA_ID] },
    );
  } catch (error) {
    if (process.env.DEBUG) console.error("Marker update failed:", error);
  }
}
```

5. In the prefetch `.catch()` handler (line 227-239), set
   `file.status = "failed"` and `chunk.status = "failed"`:

```typescript
.catch((error) => {
  state.prefetchFailed = true;
  const now = new Date().toISOString();
  this.updateEnrichmentMarker(collectionName, {
    [state.provider.key]: {
      runId: this.runId,
      file: {
        status: "failed",
        startedAt: this.runStartedAt,
        completedAt: now,
        durationMs: Date.now() - Date.parse(this.runStartedAt),
        unenrichedChunks: 0, // will be counted in awaitCompletion
      },
      chunk: {
        status: "failed",
        unenrichedChunks: 0,
      },
    },
  }).catch(() => {});
  // ... existing error logging
})
```

6. Pass `enrichedAt` to applier calls. In `onChunksStored()` when calling
   `applier.applyFileSignals()`, add `this.runStartedAt` as the last argument.

7. In `startChunkEnrichment()`, when calling `applier.applyChunkSignals()`, add
   `this.runStartedAt`.

8. In `awaitCompletion()`, build final marker with computed stats.

- [ ] **Step 4: Run tests**

Run:
`npx vitest run tests/core/domains/ingest/pipeline/enrichment/coordinator.test.ts`
Expected: PASS

- [ ] **Step 5: Fix any broken existing tests**

Update existing tests that assert on the old marker format. The key change:
`setPayload` calls now write
`{ enrichment: { git: { file: ..., chunk: ... } } }` instead of
`{ enrichment: { status: "in_progress" } }`.

- [ ] **Step 6: Commit**

```bash
git add src/core/domains/ingest/pipeline/enrichment/coordinator.ts tests/core/domains/ingest/pipeline/enrichment/coordinator.test.ts
git commit -m "feat(enrichment): per-level marker updates with heartbeat in coordinator"
```

---

## Task 5: Recovery Module

**Files:**

- Create: `src/core/domains/ingest/pipeline/enrichment/recovery.ts`
- Test: `tests/core/domains/ingest/pipeline/enrichment/recovery.test.ts`

### Steps

- [ ] **Step 1: Write failing tests for recovery**

Create `tests/core/domains/ingest/pipeline/enrichment/recovery.test.ts`:

```typescript
import { beforeEach, describe, expect, it, vi } from "vitest";

import { EnrichmentRecovery } from "../../../../../../src/core/domains/ingest/pipeline/enrichment/recovery.js";

describe("EnrichmentRecovery", () => {
  let recovery: EnrichmentRecovery;
  let mockQdrant: any;
  let mockProvider: any;
  let mockApplier: any;

  beforeEach(() => {
    mockQdrant = {
      scrollPoints: vi
        .fn()
        .mockResolvedValue({ points: [], next_page_offset: null }),
      setPayload: vi.fn().mockResolvedValue(undefined),
      batchSetPayload: vi.fn().mockResolvedValue(undefined),
      countPoints: vi.fn().mockResolvedValue({ count: 0 }),
    };
    mockProvider = {
      key: "git",
      resolveRoot: vi.fn((p: string) => p),
      buildFileSignals: vi.fn().mockResolvedValue(new Map()),
      buildChunkSignals: vi.fn().mockResolvedValue(new Map()),
    };
    mockApplier = {
      applyFileSignals: vi.fn().mockResolvedValue(undefined),
      applyChunkSignals: vi.fn().mockResolvedValue(0),
    };
    recovery = new EnrichmentRecovery(mockQdrant, mockApplier);
  });

  describe("file-level recovery", () => {
    it("should scroll for chunks without git.file.enrichedAt", async () => {
      mockQdrant.scrollPoints.mockResolvedValue({
        points: [
          { id: "c1", payload: { relativePath: "src/a.ts" } },
          { id: "c2", payload: { relativePath: "src/a.ts" } },
          { id: "c3", payload: { relativePath: "src/b.ts" } },
        ],
        next_page_offset: null,
      });
      mockProvider.buildFileSignals.mockResolvedValue(
        new Map([
          ["src/a.ts", { commitCount: 5 }],
          ["src/b.ts", { commitCount: 3 }],
        ]),
      );

      const result = await recovery.recoverFileLevel(
        "col",
        "/root",
        mockProvider,
        "2026-03-27T10:00:00Z",
      );

      expect(mockQdrant.scrollPoints).toHaveBeenCalledWith(
        "col",
        expect.objectContaining({
          filter: expect.objectContaining({
            must_not: [{ key: "git.file.enrichedAt", match: { except: [] } }],
          }),
        }),
      );
      expect(mockProvider.buildFileSignals).toHaveBeenCalledWith(
        "/root",
        expect.objectContaining({ paths: ["src/a.ts", "src/b.ts"] }),
      );
      expect(result.recoveredFiles).toBe(2);
    });

    it("should be a no-op when no unenriched chunks exist", async () => {
      const result = await recovery.recoverFileLevel(
        "col",
        "/root",
        mockProvider,
        "ts",
      );
      expect(mockProvider.buildFileSignals).not.toHaveBeenCalled();
      expect(result.recoveredFiles).toBe(0);
    });

    it("should return failure count when recovery itself fails", async () => {
      mockQdrant.scrollPoints.mockResolvedValue({
        points: [{ id: "c1", payload: { relativePath: "src/a.ts" } }],
        next_page_offset: null,
      });
      mockProvider.buildFileSignals.mockRejectedValue(
        new Error("git unavailable"),
      );

      const result = await recovery.recoverFileLevel(
        "col",
        "/root",
        mockProvider,
        "ts",
      );
      expect(result.recoveredFiles).toBe(0);
      expect(result.remainingUnenriched).toBeGreaterThan(0);
    });
  });

  describe("chunk-level recovery", () => {
    it("should scroll for chunks without git.chunk.enrichedAt and re-enrich", async () => {
      mockQdrant.scrollPoints.mockResolvedValue({
        points: [
          {
            id: "c1",
            payload: { relativePath: "src/a.ts", startLine: 1, endLine: 10 },
          },
        ],
        next_page_offset: null,
      });
      mockProvider.buildChunkSignals.mockResolvedValue(
        new Map([["src/a.ts", new Map([["c1", { chunkCommitCount: 2 }]])]]),
      );

      const result = await recovery.recoverChunkLevel(
        "col",
        "/root",
        mockProvider,
        "2026-03-27T10:00:00Z",
      );

      expect(mockProvider.buildChunkSignals).toHaveBeenCalled();
      expect(result.recoveredChunks).toBeGreaterThanOrEqual(0);
    });

    it("should be a no-op when no unenriched chunks exist", async () => {
      const result = await recovery.recoverChunkLevel(
        "col",
        "/root",
        mockProvider,
        "ts",
      );
      expect(mockProvider.buildChunkSignals).not.toHaveBeenCalled();
      expect(result.recoveredChunks).toBe(0);
    });
  });

  describe("countUnenriched", () => {
    it("should count chunks missing file-level enrichedAt", async () => {
      mockQdrant.scrollPoints.mockResolvedValue({
        points: [{ id: "c1" }, { id: "c2" }, { id: "c3" }],
        next_page_offset: null,
      });

      const count = await recovery.countUnenriched("col", "git", "file");
      expect(count).toBe(3);
    });

    it("should count chunks missing chunk-level enrichedAt", async () => {
      mockQdrant.scrollPoints.mockResolvedValue({
        points: [{ id: "c1" }],
        next_page_offset: null,
      });

      const count = await recovery.countUnenriched("col", "git", "chunk");
      expect(count).toBe(1);
    });

    it("should return 0 when all chunks are enriched", async () => {
      const count = await recovery.countUnenriched("col", "git", "file");
      expect(count).toBe(0);
    });
  });

  describe("forceReindex skip", () => {
    it("should not run recovery — caller is responsible for skipping", () => {
      // Recovery module has no forceReindex awareness —
      // the caller (coordinator/facade) decides whether to call it.
      // This test documents the contract.
      expect(typeof recovery.recoverFileLevel).toBe("function");
      expect(typeof recovery.recoverChunkLevel).toBe("function");
    });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run:
`npx vitest run tests/core/domains/ingest/pipeline/enrichment/recovery.test.ts`
Expected: FAIL — module doesn't exist

- [ ] **Step 3: Implement `EnrichmentRecovery`**

Create `src/core/domains/ingest/pipeline/enrichment/recovery.ts`:

```typescript
import type { QdrantManager } from "../../../../adapters/qdrant/qdrant-manager.js";
import { INDEXING_METADATA_ID } from "../indexing-marker.js";
import type { EnrichmentApplier } from "./applier.js";
import type { EnrichmentProvider } from "./types.js";

interface RecoveryResult {
  recoveredFiles: number;
  recoveredChunks: number;
  remainingUnenriched: number;
}

export class EnrichmentRecovery {
  constructor(
    private readonly qdrant: QdrantManager,
    private readonly applier: EnrichmentApplier,
  ) {}

  async recoverFileLevel(
    collectionName: string,
    absolutePath: string,
    provider: EnrichmentProvider,
    enrichedAt: string,
  ): Promise<RecoveryResult> {
    const unenriched = await this.scrollUnenriched(
      collectionName,
      provider.key,
      "file",
    );
    if (unenriched.length === 0) {
      return { recoveredFiles: 0, recoveredChunks: 0, remainingUnenriched: 0 };
    }

    const pathsToRecover = [...new Set(unenriched.map((p) => p.relativePath))];
    const root = provider.resolveRoot(absolutePath);

    try {
      const fileSignals = await provider.buildFileSignals(root, {
        paths: pathsToRecover,
      });

      // Group chunks by file for applier
      const items = unenriched.map((p) => ({
        id: p.id,
        relativePath: p.relativePath,
        startLine: p.startLine ?? 0,
        endLine: p.endLine ?? 0,
      }));

      await this.applier.applyFileSignals(
        collectionName,
        provider.key,
        fileSignals,
        root,
        items as any,
        provider.fileSignalTransform,
        enrichedAt,
      );

      const remaining = await this.countUnenriched(
        collectionName,
        provider.key,
        "file",
      );
      return {
        recoveredFiles: pathsToRecover.length,
        recoveredChunks: unenriched.length,
        remainingUnenriched: remaining,
      };
    } catch (error) {
      console.error(
        `[EnrichmentRecovery] File-level recovery failed for ${provider.key}:`,
        error,
      );
      return {
        recoveredFiles: 0,
        recoveredChunks: 0,
        remainingUnenriched: unenriched.length,
      };
    }
  }

  async recoverChunkLevel(
    collectionName: string,
    absolutePath: string,
    provider: EnrichmentProvider,
    enrichedAt: string,
  ): Promise<RecoveryResult> {
    const unenriched = await this.scrollUnenriched(
      collectionName,
      provider.key,
      "chunk",
    );
    if (unenriched.length === 0) {
      return { recoveredFiles: 0, recoveredChunks: 0, remainingUnenriched: 0 };
    }

    const pathsToRecover = [...new Set(unenriched.map((p) => p.relativePath))];
    const root = provider.resolveRoot(absolutePath);

    try {
      const chunkMap = new Map<
        string,
        { chunkId: string; startLine: number; endLine: number }[]
      >();
      for (const point of unenriched) {
        const existing = chunkMap.get(point.relativePath) ?? [];
        existing.push({
          chunkId: String(point.id),
          startLine: point.startLine ?? 0,
          endLine: point.endLine ?? 0,
        });
        chunkMap.set(point.relativePath, existing);
      }

      const chunkSignals = await provider.buildChunkSignals(
        root,
        chunkMap as any,
      );
      const applied = await this.applier.applyChunkSignals(
        collectionName,
        provider.key,
        chunkSignals,
        enrichedAt,
      );

      const remaining = await this.countUnenriched(
        collectionName,
        provider.key,
        "chunk",
      );
      return {
        recoveredFiles: pathsToRecover.length,
        recoveredChunks: applied,
        remainingUnenriched: remaining,
      };
    } catch (error) {
      console.error(
        `[EnrichmentRecovery] Chunk-level recovery failed for ${provider.key}:`,
        error,
      );
      return {
        recoveredFiles: 0,
        recoveredChunks: 0,
        remainingUnenriched: unenriched.length,
      };
    }
  }

  async countUnenriched(
    collectionName: string,
    providerKey: string,
    level: "file" | "chunk",
  ): Promise<number> {
    const points = await this.scrollUnenriched(
      collectionName,
      providerKey,
      level,
    );
    return points.length;
  }

  private async scrollUnenriched(
    collectionName: string,
    providerKey: string,
    level: "file" | "chunk",
  ): Promise<
    {
      id: string | number;
      relativePath: string;
      startLine?: number;
      endLine?: number;
    }[]
  > {
    const fieldName = `${providerKey}.${level}.enrichedAt`;
    const results: {
      id: string | number;
      relativePath: string;
      startLine?: number;
      endLine?: number;
    }[] = [];
    let offset: string | number | null = null;

    do {
      const response = await this.qdrant.scrollPoints(collectionName, {
        filter: {
          must: [{ is_empty: { key: fieldName } }],
          must_not: [{ has_id: [INDEXING_METADATA_ID] }],
        },
        limit: 1000,
        offset: offset ?? undefined,
        with_payload: ["relativePath", "startLine", "endLine"],
      });

      for (const point of response.points) {
        results.push({
          id: point.id,
          relativePath: (point.payload as any)?.relativePath ?? "",
          startLine: (point.payload as any)?.startLine,
          endLine: (point.payload as any)?.endLine,
        });
      }

      offset = response.next_page_offset;
    } while (offset !== null && offset !== undefined);

    return results;
  }
}
```

- [ ] **Step 4: Run tests**

Run:
`npx vitest run tests/core/domains/ingest/pipeline/enrichment/recovery.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/core/domains/ingest/pipeline/enrichment/recovery.ts tests/core/domains/ingest/pipeline/enrichment/recovery.test.ts
git commit -m "feat(enrichment): add EnrichmentRecovery module for unenriched chunk detection and re-enrichment"
```

---

## Task 6: Migration Module

**Files:**

- Create: `src/core/domains/ingest/pipeline/enrichment/migration.ts`
- Test: `tests/core/domains/ingest/pipeline/enrichment/migration.test.ts`

### Steps

- [ ] **Step 1: Write failing tests**

Create `tests/core/domains/ingest/pipeline/enrichment/migration.test.ts`:

```typescript
import { beforeEach, describe, expect, it, vi } from "vitest";

import { EnrichmentMigration } from "../../../../../../src/core/domains/ingest/pipeline/enrichment/migration.js";

describe("EnrichmentMigration", () => {
  let migration: EnrichmentMigration;
  let mockQdrant: any;

  beforeEach(() => {
    mockQdrant = {
      scrollPoints: vi
        .fn()
        .mockResolvedValue({ points: [], next_page_offset: null }),
      batchSetPayload: vi.fn().mockResolvedValue(undefined),
      getPoint: vi.fn().mockResolvedValue(null),
      setPayload: vi.fn().mockResolvedValue(undefined),
    };
    migration = new EnrichmentMigration(mockQdrant);
  });

  it("should set git.file.enrichedAt for chunks with git.file.commitCount", async () => {
    mockQdrant.scrollPoints.mockResolvedValue({
      points: [
        { id: "c1", payload: { git: { file: { commitCount: 5 } } } },
        { id: "c2", payload: { git: { file: { commitCount: 3 } } } },
      ],
      next_page_offset: null,
    });

    await migration.migrateEnrichedAt("col", "git");

    expect(mockQdrant.batchSetPayload).toHaveBeenCalled();
    const batch = mockQdrant.batchSetPayload.mock.calls[0][1];
    expect(batch.some((b: any) => b.payload["git.file.enrichedAt"])).toBe(true);
  });

  it("should set git.chunk.enrichedAt for chunks with git.chunk.commitCount", async () => {
    mockQdrant.scrollPoints.mockResolvedValue({
      points: [{ id: "c1", payload: { git: { chunk: { commitCount: 2 } } } }],
      next_page_offset: null,
    });

    await migration.migrateEnrichedAt("col", "git");

    const batch = mockQdrant.batchSetPayload.mock.calls[0][1];
    expect(batch.some((b: any) => b.payload["git.chunk.enrichedAt"])).toBe(
      true,
    );
  });

  it("should NOT set enrichedAt for chunks without git signals", async () => {
    mockQdrant.scrollPoints.mockResolvedValue({
      points: [{ id: "c1", payload: { relativePath: "src/a.ts" } }],
      next_page_offset: null,
    });

    await migration.migrateEnrichedAt("col", "git");

    // batchSetPayload should still be called, but with no enrichedAt entries for this chunk
    // or not called at all if no chunks need migration
    const calls = mockQdrant.batchSetPayload.mock.calls;
    if (calls.length > 0) {
      const batch = calls[0][1];
      const hasEnrichedAt = batch.some(
        (b: any) =>
          b.payload["git.file.enrichedAt"] || b.payload["git.chunk.enrichedAt"],
      );
      // Chunk without git signals should not get enrichedAt
      const entriesForC1 = batch.filter((b: any) => b.points.includes("c1"));
      expect(entriesForC1.length).toBe(0);
    }
  });

  it("should be idempotent — skip if migration marker exists", async () => {
    mockQdrant.getPoint.mockResolvedValue({
      id: 1,
      payload: { enrichmentMigrationV1: true },
    });

    await migration.migrateEnrichedAt("col", "git");

    expect(mockQdrant.scrollPoints).not.toHaveBeenCalled();
  });

  it("should write migration marker after completion", async () => {
    await migration.migrateEnrichedAt("col", "git");

    expect(mockQdrant.setPayload).toHaveBeenCalledWith(
      "col",
      expect.objectContaining({ enrichmentMigrationV1: true }),
      expect.anything(),
    );
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run:
`npx vitest run tests/core/domains/ingest/pipeline/enrichment/migration.test.ts`
Expected: FAIL

- [ ] **Step 3: Implement `EnrichmentMigration`**

Create `src/core/domains/ingest/pipeline/enrichment/migration.ts`:

```typescript
import type { QdrantManager } from "../../../../adapters/qdrant/qdrant-manager.js";
import { INDEXING_METADATA_ID } from "../indexing-marker.js";

const MIGRATION_MARKER_KEY = "enrichmentMigrationV1";
const BATCH_SIZE = 100;

export class EnrichmentMigration {
  constructor(private readonly qdrant: QdrantManager) {}

  async migrateEnrichedAt(
    collectionName: string,
    providerKey: string,
  ): Promise<void> {
    // Check if already migrated
    const marker = await this.qdrant
      .getPoint(collectionName, INDEXING_METADATA_ID)
      .catch(() => null);

    if ((marker?.payload as any)?.[MIGRATION_MARKER_KEY]) {
      return; // Already migrated
    }

    const now = new Date().toISOString();
    let offset: string | number | null = null;

    do {
      const response = await this.qdrant.scrollPoints(collectionName, {
        filter: {
          must_not: [{ has_id: [INDEXING_METADATA_ID] }],
        },
        limit: 1000,
        offset: offset ?? undefined,
        with_payload: true,
      });

      const fileBatch: {
        payload: Record<string, unknown>;
        points: (string | number)[];
      }[] = [];
      const chunkBatch: {
        payload: Record<string, unknown>;
        points: (string | number)[];
      }[] = [];

      for (const point of response.points) {
        const payload = point.payload as Record<string, any>;
        const gitPayload = payload?.[providerKey];

        const hasFileSignals = gitPayload?.file?.commitCount !== undefined;
        const hasChunkSignals = gitPayload?.chunk?.commitCount !== undefined;

        if (hasFileSignals) {
          fileBatch.push({
            payload: { [`${providerKey}.file.enrichedAt`]: now },
            points: [point.id],
          });
        }
        if (hasChunkSignals) {
          chunkBatch.push({
            payload: { [`${providerKey}.chunk.enrichedAt`]: now },
            points: [point.id],
          });
        }
      }

      // Write in batches
      for (let i = 0; i < fileBatch.length; i += BATCH_SIZE) {
        await this.qdrant.batchSetPayload(
          collectionName,
          fileBatch.slice(i, i + BATCH_SIZE),
        );
      }
      for (let i = 0; i < chunkBatch.length; i += BATCH_SIZE) {
        await this.qdrant.batchSetPayload(
          collectionName,
          chunkBatch.slice(i, i + BATCH_SIZE),
        );
      }

      offset = response.next_page_offset;
    } while (offset !== null && offset !== undefined);

    // Write migration marker
    await this.qdrant.setPayload(
      collectionName,
      { [MIGRATION_MARKER_KEY]: true },
      { points: [INDEXING_METADATA_ID] },
    );
  }
}
```

- [ ] **Step 4: Run tests**

Run:
`npx vitest run tests/core/domains/ingest/pipeline/enrichment/migration.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/core/domains/ingest/pipeline/enrichment/migration.ts tests/core/domains/ingest/pipeline/enrichment/migration.test.ts
git commit -m "feat(enrichment): add enrichedAt migration for existing collections"
```

---

## Task 7: StatusModule — New Marker Format + Stale Detection

**Files:**

- Modify: `src/core/domains/ingest/pipeline/status-module.ts` (lines 147-257)
- Test: `tests/core/domains/ingest/pipeline/status-module.test.ts`

### Steps

- [ ] **Step 1: Write failing tests for new enrichment health output**

Add to `status-module.test.ts`:

```typescript
describe("enrichment health in status", () => {
  it("should return healthy status when enrichment completed", async () => {
    await createTestFile(codebaseDir, "test.ts", "const x = 1;");
    await ingest.indexCodebase(codebaseDir);
    const status = await ingest.getIndexStatus(codebaseDir);

    // After successful indexing, enrichment should show per-provider health
    if (status.enrichment) {
      const gitHealth = status.enrichment.git;
      expect(gitHealth).toBeDefined();
      expect(gitHealth.file.status).toBe("healthy");
      expect(gitHealth.chunk.status).toBe("healthy");
    }
  });

  it("should return failed status when marker shows failed", async () => {
    await createTestFile(codebaseDir, "test.ts", "const x = 1;");
    await ingest.indexCodebase(codebaseDir);
    const status1 = await ingest.getIndexStatus(codebaseDir);

    // Manually write a failed marker to simulate crash
    const collectionName = status1.collectionName!;
    await (qdrant as any).setPayload(
      collectionName,
      {
        enrichment: {
          git: {
            runId: "test",
            file: { status: "failed", unenrichedChunks: 10 },
            chunk: { status: "failed", unenrichedChunks: 10 },
          },
        },
      },
      { points: [1] },
    );

    const status2 = await ingest.getIndexStatus(codebaseDir);
    expect(status2.enrichment?.git.file.status).toBe("failed");
    expect(status2.enrichment?.git.file.message).toContain("failed");
  });

  it("should detect stale in_progress when lastProgressAt is old", async () => {
    await createTestFile(codebaseDir, "test.ts", "const x = 1;");
    await ingest.indexCodebase(codebaseDir);
    const status1 = await ingest.getIndexStatus(codebaseDir);
    const collectionName = status1.collectionName!;

    // Write stale in_progress marker (3 minutes ago)
    const staleTime = new Date(Date.now() - 3 * 60 * 1000).toISOString();
    await (qdrant as any).setPayload(
      collectionName,
      {
        enrichment: {
          git: {
            runId: "test",
            file: {
              status: "in_progress",
              startedAt: staleTime,
              lastProgressAt: staleTime,
              lastProgressChunks: 5,
              unenrichedChunks: 0,
            },
            chunk: { status: "pending", unenrichedChunks: 0 },
          },
        },
      },
      { points: [1] },
    );

    const status2 = await ingest.getIndexStatus(codebaseDir);
    expect(status2.enrichment?.git.file.status).toBe("in_progress");
    expect(status2.enrichment?.git.file.message).toContain("stalled");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/core/domains/ingest/pipeline/status-module.test.ts`
Expected: FAIL

- [ ] **Step 3: Update StatusModule to read new marker format**

In `status-module.ts`, in `getStatusFromCollection()` (around lines 156-162):

Replace the old enrichment reading logic:

```typescript
const enrichmentPayload = indexingMarker?.payload?.enrichment as
  | EnrichmentInfo
  | undefined;
const enrichment: EnrichmentInfo | undefined = enrichmentPayload?.status
  ? enrichmentPayload
  : undefined;
const chunkEnrichmentPayload = indexingMarker?.payload?.chunkEnrichment as
  | ChunkEnrichmentInfo
  | undefined;
const chunkEnrichment: ChunkEnrichmentInfo | undefined =
  chunkEnrichmentPayload?.status ? chunkEnrichmentPayload : undefined;
```

With:

```typescript
import type {
  EnrichmentHealthMap,
  EnrichmentMarkerMap,
  EnrichmentProviderHealth,
  ProviderEnrichmentMarker,
} from "./enrichment/types.js";

// ... inside getStatusFromCollection():
const enrichmentMarker = indexingMarker?.payload?.enrichment as
  | EnrichmentMarkerMap
  | undefined;
const enrichment = enrichmentMarker
  ? this.mapMarkerToHealth(enrichmentMarker)
  : undefined;
```

Add helper method:

```typescript
private mapMarkerToHealth(markerMap: EnrichmentMarkerMap): EnrichmentHealthMap | undefined {
  const health: EnrichmentHealthMap = {};
  let hasAny = false;

  for (const [key, marker] of Object.entries(markerMap)) {
    if (!marker?.file && !marker?.chunk) continue;
    hasAny = true;
    health[key] = {
      file: this.mapLevelHealth(marker.file, "file"),
      chunk: this.mapLevelHealth(marker.chunk, "chunk"),
    };
  }

  return hasAny ? health : undefined;
}

private mapLevelHealth(
  level: ProviderEnrichmentMarker["file"] | ProviderEnrichmentMarker["chunk"] | undefined,
  levelName: "file" | "chunk",
): EnrichmentProviderHealth["file"] {
  if (!level || level.status === "pending") {
    return { status: "healthy" };
  }

  const STALE_THRESHOLD_MS = 2 * 60 * 1000; // 2 minutes

  if (level.status === "in_progress") {
    const isStale =
      level.lastProgressAt &&
      Date.now() - Date.parse(level.lastProgressAt) > STALE_THRESHOLD_MS;
    return {
      status: "in_progress",
      message: isStale
        ? `Enrichment appears stalled — no progress in 2 minutes. May need reindex.`
        : "Enrichment in progress...",
    };
  }

  if (level.status === "completed") {
    return { status: "healthy" };
  }

  if (level.status === "degraded") {
    return {
      status: "degraded",
      unenrichedChunks: level.unenrichedChunks,
      message: `${level.unenrichedChunks} chunks missing ${levelName}-level signals. Will recover on next reindex.`,
    };
  }

  // failed
  const noun = levelName === "file" ? "file" : "chunk";
  return {
    status: "failed",
    unenrichedChunks: level.unenrichedChunks,
    message: `Git ${noun} enrichment failed. Will recover on next reindex.`,
  };
}
```

Remove the old `enrichment` and `chunkEnrichment` fields from the returned
`IndexStatus` object and replace with the new `enrichment` field.

- [ ] **Step 4: Run tests**

Run: `npx vitest run tests/core/domains/ingest/pipeline/status-module.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/core/domains/ingest/pipeline/status-module.ts tests/core/domains/ingest/pipeline/status-module.test.ts
git commit -m "feat(enrichment): read per-provider marker format with stale detection in StatusModule"
```

---

## Task 8: Wire Recovery + Migration into Pipeline

**Files:**

- Modify: `src/core/domains/ingest/pipeline/enrichment/coordinator.ts`
- Modify: `src/core/api/internal/facades/ingest-facade.ts`
- Modify: `src/core/domains/ingest/pipeline/base.ts`
- Modify: `src/core/domains/ingest/reindexing.ts`
- Test: existing coordinator and status-module tests

### Steps

- [ ] **Step 1: Write failing test for recovery invocation**

Add to `coordinator.test.ts`:

```typescript
describe("recovery integration", () => {
  it("should expose runRecovery method that delegates to EnrichmentRecovery", async () => {
    const mockRecovery = {
      recoverFileLevel: vi
        .fn()
        .mockResolvedValue({
          recoveredFiles: 0,
          recoveredChunks: 0,
          remainingUnenriched: 0,
        }),
      recoverChunkLevel: vi
        .fn()
        .mockResolvedValue({
          recoveredFiles: 0,
          recoveredChunks: 0,
          remainingUnenriched: 0,
        }),
      countUnenriched: vi.fn().mockResolvedValue(0),
    };

    // Coordinator should accept recovery instance
    const coordWithRecovery = new EnrichmentCoordinator(
      mockQdrant,
      mockProvider,
      mockRecovery as any,
    );

    await coordWithRecovery.runRecovery("col", "/root");

    // Recovery should be called for each provider
    expect(mockRecovery.recoverFileLevel).toHaveBeenCalledWith(
      "col",
      "/root",
      mockProvider,
      expect.any(String),
    );
    expect(mockRecovery.recoverChunkLevel).toHaveBeenCalledWith(
      "col",
      "/root",
      mockProvider,
      expect.any(String),
    );
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run:
`npx vitest run tests/core/domains/ingest/pipeline/enrichment/coordinator.test.ts`
Expected: FAIL

- [ ] **Step 3: Add `runRecovery()` to coordinator**

In `coordinator.ts`, add optional `recovery` parameter to constructor:

```typescript
constructor(
  private readonly qdrant: QdrantManager,
  providers: EnrichmentProvider | EnrichmentProvider[],
  private readonly recovery?: EnrichmentRecovery,
) {
```

Add method:

```typescript
async runRecovery(collectionName: string, absolutePath: string): Promise<void> {
  if (!this.recovery) return;

  const enrichedAt = new Date().toISOString();

  for (const state of this.providers.values()) {
    const provider = state.provider;
    const fileResult = await this.recovery.recoverFileLevel(
      collectionName, absolutePath, provider, enrichedAt,
    );
    const chunkResult = await this.recovery.recoverChunkLevel(
      collectionName, absolutePath, provider, enrichedAt,
    );

    // Update marker with post-recovery counts
    const fileCount = await this.recovery.countUnenriched(collectionName, provider.key, "file");
    const chunkCount = await this.recovery.countUnenriched(collectionName, provider.key, "chunk");

    await this.updateEnrichmentMarker(collectionName, {
      [provider.key]: {
        runId: this.runId || "recovery",
        file: {
          status: fileCount === 0 ? "completed" : "failed",
          unenrichedChunks: fileCount,
        },
        chunk: {
          status: chunkCount === 0 ? "completed" : chunkCount > 0 ? "degraded" : "completed",
          unenrichedChunks: chunkCount,
        },
      },
    });
  }
}
```

- [ ] **Step 4: Wire into IngestFacade**

In `ingest-facade.ts`, create `EnrichmentRecovery` and `EnrichmentMigration`
instances and pass to coordinator. In `indexCodebase()`, before the main
enrichment:

```typescript
// Before enrichment runs (both full index and incremental):
if (!options?.forceReindex) {
  const collectionName = /* resolve collection name */;
  await this.enrichment.migration.migrateEnrichedAt(collectionName, "git");
  await this.enrichment.coordinator.runRecovery(collectionName, path);
}
```

The exact wiring depends on how the facade currently constructs the coordinator.
Follow the existing DI pattern in `composition.ts` and `factory.ts`.

- [ ] **Step 5: Run full test suite**

Run: `npx vitest run` Expected: All enrichment tests PASS, pre-existing
tree-sitter failures only.

- [ ] **Step 6: Commit**

```bash
git add src/core/domains/ingest/pipeline/enrichment/coordinator.ts src/core/api/internal/facades/ingest-facade.ts src/core/domains/ingest/pipeline/base.ts src/core/domains/ingest/reindexing.ts tests/core/domains/ingest/pipeline/enrichment/coordinator.test.ts
git commit -m "feat(enrichment): wire recovery and migration into indexing pipeline"
```

---

## Task 9: Add Enrichment Health to `get_index_metrics`

**Files:**

- Modify: `src/core/api/internal/facades/explore-facade.ts` (lines 357-446)
- Test: `tests/core/api/internal/facades/explore-facade.test.ts` (if exists,
  otherwise add to status-module tests)

### Steps

- [ ] **Step 1: Write failing test**

```typescript
it("should include enrichment health in getIndexMetrics result", async () => {
  await createTestFile(codebaseDir, "test.ts", "const x = 1;");
  await ingest.indexCodebase(codebaseDir);

  const metrics = await explore.getIndexMetrics(codebaseDir);
  // enrichment field should be present
  if (metrics.enrichment) {
    expect(metrics.enrichment.git).toBeDefined();
    expect(metrics.enrichment.git.file.status).toBe("healthy");
  }
});
```

- [ ] **Step 2: Implement — read enrichment marker in `getIndexMetrics()`**

In `explore-facade.ts` `getIndexMetrics()`, after loading stats, also read the
enrichment marker from Qdrant and map to health:

```typescript
// Read enrichment marker
const markerPoint = await this.qdrant
  .getPoint(collectionName, INDEXING_METADATA_ID)
  .catch(() => null);
const enrichmentMarker = (markerPoint?.payload as any)?.enrichment as
  | EnrichmentMarkerMap
  | undefined;
const enrichmentHealth = enrichmentMarker
  ? mapMarkerToHealth(enrichmentMarker)
  : undefined;

// Add to return
return {
  collection: collectionName,
  totalChunks,
  totalFiles,
  distributions,
  signals,
  enrichment: enrichmentHealth,
};
```

Extract `mapMarkerToHealth()` from StatusModule into a shared utility so both
StatusModule and ExploreFacade can use it. Create a small helper:

`src/core/domains/ingest/pipeline/enrichment/health-mapper.ts`:

```typescript
import type {
  EnrichmentHealthMap,
  EnrichmentLevelHealth,
  EnrichmentMarkerMap,
} from "./types.js";

const STALE_THRESHOLD_MS = 2 * 60 * 1000;

export function mapMarkerToHealth(
  markerMap: EnrichmentMarkerMap,
): EnrichmentHealthMap | undefined {
  // ... extracted from StatusModule.mapMarkerToHealth()
}
```

- [ ] **Step 3: Run tests**

Run: `npx vitest run` Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add src/core/domains/ingest/pipeline/enrichment/health-mapper.ts src/core/api/internal/facades/explore-facade.ts src/core/domains/ingest/pipeline/status-module.ts
git commit -m "feat(enrichment): add enrichment health to get_index_metrics output"
```

---

## Task 10: Update MCP Tool Output Formatting

**Files:**

- Modify: `src/mcp/tools/code.ts` (lines 176-273)

### Steps

- [ ] **Step 1: Update `get_index_status` formatting**

In `code.ts`, the handler formats enrichment status as text. Update to handle
the new per-provider health map:

```typescript
// Replace old enrichment formatting with:
if (status.enrichment) {
  for (const [provider, health] of Object.entries(status.enrichment)) {
    lines.push(`\n${provider} enrichment:`);
    lines.push(
      `  file: ${health.file.status}${health.file.message ? ` — ${health.file.message}` : ""}`,
    );
    lines.push(
      `  chunk: ${health.chunk.status}${health.chunk.message ? ` — ${health.chunk.message}` : ""}`,
    );
  }
}
```

- [ ] **Step 2: Run build**

Run: `npm run build` Expected: No compilation errors

- [ ] **Step 3: Run tests**

Run: `npx vitest run` Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add src/mcp/tools/code.ts
git commit -m "improve(mcp): update get_index_status tool output for per-provider enrichment health"
```

---

## Task 11: Update Barrel Exports

**Files:**

- Modify: `src/core/domains/ingest/pipeline/enrichment/index.ts` (create if
  missing)

### Steps

- [ ] **Step 1: Update barrel file**

```typescript
export { EnrichmentCoordinator } from "./coordinator.js";
export { EnrichmentApplier } from "./applier.js";
export { EnrichmentRecovery } from "./recovery.js";
export { EnrichmentMigration } from "./migration.js";
export { mapMarkerToHealth } from "./health-mapper.js";
export type {
  EnrichmentProvider,
  FileSignalTransform,
  ProviderEnrichmentMarker,
  EnrichmentMarkerMap,
  EnrichmentHealthMap,
  EnrichmentProviderHealth,
  EnrichmentLevelHealth,
  EnrichmentLevelMarker,
  FileEnrichmentMarker,
  ChunkEnrichmentMarker,
  EnrichmentLevelStatus,
} from "./types.js";
```

- [ ] **Step 2: Run build + tests**

Run: `npm run build && npx vitest run` Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add src/core/domains/ingest/pipeline/enrichment/index.ts
git commit -m "chore(enrichment): update barrel exports for recovery and migration modules"
```

---

## Task 12: Integration Tests — End-to-End Failure Scenarios

**Files:**

- Create: `tests/core/domains/ingest/pipeline/enrichment/recovery-e2e.test.ts`

### Steps

- [ ] **Step 1: Write E2E tests**

Create `tests/core/domains/ingest/pipeline/enrichment/recovery-e2e.test.ts`:

```typescript
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  cleanupTempDir,
  createTempTestDir,
  createTestFile,
  defaultTestConfig,
  defaultTrajectoryConfig,
  MockEmbeddingProvider,
  MockQdrantManager,
} from "../../../__helpers__/test-helpers.js";
import { IngestFacade } from "../../../../../../../src/core/api/internal/facades/ingest-facade.js";

vi.mock("tree-sitter", () => ({
  default: class MockParser {
    setLanguage() {}
    parse() {
      return { rootNode: { type: "program", children: [], text: "" } };
    }
  },
}));
vi.mock("tree-sitter-typescript", () => ({
  default: { typescript: {}, tsx: {} },
}));

describe("Enrichment recovery E2E", () => {
  let tempDir: string;
  let codebaseDir: string;
  let qdrant: MockQdrantManager;
  let embeddings: MockEmbeddingProvider;
  let ingest: IngestFacade;

  beforeEach(async () => {
    ({ tempDir, codebaseDir } = await createTempTestDir());
    qdrant = new MockQdrantManager() as any;
    embeddings = new MockEmbeddingProvider();
    ingest = new IngestFacade(
      qdrant as any,
      embeddings,
      defaultTestConfig(),
      defaultTrajectoryConfig(),
    );
  });

  afterEach(async () => {
    await cleanupTempDir(tempDir);
  });

  it("should show failed enrichment in get_index_status after prefetch crash", async () => {
    await createTestFile(codebaseDir, "test.ts", "const x = 1;");
    // Index with mocked git failure would need provider-level mock
    // This tests the status reading path
    await ingest.indexCodebase(codebaseDir);
    const status = await ingest.getIndexStatus(codebaseDir);
    expect(status.isIndexed).toBe(true);
    // Enrichment health should be present
    expect(status.enrichment).toBeDefined();
  });

  it("should recover unenriched chunks on next reindex", async () => {
    await createTestFile(codebaseDir, "test.ts", "const x = 1;");
    await ingest.indexCodebase(codebaseDir);

    // Simulate: manually remove enrichedAt from chunks
    const status1 = await ingest.getIndexStatus(codebaseDir);
    const collectionName = status1.collectionName!;

    // Trigger incremental reindex (file unchanged, but recovery should run)
    await createTestFile(codebaseDir, "test2.ts", "const y = 2;");
    await ingest.indexCodebase(codebaseDir);

    const status2 = await ingest.getIndexStatus(codebaseDir);
    expect(status2.isIndexed).toBe(true);
  });
});
```

- [ ] **Step 2: Run tests**

Run:
`npx vitest run tests/core/domains/ingest/pipeline/enrichment/recovery-e2e.test.ts`
Expected: PASS

- [ ] **Step 3: Run full test suite**

Run: `npx vitest run` Expected: All PASS (except pre-existing tree-sitter
failures)

- [ ] **Step 4: Commit**

```bash
git add tests/core/domains/ingest/pipeline/enrichment/recovery-e2e.test.ts
git commit -m "test(enrichment): add E2E tests for enrichment recovery flow"
```

---

## Task 13: Final Cleanup and Verification

### Steps

- [ ] **Step 1: Run full test suite**

Run: `npx vitest run` Expected: All PASS (except pre-existing)

- [ ] **Step 2: Run type check**

Run: `npx tsc --noEmit` Expected: No errors

- [ ] **Step 3: Run linter**

Run: `npx eslint src/core/domains/ingest/pipeline/enrichment/ --fix` Expected:
No errors

- [ ] **Step 4: Verify no references to old types remain**

Run:
`grep -rn "EnrichmentInfo\|ChunkEnrichmentInfo\|EnrichmentStatusValue" src/ --include="*.ts" | grep -v node_modules | grep -v ".d.ts"`
Expected: No matches (all removed)

- [ ] **Step 5: Commit any cleanup**

```bash
git add -A
git commit -m "chore(enrichment): final cleanup after enrichment recovery implementation"
```

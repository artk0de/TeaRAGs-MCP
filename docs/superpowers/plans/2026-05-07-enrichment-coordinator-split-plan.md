# EnrichmentCoordinator Split — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `dinopowers:executing-plans`
> (NOT `superpowers:executing-plans`) and `dinopowers:test-driven-development`
> (NOT `superpowers:test-driven-development`) for the failing-test-first phases.
> Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Split the 980-line `EnrichmentCoordinator` god-class into 5 focused
components + a slim façade, in 8 incremental Tasks each ending green and
committable, without changing the public API.

**Architecture:** Façade-with-collaborators. `EnrichmentCoordinator` becomes a
~180-line wiring layer that holds `Map<providerKey, ProviderContext>` and
delegates to 5 internal collaborators: `EnrichmentMarkerStore`, `FilePhase`,
`ChunkPhase`, `EnrichmentBackfiller`, `CompletionRunner`. Hot risky internals
(`applier.applyFileSignals` 95-line block, `recovery.scrollUnenriched`
bugFixRate-70 query) are isolated behind narrow accessors, never rewritten.

**Tech Stack:** TypeScript (strict), vitest, lint-staged (prettier + tsc
pre-commit). Target: `src/core/domains/ingest/pipeline/enrichment/`.

**Spec:**
`docs/superpowers/specs/2026-05-07-enrichment-coordinator-split-design.md`
(commit `1e6b6e95`). Read it before drafting any change.

---

## Affected Files (tea-rags impact enrichment, rerank: imports+churn+ownership)

| File                                                                                                | Owner                                     | Churn               | Age         | Bugs                                                    | Tasks         |
| --------------------------------------------------------------------------------------------------- | ----------------------------------------- | ------------------- | ----------- | ------------------------------------------------------- | ------------- |
| `src/core/domains/ingest/pipeline/enrichment/coordinator.ts`                                        | Arthur 61% (shared with Artur — same UID) | 15 commits **high** | recent (0d) | **47% concerning** (file-level)                         | 1–8           |
| `src/core/domains/ingest/pipeline/enrichment/applier.ts`                                            | Artur 64% (2 authors, same person)        | 5 commits typical   | recent (0d) | **58% concerning** (block 85-228, churnVolatility 9.08) | 2             |
| `src/core/domains/ingest/pipeline/enrichment/recovery.ts`                                           | Arthur 100% **deep-silo**                 | 4 commits typical   | 37d         | **70% critical** (`scrollUnenriched`)                   | 3             |
| `src/core/domains/ingest/pipeline/enrichment/types.ts`                                              | Arthur 100% deep-silo                     | 3 commits low       | 14d         | —                                                       | 1, 4–8        |
| `src/core/domains/ingest/pipeline/enrichment/index.ts`                                              | Arthur 100% deep-silo                     | 1 commit low        | 39d         | —                                                       | 8             |
| `tests/core/domains/ingest/pipeline/enrichment/coordinator.test.ts`                                 | (existing, 72 KB)                         | —                   | —           | —                                                       | 8             |
| `tests/core/domains/ingest/pipeline/enrichment/recovery.test.ts`                                    | (existing, 13 KB)                         | —                   | —           | —                                                       | 3             |
| `marker-store.ts`, `file-phase.ts`, `chunk-phase.ts`, `backfiller.ts`, `completion-runner.ts` (NEW) | — (new)                                   | —                   | —           | —                                                       | 1–7           |
| 5× NEW test files (one per new component)                                                           | — (new)                                   | —                   | —           | —                                                       | 1, 2, 5, 6, 7 |

**Coordinated change candidates** (shared `taskIds`): none — git data carries no
taskIds across these files. Plan ordering follows the spec's architectural
dependencies, not git.

**High-blast-radius file:** `coordinator.ts` is imported by `IngestFacade` and
`pipeline/index-ops.ts`. Public API stays frozen for all 8 Tasks.

**Out of scope (do NOT modify):**

- `applier.applyFileSignals` lines 85-228 (95-line block, bugFixRate 58)
- `recovery.scrollUnenriched`, `recovery.recoverFileLevel`,
  `recovery.recoverChunkLevel` (bugFixRate 70 critical)
- `health-mapper.ts`
- `EnrichmentProvider` interface and trajectory provider implementations
- Multi-provider missed-counter conflation in `EnrichmentApplier` (pre-existing
  bug — out of scope)

---

## Beads Epic — create FIRST, before Task 1

```bash
bd dolt pull
bd create \
  --title="Refactor: split EnrichmentCoordinator into 5 components + slim façade" \
  --description="Spec: docs/superpowers/specs/2026-05-07-enrichment-coordinator-split-design.md (commit 1e6b6e95). 8-step incremental migration. Public API frozen throughout. Each Task = single commit, green vitest, runnable Coordinator." \
  --type=epic \
  --priority=2
# Returns an issue ID — capture it as $EPIC (e.g. tea-rags-mcp-XXX) and use below.
bd label add $EPIC architecture
```

Each subsequent Task creates a beads task and links it to `$EPIC` and to the
previous Task. Capture each returned ID as `$T1`…`$T8`.

---

## Task 1: Extract `EnrichmentMarkerStore`

**Goal:** Move all 5 marker-write call-sites and the deep-merge logic out of
`EnrichmentCoordinator` into a new `EnrichmentMarkerStore` with 7
domain-specific methods. This directly addresses the 47% bugFixRate from
scattered marker writes.

**Beads:**

```bash
bd dolt pull
bd create \
  --title="Extract EnrichmentMarkerStore with domain-specific write methods" \
  --description="Create src/core/domains/ingest/pipeline/enrichment/marker-store.ts with markStart, markPrefetchFailed, markRecoveryResult, markFileFinal, markChunkFinal, read, getRunId. Replace all 5 updateEnrichmentMarker call-sites in coordinator.ts. Remove updateEnrichmentMarker + readExistingMarker + readRunId + ProviderMarkerUpdate from coordinator.ts. Tests in marker-store.test.ts." \
  --type=task \
  --priority=2
# Capture as $T1
bd label add $T1 architecture
bd label add $T1 bugfix
bd dep add $T1 $EPIC
```

**Files:**

- Create: `src/core/domains/ingest/pipeline/enrichment/marker-store.ts`
- Create: `tests/core/domains/ingest/pipeline/enrichment/marker-store.test.ts`
- Modify: `src/core/domains/ingest/pipeline/enrichment/coordinator.ts` (remove
  `updateEnrichmentMarker`, `readExistingMarker`, `readRunId`,
  `ProviderMarkerUpdate`; replace 5 call-sites)
- Modify: `src/core/domains/ingest/pipeline/enrichment/types.ts` (add
  `FileFinalInput`, `ChunkFinalInput`, `RecoveryResultInput`)

---

- [ ] **Step 1: Mark task in progress**

```bash
bd update $T1 --status=in_progress
```

- [ ] **Step 2: Add input types to `types.ts`**

Append to `src/core/domains/ingest/pipeline/enrichment/types.ts`:

```typescript
/** Input for EnrichmentMarkerStore.markFileFinal. */
export interface FileFinalInput {
  status: "completed" | "failed";
  durationMs: number;
  unenrichedChunks: number;
  matchedFiles: number;
  missedFiles: number;
}

/** Input for EnrichmentMarkerStore.markChunkFinal. */
export interface ChunkFinalInput {
  status: "completed" | "degraded" | "failed";
  durationMs: number;
  unenrichedChunks: number;
}

/** Input for EnrichmentMarkerStore.markRecoveryResult. */
export interface RecoveryResultInput {
  fileStatus: "completed" | "failed";
  fileUnenriched: number;
  chunkStatus: "completed" | "degraded" | "failed";
  chunkUnenriched: number;
}
```

- [ ] **Step 3: Write the failing test for `markStart`**

Create `tests/core/domains/ingest/pipeline/enrichment/marker-store.test.ts`:

```typescript
import { beforeEach, describe, expect, it } from "vitest";

import { MockQdrantManager } from "../../__helpers__/test-helpers.js";
import { INDEXING_METADATA_ID } from "../../../../../../src/core/domains/ingest/constants.js";
import { EnrichmentMarkerStore } from "../../../../../../src/core/domains/ingest/pipeline/enrichment/marker-store.js";

describe("EnrichmentMarkerStore", () => {
  let qdrant: MockQdrantManager;
  let store: EnrichmentMarkerStore;
  const COLL = "test_coll";

  beforeEach(() => {
    qdrant = new MockQdrantManager();
    store = new EnrichmentMarkerStore(qdrant as any);
  });

  describe("markStart", () => {
    it("writes initial marker with runId, file=in_progress, chunk=pending for each provider", async () => {
      await store.markStart(
        COLL,
        ["git", "static"],
        "run-abc",
        "2026-05-07T10:00:00Z",
      );

      const point = await qdrant.getPoint(COLL, INDEXING_METADATA_ID);
      const enrichment = point?.payload?.enrichment as Record<string, any>;
      expect(enrichment.git.runId).toBe("run-abc");
      expect(enrichment.git.file.status).toBe("in_progress");
      expect(enrichment.git.file.startedAt).toBe("2026-05-07T10:00:00Z");
      expect(enrichment.git.chunk.status).toBe("pending");
      expect(enrichment.static.runId).toBe("run-abc");
      expect(enrichment.static.file.status).toBe("in_progress");
    });
  });
});
```

- [ ] **Step 4: Run test — verify FAIL with module-not-found**

```bash
npx vitest run tests/core/domains/ingest/pipeline/enrichment/marker-store.test.ts
```

Expected: FAIL — "Cannot find module '.../marker-store.js'".

- [ ] **Step 5: Create `marker-store.ts` with all 7 methods**

Create `src/core/domains/ingest/pipeline/enrichment/marker-store.ts`:

```typescript
/**
 * EnrichmentMarkerStore — sole owner of payload.enrichment.<provider>.{file,chunk}.
 *
 * Replaces scattered updateEnrichmentMarker calls with 5 domain-specific write
 * methods. Deep-merge of partial updates is an internal detail.
 */

import type { QdrantManager } from "../../../../adapters/qdrant/client.js";
import { INDEXING_METADATA_ID } from "../../constants.js";
import { pipelineLog } from "../infra/debug-logger.js";
import type {
  ChunkFinalInput,
  FileFinalInput,
  RecoveryResultInput,
} from "./types.js";

interface ProviderMarkerSlice {
  runId?: string;
  file?: Record<string, unknown>;
  chunk?: Record<string, unknown>;
}

export class EnrichmentMarkerStore {
  constructor(private readonly qdrant: QdrantManager) {}

  /** Initial marker for all providers at run start. file=in_progress, chunk=pending. */
  async markStart(
    coll: string,
    providerKeys: Iterable<string>,
    runId: string,
    startedAt: string,
  ): Promise<void> {
    const updates: Record<string, ProviderMarkerSlice> = {};
    for (const key of providerKeys) {
      updates[key] = {
        runId,
        file: { status: "in_progress", startedAt, unenrichedChunks: 0 },
        chunk: { status: "pending", unenrichedChunks: 0 },
      };
    }
    await this.write(coll, updates);
  }

  /** Single-provider failure marker for prefetch error path. */
  async markPrefetchFailed(
    coll: string,
    providerKey: string,
    runId: string,
    startedAt: string,
    durationMs: number,
  ): Promise<void> {
    const completedAt = new Date().toISOString();
    await this.write(coll, {
      [providerKey]: {
        runId,
        file: {
          status: "failed",
          startedAt,
          completedAt,
          durationMs,
          unenrichedChunks: 0,
        },
        chunk: { status: "failed", unenrichedChunks: 0 },
      },
    });
  }

  /** Recovery finalization — both levels written together. */
  async markRecoveryResult(
    coll: string,
    providerKey: string,
    input: RecoveryResultInput,
  ): Promise<void> {
    await this.write(coll, {
      [providerKey]: {
        file: {
          status: input.fileStatus,
          unenrichedChunks: input.fileUnenriched,
        },
        chunk: {
          status: input.chunkStatus,
          unenrichedChunks: input.chunkUnenriched,
        },
      },
    });
  }

  /** File-level final marker (called from CompletionRunner step 4). */
  async markFileFinal(
    coll: string,
    providerKey: string,
    input: FileFinalInput,
  ): Promise<void> {
    await this.write(coll, {
      [providerKey]: {
        file: {
          status: input.status,
          completedAt: new Date().toISOString(),
          durationMs: input.durationMs,
          unenrichedChunks: input.unenrichedChunks,
          matchedFiles: input.matchedFiles,
          missedFiles: input.missedFiles,
        },
      },
    });
  }

  /** Chunk-level final marker (called from CompletionRunner step 7). */
  async markChunkFinal(
    coll: string,
    providerKey: string,
    input: ChunkFinalInput,
  ): Promise<void> {
    await this.write(coll, {
      [providerKey]: {
        chunk: {
          status: input.status,
          completedAt: new Date().toISOString(),
          durationMs: input.durationMs,
          unenrichedChunks: input.unenrichedChunks,
        },
      },
    });
  }

  /** Read the full marker record (or null if missing). */
  async read(coll: string): Promise<Record<string, unknown> | null> {
    try {
      const point = await this.qdrant.getPoint(coll, INDEXING_METADATA_ID);
      const e = point?.payload?.enrichment;
      if (e && typeof e === "object") return e as Record<string, unknown>;
    } catch {
      // marker may not exist yet
    }
    return null;
  }

  /** Read runId for a specific provider. */
  async getRunId(
    coll: string,
    providerKey: string,
  ): Promise<string | undefined> {
    const marker = await this.read(coll);
    const entry = marker?.[providerKey] as Record<string, unknown> | undefined;
    return typeof entry?.runId === "string" ? entry.runId : undefined;
  }

  /** Internal deep-merge writer. Surfaces failures via pipelineLog. */
  private async write(
    coll: string,
    updates: Record<string, ProviderMarkerSlice>,
  ): Promise<void> {
    try {
      const existing = (await this.read(coll)) ?? {};
      const enrichment: Record<string, unknown> = { ...existing };

      for (const [providerKey, slice] of Object.entries(updates)) {
        const prev = (enrichment[providerKey] as Record<string, unknown>) ?? {};
        const merged: Record<string, unknown> = { ...prev };
        if (slice.runId !== undefined) merged.runId = slice.runId;
        if (slice.file) {
          merged.file = {
            ...(prev.file as Record<string, unknown> | undefined),
            ...slice.file,
          };
        }
        if (slice.chunk) {
          merged.chunk = {
            ...(prev.chunk as Record<string, unknown> | undefined),
            ...slice.chunk,
          };
        }
        enrichment[providerKey] = merged;
      }

      await this.qdrant.setPayload(
        coll,
        { enrichment },
        { points: [INDEXING_METADATA_ID] },
      );
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      console.error(
        `[Enrichment] Failed to update marker for collection ${coll}:`,
        msg,
      );
      pipelineLog.enrichmentPhase("MARKER_UPDATE_FAILED", {
        collection: coll,
        providers: Object.keys(updates),
        error: msg,
      });
    }
  }
}
```

- [ ] **Step 6: Run test — verify PASS**

```bash
npx vitest run tests/core/domains/ingest/pipeline/enrichment/marker-store.test.ts
```

Expected: PASS.

- [ ] **Step 7: Add tests for the remaining 6 methods (one assertion-block
      each)**

Append to `marker-store.test.ts` (inside the same `describe`):

```typescript
describe("markPrefetchFailed", () => {
  it("writes file=failed and chunk=failed with durationMs", async () => {
    await store.markStart(COLL, ["git"], "r1", "2026-05-07T10:00:00Z");
    await store.markPrefetchFailed(
      COLL,
      "git",
      "r1",
      "2026-05-07T10:00:00Z",
      4200,
    );
    const m = (await store.read(COLL))!.git as any;
    expect(m.file.status).toBe("failed");
    expect(m.file.durationMs).toBe(4200);
    expect(m.chunk.status).toBe("failed");
  });
});

describe("markRecoveryResult", () => {
  it("writes both file and chunk statuses together", async () => {
    await store.markRecoveryResult(COLL, "git", {
      fileStatus: "completed",
      fileUnenriched: 0,
      chunkStatus: "degraded",
      chunkUnenriched: 7,
    });
    const m = (await store.read(COLL))!.git as any;
    expect(m.file.status).toBe("completed");
    expect(m.chunk.status).toBe("degraded");
    expect(m.chunk.unenrichedChunks).toBe(7);
  });
});

describe("markFileFinal", () => {
  it("writes completedAt and counters", async () => {
    await store.markFileFinal(COLL, "git", {
      status: "completed",
      durationMs: 1200,
      unenrichedChunks: 0,
      matchedFiles: 42,
      missedFiles: 3,
    });
    const m = (await store.read(COLL))!.git as any;
    expect(m.file.status).toBe("completed");
    expect(m.file.matchedFiles).toBe(42);
    expect(m.file.missedFiles).toBe(3);
    expect(typeof m.file.completedAt).toBe("string");
  });
});

describe("markChunkFinal", () => {
  it("writes degraded status with unenrichedChunks", async () => {
    await store.markChunkFinal(COLL, "git", {
      status: "degraded",
      durationMs: 8500,
      unenrichedChunks: 12,
    });
    const m = (await store.read(COLL))!.git as any;
    expect(m.chunk.status).toBe("degraded");
    expect(m.chunk.unenrichedChunks).toBe(12);
    expect(m.chunk.durationMs).toBe(8500);
  });
});

describe("read / getRunId", () => {
  it("read returns null when marker missing", async () => {
    expect(await store.read(COLL)).toBeNull();
  });
  it("getRunId returns the runId stored at markStart", async () => {
    await store.markStart(COLL, ["git"], "run-zz", "2026-05-07T10:00:00Z");
    expect(await store.getRunId(COLL, "git")).toBe("run-zz");
    expect(await store.getRunId(COLL, "absent")).toBeUndefined();
  });
});

describe("deep-merge across calls", () => {
  it("preserves chunk fields when only file is updated", async () => {
    await store.markStart(COLL, ["git"], "r1", "2026-05-07T10:00:00Z");
    await store.markFileFinal(COLL, "git", {
      status: "completed",
      durationMs: 100,
      unenrichedChunks: 0,
      matchedFiles: 1,
      missedFiles: 0,
    });
    const m = (await store.read(COLL))!.git as any;
    expect(m.file.status).toBe("completed");
    expect(m.chunk.status).toBe("pending"); // <-- preserved
    expect(m.runId).toBe("r1"); // <-- preserved
  });
});
```

- [ ] **Step 8: Run all marker-store tests — verify PASS**

```bash
npx vitest run tests/core/domains/ingest/pipeline/enrichment/marker-store.test.ts
```

Expected: PASS (7 test blocks).

- [ ] **Step 9: Wire `EnrichmentMarkerStore` into `EnrichmentCoordinator`
      constructor**

Edit `src/core/domains/ingest/pipeline/enrichment/coordinator.ts`:

In imports section, add:

```typescript
import { EnrichmentMarkerStore } from "./marker-store.js";
import type {
  ChunkFinalInput,
  FileFinalInput,
  RecoveryResultInput,
} from "./types.js";
```

Inside the `EnrichmentCoordinator` class, after `private readonly applier:`,
add:

```typescript
  private readonly markerStore: EnrichmentMarkerStore;
```

In the constructor body, after `this.applier = new EnrichmentApplier(qdrant);`,
add:

```typescript
this.markerStore = new EnrichmentMarkerStore(qdrant);
```

- [ ] **Step 10: Replace marker-write call-site #1 — initial marker in
      `prefetch()`**

In `coordinator.ts`, find the block in `prefetch()` that writes the initial
marker (the one constructing
`initialMarker: Record<string, ProviderMarkerUpdate>` with
`file: { status: "in_progress", ... }`). Replace the entire block with:

```typescript
if (collectionName) {
  void this.markerStore.markStart(
    collectionName,
    [...this.states.keys()],
    this.runId,
    this.runStartedAt,
  );
}
```

- [ ] **Step 11: Replace marker-write call-site #2 — failure marker in
      `prefetch().catch`**

In the same `prefetch()` method, inside the `.catch(error => { ... })` block of
each provider's prefetch promise, replace the
`if (collectionName) { ... updateEnrichmentMarker(...) ... }` block with:

```typescript
if (collectionName) {
  void this.markerStore.markPrefetchFailed(
    collectionName,
    state.provider.key,
    this.runId,
    this.runStartedAt,
    state.prefetchDurationMs,
  );
}
```

- [ ] **Step 12: Replace marker-write call-site #3 — recovery result in
      `runRecovery()`**

In `runRecovery()`, replace the
`await this.updateEnrichmentMarker(coll, { [provider.key]: { file: {...}, chunk: {...} } });`
block with:

```typescript
const fileStatus: "completed" | "failed" =
  fileCount === 0 ? "completed" : "failed";
const chunkStatus: "completed" | "degraded" | "failed" =
  chunkCount === 0 ? "completed" : "degraded";
await this.markerStore.markRecoveryResult(collectionName, provider.key, {
  fileStatus,
  fileUnenriched: fileCount,
  chunkStatus,
  chunkUnenriched: chunkCount,
});
```

Also replace the `baselineRunId` lookup. Change:

```typescript
      const baselineMarker = await this.readExistingMarker(collectionName);
      const baselineRunId = this.readRunId(baselineMarker, provider.key);
      ...
      const afterMarker = await this.readExistingMarker(collectionName);
      const currentRunId = this.readRunId(afterMarker, provider.key);
```

to:

```typescript
      const baselineRunId = await this.markerStore.getRunId(collectionName, provider.key);
      ...
      const currentRunId = await this.markerStore.getRunId(collectionName, provider.key);
```

- [ ] **Step 13: Replace marker-write call-site #4 — file final in
      `awaitCompletion`**

In `awaitCompletion`, replace the for-loop that writes `fileMarker` with:

```typescript
for (const state of this.states.values()) {
  const fileUnenriched = this.recovery
    ? await this.recovery
        .countUnenriched(collectionName, state.provider.key, "file")
        .catch(() => 0)
    : 0;
  await this.markerStore.markFileFinal(collectionName, state.provider.key, {
    status: state.prefetchFailed ? "failed" : "completed",
    durationMs: state.prefetchDurationMs,
    unenrichedChunks: fileUnenriched,
    matchedFiles: this.applier.matchedFiles,
    missedFiles: this.applier.missedFiles,
  });
}
```

- [ ] **Step 14: Replace marker-write call-site #5 — chunk final in
      `awaitCompletion`**

Replace the for-loop that writes `chunkMarker` with:

```typescript
for (const state of this.states.values()) {
  const chunkUnenriched = this.recovery
    ? await this.recovery
        .countUnenriched(collectionName, state.provider.key, "chunk")
        .catch(() => 0)
    : 0;
  let chunkStatus: ChunkFinalInput["status"];
  if (state.prefetchFailed || state.chunkEnrichmentFailed)
    chunkStatus = "failed";
  else if (chunkUnenriched > 0) chunkStatus = "degraded";
  else chunkStatus = "completed";
  await this.markerStore.markChunkFinal(collectionName, state.provider.key, {
    status: chunkStatus,
    durationMs: state.chunkEnrichmentDurationMs,
    unenrichedChunks: chunkUnenriched,
  });
}
```

- [ ] **Step 15: Delete dead code from `coordinator.ts`**

Remove the following from `coordinator.ts`:

- The `ProviderMarkerUpdate` type alias (no longer used).
- The `updateEnrichmentMarker` method (entire body, ~40 lines).
- The `readExistingMarker` private method.
- The `readRunId` private method.

The `INDEXING_METADATA_ID` import becomes unused — remove it. The `randomUUID`,
`relative`, `Ignore`, etc. imports stay.

- [ ] **Step 16: Run full vitest suite — verify GREEN**

```bash
npx vitest run
```

Expected: all suites PASS, including the existing `coordinator.test.ts` (it
exercises the same public API which is unchanged).

- [ ] **Step 17: Run type check**

```bash
npx tsc --noEmit
```

Expected: no errors.

- [ ] **Step 18: Stage and commit**

```bash
git add \
  src/core/domains/ingest/pipeline/enrichment/marker-store.ts \
  src/core/domains/ingest/pipeline/enrichment/coordinator.ts \
  src/core/domains/ingest/pipeline/enrichment/types.ts \
  tests/core/domains/ingest/pipeline/enrichment/marker-store.test.ts
git commit -m "$(cat <<'EOF'
refactor(enrichment): extract EnrichmentMarkerStore from coordinator

Five marker-write call-sites (initial / prefetch-failed / recovery /
file-final / chunk-final) collapse into domain-specific methods on a
new EnrichmentMarkerStore. Deep-merge becomes a private detail.
Removes ProviderMarkerUpdate, updateEnrichmentMarker, readExistingMarker,
readRunId from coordinator.ts. Public API of EnrichmentCoordinator
unchanged.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

- [ ] **Step 19: Close beads task**

```bash
bd close $T1
```

---

## Task 2: Applier accessors + `EnrichmentBackfiller` extraction

**Goal:** Add two narrow accessors (`getMissedFileChunks`, `markBackfilled`) to
`EnrichmentApplier` (do not touch its 95-line bugFixRate-58 block). Create
`EnrichmentBackfiller.runFor(coll, ctx, runStartedAt)` and reduce
`coordinator.backfillMissedFiles` + `coordinator.backfillChunkSignals` to a
single call into the new component.

**Beads:**

```bash
bd dolt pull
bd create \
  --title="Extract EnrichmentBackfiller; add narrow Applier accessors" \
  --description="Add getMissedFileChunks() (read-only view of missedFileChunks Map) and markBackfilled(count) to EnrichmentApplier. Create backfiller.ts with runFor(coll, ctx, runStartedAt) that does file backfill then chunk backfill for missed paths. Replace coordinator.backfillMissedFiles + backfillChunkSignals with backfiller.runFor calls. Tests in backfiller.test.ts." \
  --type=task \
  --priority=2
# Capture as $T2
bd label add $T2 architecture
bd dep add $T2 $EPIC
bd dep add $T2 $T1
```

**Files:**

- Modify: `src/core/domains/ingest/pipeline/enrichment/applier.ts` (+2 methods)
- Create: `src/core/domains/ingest/pipeline/enrichment/backfiller.ts`
- Create: `tests/core/domains/ingest/pipeline/enrichment/backfiller.test.ts`
- Modify: `src/core/domains/ingest/pipeline/enrichment/coordinator.ts` (remove
  `backfillMissedFiles`, `backfillChunkSignals`; use `Backfiller`)
- Modify: `src/core/domains/ingest/pipeline/enrichment/types.ts` (add
  `MissedFileChunk` type if not already exported; add a transitional
  `ProviderContext`-shaped param object — full `ProviderContext` lands in
  Task 4)

---

- [ ] **Step 1: Mark task in progress**

```bash
bd update $T2 --status=in_progress
```

- [ ] **Step 2: Add `MissedFileChunk` to `types.ts`**

Append to `types.ts`:

```typescript
/** Per-chunk reference for files whose chunks landed without file metadata. */
export interface MissedFileChunk {
  chunkId: string;
  startLine: number;
  endLine: number;
}
```

- [ ] **Step 3: Add `getMissedFileChunks` and `markBackfilled` to Applier**

Edit `src/core/domains/ingest/pipeline/enrichment/applier.ts`. **Do NOT modify
the existing `applyFileSignals` body (lines 85-228) or any other existing
method.** Only add:

Change the field declaration:

```typescript
  // Before:
  readonly missedFileChunks = new Map<string, { chunkId: string; startLine: number; endLine: number }[]>();

  // After:
  private readonly _missedFileChunks = new Map<string, MissedFileChunk[]>();
```

Add at end of class (after the existing methods):

```typescript
  /** Read-only snapshot of files whose chunks landed without matching file metadata. */
  getMissedFileChunks(): ReadonlyMap<string, readonly MissedFileChunk[]> {
    return this._missedFileChunks;
  }

  /** Adjust matched/missed counters after a successful backfill. */
  markBackfilled(count: number): void {
    this.matchedFiles += count;
    this.missedFiles -= count;
  }
```

Inside `applyFileSignals`, the 95-line block currently writes to
`this.missedFileChunks`. Update **only the assignment lines** to use the renamed
field:

```typescript
        // Before: const existing = this.missedFileChunks.get(relativePath) || [];
        const existing = this._missedFileChunks.get(relativePath) || [];
        ...
        // Before: this.missedFileChunks.set(relativePath, existing);
        this._missedFileChunks.set(relativePath, existing);
```

Add the import for `MissedFileChunk`:

```typescript
import type { MissedFileChunk } from "./types.js";
```

These are pure rename edits inside the hot block — no logic changes.

- [ ] **Step 4: Write the failing test for `Backfiller.runFor`**

Create `tests/core/domains/ingest/pipeline/enrichment/backfiller.test.ts`:

```typescript
import { beforeEach, describe, expect, it, vi } from "vitest";

import { MockQdrantManager } from "../../__helpers__/test-helpers.js";
import { EnrichmentApplier } from "../../../../../../src/core/domains/ingest/pipeline/enrichment/applier.js";
import { EnrichmentBackfiller } from "../../../../../../src/core/domains/ingest/pipeline/enrichment/backfiller.js";

describe("EnrichmentBackfiller", () => {
  it("fetches file overlays for missed paths and applies them to chunks", async () => {
    const qdrant = new MockQdrantManager();
    const applier = new EnrichmentApplier(qdrant as any);

    // Seed missed paths via reflection (test-only). The 95-line block is
    // out-of-scope; we drive its state through markBackfilled/getMissedFileChunks
    // contract instead.
    const internal = (applier as any)._missedFileChunks as Map<string, any[]>;
    internal.set("src/a.ts", [{ chunkId: "c1", startLine: 1, endLine: 10 }]);
    applier.missedFiles = 1;
    applier.matchedFiles = 0;

    const backfiller = new EnrichmentBackfiller(applier, qdrant as any);

    const buildFileSignals = vi
      .fn()
      .mockResolvedValue(new Map([["src/a.ts", { authorPct: 100 }]]));
    const buildChunkSignals = vi
      .fn()
      .mockResolvedValue(
        new Map([["src/a.ts", new Map([["c1", { commits: 3 }]])]]),
      );
    const ctx = {
      key: "git",
      provider: {
        key: "git",
        buildFileSignals,
        buildChunkSignals,
        fileSignalTransform: undefined,
      } as any,
      effectiveRoot: "/repo",
      ignoreFilter: null,
    };

    await backfiller.runFor("coll", ctx, "2026-05-07T10:00:00Z");

    expect(buildFileSignals).toHaveBeenCalledWith("/repo", {
      paths: ["src/a.ts"],
    });
    expect(applier.matchedFiles).toBe(1);
    expect(applier.missedFiles).toBe(0);
    expect(buildChunkSignals).toHaveBeenCalledTimes(1);
  });

  it("is a no-op when no files are missed", async () => {
    const qdrant = new MockQdrantManager();
    const applier = new EnrichmentApplier(qdrant as any);
    const backfiller = new EnrichmentBackfiller(applier, qdrant as any);
    const buildFileSignals = vi.fn();
    const ctx = {
      key: "git",
      provider: {
        key: "git",
        buildFileSignals,
        buildChunkSignals: vi.fn(),
      } as any,
      effectiveRoot: "/repo",
      ignoreFilter: null,
    };
    await backfiller.runFor("coll", ctx, "ts");
    expect(buildFileSignals).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 5: Run test — verify FAIL**

```bash
npx vitest run tests/core/domains/ingest/pipeline/enrichment/backfiller.test.ts
```

Expected: FAIL — module not found.

- [ ] **Step 6: Create `backfiller.ts`**

Create `src/core/domains/ingest/pipeline/enrichment/backfiller.ts`:

```typescript
/**
 * EnrichmentBackfiller — closed loop for files whose chunks landed without
 * matching file metadata in the original prefetch.
 *
 * Reads applier.getMissedFileChunks(), fetches file+chunk overlays via the
 * provider, applies them via the applier, then updates counters via
 * applier.markBackfilled(count). All state mutation lives on the applier; this
 * component owns the orchestration only.
 */

import type { Ignore } from "ignore";

import type { QdrantManager } from "../../../../adapters/qdrant/client.js";
import type {
  ChunkSignalOverlay,
  EnrichmentProvider,
  FileSignalOverlay,
} from "../../../../contracts/types/provider.js";
import type { ChunkLookupEntry } from "../../../../types.js";
import { pipelineLog } from "../infra/debug-logger.js";
import { isDebug } from "../infra/runtime.js";
import type { EnrichmentApplier } from "./applier.js";

const BATCH_SIZE = 100;

/**
 * Transitional shape — Task 4 will replace this with the canonical
 * `ProviderContext` exported from types.ts.
 */
export interface BackfillerProviderContext {
  readonly key: string;
  readonly provider: EnrichmentProvider;
  readonly effectiveRoot: string | null;
  readonly ignoreFilter: Ignore | null;
}

export class EnrichmentBackfiller {
  constructor(
    private readonly applier: EnrichmentApplier,
    private readonly qdrant: QdrantManager,
  ) {}

  async runFor(
    coll: string,
    ctx: BackfillerProviderContext,
    runStartedAt: string,
  ): Promise<void> {
    const missed = this.applier.getMissedFileChunks();
    if (missed.size === 0) return;
    if (!ctx.effectiveRoot) return;

    const root = ctx.effectiveRoot;
    const missedPaths = Array.from(missed.keys());
    pipelineLog.enrichmentPhase("BACKFILL_START", {
      provider: ctx.key,
      missedFiles: missedPaths.length,
    });

    const start = Date.now();
    let backfillData: Map<string, FileSignalOverlay>;
    try {
      backfillData = await ctx.provider.buildFileSignals(root, {
        paths: missedPaths,
      });
    } catch (error) {
      pipelineLog.enrichmentPhase("BACKFILL_FAILED", {
        provider: ctx.key,
        error: error instanceof Error ? error.message : String(error),
      });
      return;
    }

    const ops: {
      payload: Record<string, unknown>;
      points: (string | number)[];
    }[] = [];
    let backfilledFiles = 0;

    for (const [relPath, chunks] of missed) {
      const data = backfillData.get(relPath);
      if (!data) continue;
      const maxEndLine = chunks.reduce((max, c) => Math.max(max, c.endLine), 0);
      const final = ctx.provider.fileSignalTransform
        ? ctx.provider.fileSignalTransform(data, maxEndLine)
        : data;
      const fileData = runStartedAt
        ? { ...(final as Record<string, unknown>), enrichedAt: runStartedAt }
        : (final as Record<string, unknown>);
      const payload = { [ctx.key]: { file: fileData } };
      for (const chunk of chunks) {
        ops.push({ payload, points: [chunk.chunkId] });
      }
      backfilledFiles++;
    }

    if (ops.length > 0) {
      for (let i = 0; i < ops.length; i += BATCH_SIZE) {
        try {
          await this.qdrant.batchSetPayload(coll, ops.slice(i, i + BATCH_SIZE));
        } catch (error) {
          if (isDebug())
            console.error(
              `[Enrichment:${ctx.key}] backfill batch failed:`,
              error,
            );
        }
      }
    }

    this.applier.markBackfilled(backfilledFiles);

    pipelineLog.enrichmentPhase("BACKFILL_COMPLETE", {
      provider: ctx.key,
      missedFiles: missedPaths.length,
      backfilledFiles,
      backfilledChunks: ops.length,
      stillMissed: missedPaths.length - backfilledFiles,
      durationMs: Date.now() - start,
    });

    await this.backfillChunkSignals(coll, ctx, backfillData, runStartedAt);
  }

  private async backfillChunkSignals(
    coll: string,
    ctx: BackfillerProviderContext,
    backfillData: Map<string, FileSignalOverlay>,
    runStartedAt: string,
  ): Promise<void> {
    const root = ctx.effectiveRoot;
    if (!root) return;

    const map = new Map<string, ChunkLookupEntry[]>();
    for (const [relPath, chunks] of this.applier.getMissedFileChunks()) {
      if (!backfillData.has(relPath)) continue;
      map.set(
        relPath,
        chunks.map((c) => ({
          chunkId: c.chunkId,
          startLine: c.startLine,
          endLine: c.endLine,
        })),
      );
    }
    if (map.size === 0) return;

    const start = Date.now();
    pipelineLog.enrichmentPhase("CHUNK_BACKFILL_START", {
      provider: ctx.key,
      files: map.size,
      chunks: [...map.values()].reduce((sum, arr) => sum + arr.length, 0),
    });

    let overlays: Map<string, Map<string, ChunkSignalOverlay>>;
    try {
      overlays = await ctx.provider.buildChunkSignals(root, map);
    } catch (error) {
      pipelineLog.enrichmentPhase("CHUNK_BACKFILL_FAILED", {
        provider: ctx.key,
        error: error instanceof Error ? error.message : String(error),
      });
      return;
    }

    const ops: {
      payload: Record<string, unknown>;
      points: (string | number)[];
    }[] = [];
    for (const chunkMap of overlays.values()) {
      for (const [chunkId, overlay] of chunkMap) {
        const chunkData = runStartedAt
          ? {
              ...(overlay as Record<string, unknown>),
              enrichedAt: runStartedAt,
            }
          : (overlay as Record<string, unknown>);
        ops.push({
          payload: { [ctx.key]: { chunk: chunkData } },
          points: [chunkId],
        });
      }
    }

    if (ops.length > 0) {
      for (let i = 0; i < ops.length; i += BATCH_SIZE) {
        try {
          await this.qdrant.batchSetPayload(coll, ops.slice(i, i + BATCH_SIZE));
        } catch (error) {
          if (isDebug())
            console.error(
              `[Enrichment:${ctx.key}] chunk backfill batch failed:`,
              error,
            );
        }
      }
    }

    pipelineLog.enrichmentPhase("CHUNK_BACKFILL_COMPLETE", {
      provider: ctx.key,
      files: map.size,
      chunks: ops.length,
      durationMs: Date.now() - start,
    });
  }
}
```

- [ ] **Step 7: Run test — verify PASS**

```bash
npx vitest run tests/core/domains/ingest/pipeline/enrichment/backfiller.test.ts
```

Expected: PASS.

- [ ] **Step 8: Replace coordinator's backfill call-site**

In `coordinator.ts`:

1. Add import: `import { EnrichmentBackfiller } from "./backfiller.js";`
2. Add field: `private readonly backfiller: EnrichmentBackfiller;`
3. In constructor:
   `this.backfiller = new EnrichmentBackfiller(this.applier, qdrant);`
4. In `awaitCompletion`, replace the
   `if (this.applier.missedFileChunks.size > 0)` block with:

```typescript
// 3. Backfill file+chunk overlays for paths missed by prefetch.
if (this.applier.getMissedFileChunks().size > 0) {
  for (const state of this.states.values()) {
    if (state.prefetchFailed) continue;
    await this.backfiller.runFor(
      collectionName,
      {
        key: state.provider.key,
        provider: state.provider,
        effectiveRoot: state.effectiveRoot,
        ignoreFilter: state.ignoreFilter,
      },
      this.runStartedAt,
    );
  }
}
```

5. Delete `backfillMissedFiles` and `backfillChunkSignals` methods entirely from
   `coordinator.ts`.

- [ ] **Step 9: Update existing applier tests for the rename**

In `tests/core/domains/ingest/pipeline/enrichment/applier.test.ts`, replace any
direct access to `applier.missedFileChunks` (the public Map) with
`applier.getMissedFileChunks()`. Do NOT change other assertions — the test
patterns rule forbids rewriting passing tests beyond what's strictly needed for
the rename.

- [ ] **Step 10: Run full vitest + tsc**

```bash
npx vitest run
npx tsc --noEmit
```

Expected: GREEN.

- [ ] **Step 11: Commit**

```bash
git add \
  src/core/domains/ingest/pipeline/enrichment/applier.ts \
  src/core/domains/ingest/pipeline/enrichment/backfiller.ts \
  src/core/domains/ingest/pipeline/enrichment/coordinator.ts \
  src/core/domains/ingest/pipeline/enrichment/types.ts \
  tests/core/domains/ingest/pipeline/enrichment/applier.test.ts \
  tests/core/domains/ingest/pipeline/enrichment/backfiller.test.ts
git commit -m "$(cat <<'EOF'
refactor(enrichment): extract EnrichmentBackfiller; narrow applier accessors

Add getMissedFileChunks() (ReadonlyMap view) and markBackfilled(count)
to EnrichmentApplier. Backfill orchestration moves from coordinator
into EnrichmentBackfiller.runFor(). Applier's 95-line applyFileSignals
block is untouched apart from a single field rename
(missedFileChunks -> _missedFileChunks). Public API of
EnrichmentCoordinator unchanged.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

- [ ] **Step 12: Close beads task**

```bash
bd close $T2
```

---

## Task 3: `EnrichmentRecovery.recoverAll`

**Goal:** Move the 50-line `Coordinator.runRecovery` body into a new
`EnrichmentRecovery.recoverAll(coll, root, contexts, markerStore)` method.
`Coordinator.runRecovery` becomes a one-line delegation. The hot
`scrollUnenriched` query (bugFixRate 70 critical) and existing
`recoverFileLevel`/`recoverChunkLevel` are NOT modified.

**Beads:**

```bash
bd dolt pull
bd create \
  --title="Move runRecovery race-guard + marker write into EnrichmentRecovery.recoverAll" \
  --description="Add recoverAll(coll, root, providers, markerStore) high-level entry to EnrichmentRecovery. Owns runId snapshot/check race-guard and final markerStore.markRecoveryResult call. Coordinator.runRecovery becomes one-liner. scrollUnenriched and existing recover*Level methods untouched." \
  --type=task \
  --priority=2
# Capture as $T3
bd label add $T3 architecture
bd dep add $T3 $EPIC
bd dep add $T3 $T2
```

**Files:**

- Modify: `src/core/domains/ingest/pipeline/enrichment/recovery.ts`
  (+`recoverAll`)
- Modify: `src/core/domains/ingest/pipeline/enrichment/coordinator.ts` (collapse
  `runRecovery` to one line)
- Modify: `tests/core/domains/ingest/pipeline/enrichment/recovery.test.ts` (add
  race-guard scenario)

---

- [ ] **Step 1: Mark task in progress**

```bash
bd update $T3 --status=in_progress
```

- [ ] **Step 2: Write the failing race-guard test**

Append to `tests/core/domains/ingest/pipeline/enrichment/recovery.test.ts`:

```typescript
import { EnrichmentMarkerStore } from "../../../../../../src/core/domains/ingest/pipeline/enrichment/marker-store.js";

describe("EnrichmentRecovery.recoverAll race guard", () => {
  it("skips marker write when runId changed between snapshot and finalize", async () => {
    const qdrant = new MockQdrantManager();
    const marker = new EnrichmentMarkerStore(qdrant as any);
    await marker.markStart("coll", ["git"], "BASELINE", "2026-05-07T10:00:00Z");

    const recovery =
      new EnrichmentRecovery(/* construct as in existing tests */);
    // Stub recoverFileLevel and recoverChunkLevel to flip the runId during the call.
    vi.spyOn(recovery, "recoverFileLevel").mockImplementation(async () => {
      // simulate concurrent run rewriting the marker
      await marker.markStart(
        "coll",
        ["git"],
        "NEW_RUN",
        "2026-05-07T11:00:00Z",
      );
      return { remainingUnenriched: 0, recovered: 0 };
    });
    vi.spyOn(recovery, "recoverChunkLevel").mockResolvedValue({
      remainingUnenriched: 0,
      recovered: 0,
    });

    const provider = {
      key: "git",
      resolveRoot: (p: string) => p,
      buildFileSignals: vi.fn(),
      buildChunkSignals: vi.fn(),
    } as any;
    const ctx = new Map([
      [
        "git",
        { key: "git", provider, effectiveRoot: "/repo", ignoreFilter: null },
      ],
    ]);

    await recovery.recoverAll("coll", "/repo", ctx, marker);

    const m = (await marker.read("coll"))!.git as any;
    // file/chunk status MUST stay at the values from the new run (in_progress / pending),
    // not be overwritten by the stale recovery's "completed".
    expect(m.file.status).toBe("in_progress");
    expect(m.chunk.status).toBe("pending");
    expect(m.runId).toBe("NEW_RUN");
  });
});
```

- [ ] **Step 3: Run — verify FAIL**

```bash
npx vitest run tests/core/domains/ingest/pipeline/enrichment/recovery.test.ts -t "race guard"
```

Expected: FAIL — `recovery.recoverAll is not a function`.

- [ ] **Step 4: Add `recoverAll` to `recovery.ts`**

In `src/core/domains/ingest/pipeline/enrichment/recovery.ts`, append (after the
existing methods, do NOT modify `scrollUnenriched`, `recoverFileLevel`,
`recoverChunkLevel`, or `countUnenriched`):

```typescript
import type { EnrichmentMarkerStore } from "./marker-store.js";
// reuse the BackfillerProviderContext shape introduced in Task 2 — Task 4 will
// rename it to ProviderContext.
import type { BackfillerProviderContext } from "./backfiller.js";

// ... inside class EnrichmentRecovery ...

  /**
   * High-level recovery entry. Snapshots runId, runs both levels, re-checks
   * runId; only writes the recovery marker when no concurrent run has
   * stamped a fresher runId.
   */
  async recoverAll(
    coll: string,
    absolutePath: string,
    contexts: ReadonlyMap<string, BackfillerProviderContext>,
    markerStore: EnrichmentMarkerStore,
  ): Promise<void> {
    const enrichedAt = new Date().toISOString();
    for (const ctx of contexts.values()) {
      const baselineRunId = await markerStore.getRunId(coll, ctx.key);

      const fileResult = await this.recoverFileLevel(coll, absolutePath, ctx.provider, enrichedAt);
      const chunkResult = await this.recoverChunkLevel(coll, absolutePath, ctx.provider, enrichedAt);

      const currentRunId = await markerStore.getRunId(coll, ctx.key);
      if (baselineRunId !== currentRunId) {
        // A concurrent run has rewritten the marker; our counts are stale.
        // Skip the marker write to avoid clobbering the fresher state.
        continue;
      }

      await markerStore.markRecoveryResult(coll, ctx.key, {
        fileStatus: fileResult.remainingUnenriched === 0 ? "completed" : "failed",
        fileUnenriched: fileResult.remainingUnenriched,
        chunkStatus: chunkResult.remainingUnenriched === 0 ? "completed" : "degraded",
        chunkUnenriched: chunkResult.remainingUnenriched,
      });
    }
  }
```

- [ ] **Step 5: Run race-guard test — verify PASS**

```bash
npx vitest run tests/core/domains/ingest/pipeline/enrichment/recovery.test.ts -t "race guard"
```

Expected: PASS.

- [ ] **Step 6: Collapse `coordinator.runRecovery` to one line**

In `coordinator.ts`, replace the entire `runRecovery` body with:

```typescript
  async runRecovery(collectionName: string, absolutePath: string): Promise<void> {
    if (!this.recovery) return;
    const ctx = new Map(
      [...this.states.values()].map((state) => [
        state.provider.key,
        {
          key: state.provider.key,
          provider: state.provider,
          effectiveRoot: state.effectiveRoot,
          ignoreFilter: state.ignoreFilter,
        },
      ]),
    );
    await this.recovery.recoverAll(collectionName, absolutePath, ctx, this.markerStore);
  }
```

After Task 4 lands, the `ctx` Map will be replaced with `this.contexts`.

- [ ] **Step 7: Run full suite + tsc**

```bash
npx vitest run
npx tsc --noEmit
```

Expected: GREEN.

- [ ] **Step 8: Commit**

```bash
git add \
  src/core/domains/ingest/pipeline/enrichment/recovery.ts \
  src/core/domains/ingest/pipeline/enrichment/coordinator.ts \
  tests/core/domains/ingest/pipeline/enrichment/recovery.test.ts
git commit -m "$(cat <<'EOF'
refactor(enrichment): move runRecovery race-guard into EnrichmentRecovery.recoverAll

EnrichmentRecovery now owns the high-level recover entry: snapshot
runId, run both levels, re-check runId, write marker only if unchanged.
Coordinator.runRecovery is a single delegation. scrollUnenriched and
recover{File,Chunk}Level untouched.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

- [ ] **Step 9: Close beads task**

```bash
bd close $T3
```

---

## Task 4: Introduce `ProviderContext`

**Goal:** Add the canonical `ProviderContext` type and have
`EnrichmentCoordinator.prefetch()` compute a `Map<string, ProviderContext>` once
per run. This is **preparation only** — phases still read from the old
`ProviderState` until Tasks 5–6.

**Beads:**

```bash
bd dolt pull
bd create \
  --title="Add ProviderContext type and per-run computation in Coordinator.prefetch" \
  --description="Define ProviderContext interface in types.ts (key, provider, effectiveRoot, ignoreFilter). Coordinator.prefetch() computes Map<key, ProviderContext> once per run. Replace BackfillerProviderContext with the canonical type. Phases still read from old ProviderState — full migration in Tasks 5-6." \
  --type=task \
  --priority=2
# Capture as $T4
bd label add $T4 architecture
bd dep add $T4 $EPIC
bd dep add $T4 $T3
```

**Files:**

- Modify: `src/core/domains/ingest/pipeline/enrichment/types.ts`
  (+`ProviderContext`)
- Modify: `src/core/domains/ingest/pipeline/enrichment/backfiller.ts` (use
  canonical type)
- Modify: `src/core/domains/ingest/pipeline/enrichment/recovery.ts` (use
  canonical type)
- Modify: `src/core/domains/ingest/pipeline/enrichment/coordinator.ts`

---

- [ ] **Step 1: Mark task in progress**

```bash
bd update $T4 --status=in_progress
```

- [ ] **Step 2: Add `ProviderContext` to `types.ts`**

Append to `types.ts`:

```typescript
import type { Ignore } from "ignore";

import type { EnrichmentProvider } from "../../../../contracts/types/provider.js";

/**
 * Per-run, immutable context for a single enrichment provider. Computed once
 * by EnrichmentCoordinator.prefetch() and shared read-only with all phases
 * (FilePhase, ChunkPhase, Backfiller, EnrichmentRecovery).
 */
export interface ProviderContext {
  readonly key: string;
  readonly provider: EnrichmentProvider;
  readonly effectiveRoot: string | null;
  readonly ignoreFilter: Ignore | null;
}
```

- [ ] **Step 3: Replace `BackfillerProviderContext` with `ProviderContext`**

In `backfiller.ts`:

```typescript
// Before:
import type { BackfillerProviderContext } from "./backfiller.js";  // (the old export)
export interface BackfillerProviderContext { ... }

// After:
import type { ProviderContext } from "./types.js";
// remove the local interface entirely
```

Update the method signature:
`async runFor(coll: string, ctx: ProviderContext, runStartedAt: string)`.

In `recovery.ts`, replace the `BackfillerProviderContext` import with
`ProviderContext` from `./types.js`.

- [ ] **Step 4: Compute `contexts` in `Coordinator.prefetch()`**

In `coordinator.ts`:

1. Add field: `private contexts: Map<string, ProviderContext> = new Map();`
2. At the top of `prefetch()`, after
   `this.runStartedAt = new Date().toISOString();`, add:

```typescript
this.contexts = new Map(
  [...this.states.values()].map((state) => {
    const effectiveRoot = state.provider.resolveRoot(absolutePath);
    return [
      state.provider.key,
      {
        key: state.provider.key,
        provider: state.provider,
        effectiveRoot,
        ignoreFilter: ignoreFilter ?? null,
      },
    ];
  }),
);
```

3. In `runRecovery`, replace the inline ctx-Map construction with
   `this.contexts`:

```typescript
  async runRecovery(collectionName: string, absolutePath: string): Promise<void> {
    if (!this.recovery) return;
    await this.recovery.recoverAll(collectionName, absolutePath, this.contexts, this.markerStore);
  }
```

4. In the backfill loop in `awaitCompletion`, replace the inline construction
   with:

```typescript
for (const ctx of this.contexts.values()) {
  if (this.states.get(ctx.key)?.prefetchFailed) continue;
  await this.backfiller.runFor(collectionName, ctx, this.runStartedAt);
}
```

`ProviderState.effectiveRoot` and `state.ignoreFilter` are still set by
`prefetch()` for in-process consumers; they will be removed in Tasks 5–6 once
phases own them.

- [ ] **Step 5: Run vitest + tsc**

```bash
npx vitest run
npx tsc --noEmit
```

Expected: GREEN.

- [ ] **Step 6: Commit**

```bash
git add \
  src/core/domains/ingest/pipeline/enrichment/types.ts \
  src/core/domains/ingest/pipeline/enrichment/backfiller.ts \
  src/core/domains/ingest/pipeline/enrichment/recovery.ts \
  src/core/domains/ingest/pipeline/enrichment/coordinator.ts
git commit -m "$(cat <<'EOF'
refactor(enrichment): introduce ProviderContext type computed in prefetch

Coordinator.prefetch() now computes Map<key, ProviderContext> once and
passes it to recovery + backfiller. Replaces transitional
BackfillerProviderContext. Phases (FilePhase, ChunkPhase) still read
from the existing ProviderState; full migration follows in Tasks 5-6.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

- [ ] **Step 7: Close beads task**

```bash
bd close $T4
```

---

## Task 5: Extract `ChunkPhase`

**Goal:** Move chunk-signal enrichment (streaming + post-flush catch-up) and the
shared `Semaphore(10)` into a new `ChunkPhase` class. De-duplicate the "build →
apply → mark" skeleton via a private helper. Coordinator delegates both
`onChunksStored` (chunk side) and `startChunkEnrichment`.

**Beads:**

```bash
bd dolt pull
bd create \
  --title="Extract ChunkPhase: streaming + post-flush + Semaphore + onComplete callback" \
  --description="Create chunk-phase.ts with init(contexts, coll, runStartedAt), onBatch (streaming), enrichRemaining (catch-up), drain, getMetrics, hasChunkEnrichmentFailed, setOnComplete. Owns Semaphore(10) + private map<key, ChunkPhaseState>. Private runChunkSignals helper dedups streaming/catch-up. Coordinator delegates startStreamingChunkEnrichment and startChunkEnrichment. Tests in chunk-phase.test.ts." \
  --type=task \
  --priority=2
# Capture as $T5
bd label add $T5 architecture
bd dep add $T5 $EPIC
bd dep add $T5 $T4
```

**Files:**

- Create: `src/core/domains/ingest/pipeline/enrichment/chunk-phase.ts`
- Create: `tests/core/domains/ingest/pipeline/enrichment/chunk-phase.test.ts`
- Modify: `src/core/domains/ingest/pipeline/enrichment/coordinator.ts`

---

- [ ] **Step 1: Mark task in progress**

```bash
bd update $T5 --status=in_progress
```

- [ ] **Step 2: Write failing tests**

Create `tests/core/domains/ingest/pipeline/enrichment/chunk-phase.test.ts`:

```typescript
import { describe, expect, it, vi } from "vitest";

import { MockQdrantManager } from "../../__helpers__/test-helpers.js";
import { EnrichmentApplier } from "../../../../../../src/core/domains/ingest/pipeline/enrichment/applier.js";
import { ChunkPhase } from "../../../../../../src/core/domains/ingest/pipeline/enrichment/chunk-phase.js";

function buildCtx(buildChunkSignals = vi.fn().mockResolvedValue(new Map())) {
  return {
    key: "git",
    provider: { key: "git", buildChunkSignals } as any,
    effectiveRoot: "/repo",
    ignoreFilter: null,
  };
}

const items = [
  {
    chunkId: "c1",
    chunk: {
      metadata: { filePath: "/repo/src/a.ts" },
      startLine: 1,
      endLine: 10,
    },
  } as any,
];

describe("ChunkPhase", () => {
  it("onBatch dispatches streaming work with semaphore-bounded concurrency", async () => {
    const qdrant = new MockQdrantManager();
    const applier = new EnrichmentApplier(qdrant as any);
    const ctx = buildCtx();
    const phase = new ChunkPhase(applier);
    phase.init(new Map([[ctx.key, ctx]]), "coll", "2026-05-07T10:00:00Z");
    phase.onBatch("coll", "/repo", items);
    await phase.drain();
    expect(ctx.provider.buildChunkSignals).toHaveBeenCalledTimes(1);
  });

  it("enrichRemaining skips files already enriched by streaming", async () => {
    const qdrant = new MockQdrantManager();
    const applier = new EnrichmentApplier(qdrant as any);
    const ctx = buildCtx();
    const phase = new ChunkPhase(applier);
    phase.init(new Map([[ctx.key, ctx]]), "coll", "2026-05-07T10:00:00Z");
    phase.onBatch("coll", "/repo", items);
    await phase.drain();
    (ctx.provider.buildChunkSignals as any).mockClear();
    phase.enrichRemaining(
      "coll",
      "/repo",
      new Map([["src/a.ts", [{ chunkId: "c1", startLine: 1, endLine: 10 }]]]),
    );
    await phase.drain();
    expect(ctx.provider.buildChunkSignals).not.toHaveBeenCalled();
  });

  it("setOnComplete fires when at least one provider succeeded", async () => {
    const qdrant = new MockQdrantManager();
    const applier = new EnrichmentApplier(qdrant as any);
    const ctx = buildCtx();
    const phase = new ChunkPhase(applier);
    phase.init(new Map([[ctx.key, ctx]]), "coll", "ts");
    const cb = vi.fn().mockResolvedValue(undefined);
    phase.setOnComplete(cb);
    phase.enrichRemaining(
      "coll",
      "/repo",
      new Map([["src/a.ts", [{ chunkId: "c1", startLine: 1, endLine: 10 }]]]),
    );
    await phase.drain();
    await new Promise((r) => setImmediate(r));
    expect(cb).toHaveBeenCalledWith("coll");
  });
});
```

- [ ] **Step 3: Run — verify FAIL**

```bash
npx vitest run tests/core/domains/ingest/pipeline/enrichment/chunk-phase.test.ts
```

Expected: FAIL — module not found.

- [ ] **Step 4: Create `chunk-phase.ts`**

Create `src/core/domains/ingest/pipeline/enrichment/chunk-phase.ts`. Move the
bodies of `Coordinator.startStreamingChunkEnrichment` and
`Coordinator.startChunkEnrichment` here, factored through a single private
`runChunkSignals` helper. State per provider:

```typescript
/**
 * ChunkPhase — streaming and post-flush chunk-signal enrichment.
 *
 * Owns Semaphore(10) shared across both entry points so total git-blame
 * parallelism stays bounded. Streaming records files in
 * streamingEnrichedFiles; enrichRemaining consults that set to skip files
 * already enriched.
 */

import type { ChunkSignalOverlay } from "../../../../contracts/types/provider.js";
import { Semaphore } from "../../../../infra/semaphore.js";
import type { ChunkLookupEntry } from "../../../../types.js";
import { pipelineLog } from "../infra/debug-logger.js";
import type { ChunkItem } from "../types.js";
import type { EnrichmentApplier } from "./applier.js";
import type { ProviderContext } from "./types.js";

const CHUNK_ENRICHMENT_CONCURRENCY = 10;

interface ChunkPhaseState {
  readonly streamingEnrichedFiles: Set<string>;
  readonly chunkWork: Promise<void>[];
  chunkEnrichmentDurationMs: number;
  chunkEnrichmentFailed: boolean;
  chunkEnrichmentInvoked: boolean;
}

function createState(): ChunkPhaseState {
  return {
    streamingEnrichedFiles: new Set(),
    chunkWork: [],
    chunkEnrichmentDurationMs: 0,
    chunkEnrichmentFailed: false,
    chunkEnrichmentInvoked: false,
  };
}

export interface ChunkPhaseMetrics {
  totalChunkEnrichmentDurationMs: number;
}

export class ChunkPhase {
  private readonly states = new Map<string, ChunkPhaseState>();
  private readonly semaphore = new Semaphore(CHUNK_ENRICHMENT_CONCURRENCY);
  private contexts: Map<string, ProviderContext> = new Map();
  private runStartedAt = "";
  private onComplete?: (coll: string) => Promise<void>;

  constructor(private readonly applier: EnrichmentApplier) {}

  init(
    contexts: ReadonlyMap<string, ProviderContext>,
    _coll: string,
    runStartedAt: string,
  ): void {
    this.contexts = new Map(contexts);
    this.runStartedAt = runStartedAt;
    this.states.clear();
    for (const key of contexts.keys()) this.states.set(key, createState());
  }

  setOnComplete(cb: (coll: string) => Promise<void>): void {
    this.onComplete = cb;
  }

  /** Streaming entry — fire-and-forget per provider. */
  onBatch(coll: string, absolutePath: string, items: ChunkItem[]): void {
    for (const ctx of this.contexts.values()) {
      const state = this.states.get(ctx.key);
      if (!state) continue;
      const root = ctx.effectiveRoot ?? absolutePath;
      const map = this.extractBatchChunkMap(items, root);
      this.runChunkSignals(
        ctx,
        state,
        coll,
        root,
        map,
        /* useSemaphore */ true,
      );
    }
  }

  /** Post-flush catch-up entry — applied to files NOT covered by streaming. */
  enrichRemaining(
    coll: string,
    absolutePath: string,
    chunkMap: Map<string, ChunkLookupEntry[]>,
  ): void {
    const providerPromises: Promise<boolean>[] = [];

    for (const ctx of this.contexts.values()) {
      const state = this.states.get(ctx.key);
      if (!state) continue;
      state.chunkEnrichmentInvoked = true;

      const root = ctx.effectiveRoot ?? absolutePath;
      const filtered = this.filterByIgnore(chunkMap, ctx.ignoreFilter, root);
      const remaining = new Map<string, ChunkLookupEntry[]>();
      for (const [filePath, entries] of filtered) {
        const rel = filePath.startsWith(root)
          ? filePath.slice(root.length + 1)
          : filePath;
        if (!state.streamingEnrichedFiles.has(rel))
          remaining.set(filePath, entries);
      }
      if (remaining.size === 0) {
        pipelineLog.enrichmentPhase("CHUNK_ENRICHMENT_SKIPPED", {
          provider: ctx.key,
          reason: "all files enriched via streaming",
          streamingEnrichedFiles: state.streamingEnrichedFiles.size,
        });
        providerPromises.push(Promise.resolve(true));
        continue;
      }

      pipelineLog.enrichmentPhase("CHUNK_ENRICHMENT_START", {
        provider: ctx.key,
        files: remaining.size,
        streamingEnrichedFiles: state.streamingEnrichedFiles.size,
      });

      providerPromises.push(
        this.runChunkSignals(
          ctx,
          state,
          coll,
          root,
          remaining,
          /* useSemaphore */ false,
        ),
      );
    }

    if (providerPromises.length > 0 && this.onComplete) {
      const cb = this.onComplete;
      void Promise.allSettled(providerPromises).then(async (results) => {
        if (!results.some((r) => r.status === "fulfilled" && r.value === true))
          return;
        try {
          await cb(coll);
        } catch (error) {
          console.error(
            "[Enrichment] onChunkEnrichmentComplete callback failed:",
            error,
          );
        }
      });
    }
  }

  async drain(): Promise<void> {
    const all = [...this.states.values()].flatMap((s) => s.chunkWork);
    if (all.length === 0) return;
    await Promise.allSettled(all);
    for (const state of this.states.values()) state.chunkWork.length = 0;
  }

  hasChunkEnrichmentFailed(providerKey: string): boolean {
    return this.states.get(providerKey)?.chunkEnrichmentFailed ?? false;
  }

  getMetrics(): ChunkPhaseMetrics {
    let total = 0;
    for (const s of this.states.values()) total += s.chunkEnrichmentDurationMs;
    return { totalChunkEnrichmentDurationMs: total };
  }

  /** Single skeleton: build chunk signals, apply, log, track work. */
  private runChunkSignals(
    ctx: ProviderContext,
    state: ChunkPhaseState,
    coll: string,
    root: string,
    chunkMap: Map<string, ChunkLookupEntry[]>,
    useSemaphore: boolean,
  ): Promise<boolean> {
    if (chunkMap.size === 0) return Promise.resolve(true);

    if (useSemaphore) {
      // Mark files as streaming-enriched BEFORE the async work to avoid races
      // with enrichRemaining.
      for (const relPath of chunkMap.keys())
        state.streamingEnrichedFiles.add(relPath);
    }

    const allChunkIds = new Set<string>();
    for (const entries of chunkMap.values())
      for (const e of entries) allChunkIds.add(e.chunkId);

    const start = Date.now();
    const opts = useSemaphore
      ? { concurrencySemaphore: this.semaphore, skipCache: true }
      : { skipCache: true };

    const work = ctx.provider
      .buildChunkSignals(root, chunkMap, opts)
      .then(async (overlays: Map<string, Map<string, ChunkSignalOverlay>>) => {
        const applied = await this.applier.applyChunkSignals(
          coll,
          ctx.key,
          overlays,
          this.runStartedAt,
          allChunkIds,
        );
        state.chunkEnrichmentDurationMs += Date.now() - start;
        pipelineLog.enrichmentPhase(
          useSemaphore
            ? "STREAMING_CHUNK_ENRICHMENT_COMPLETE"
            : "CHUNK_ENRICHMENT_COMPLETE",
          { provider: ctx.key, files: chunkMap.size, overlaysApplied: applied },
        );
        return true;
      })
      .catch((error: unknown) => {
        state.chunkEnrichmentDurationMs += Date.now() - start;
        if (!useSemaphore) state.chunkEnrichmentFailed = true;
        pipelineLog.enrichmentPhase(
          useSemaphore
            ? "STREAMING_CHUNK_ENRICHMENT_FAILED"
            : "CHUNK_ENRICHMENT_FAILED",
          {
            provider: ctx.key,
            error: error instanceof Error ? error.message : String(error),
          },
        );
        return false;
      });

    state.chunkWork.push(work.then(() => undefined));
    return work;
  }

  private extractBatchChunkMap(
    items: ChunkItem[],
    pathBase: string,
  ): Map<string, ChunkLookupEntry[]> {
    const map = new Map<string, ChunkLookupEntry[]>();
    for (const item of items) {
      const fp = item.chunk.metadata.filePath;
      const rel = fp.startsWith(pathBase) ? fp.slice(pathBase.length + 1) : fp;
      const arr = map.get(rel) ?? [];
      arr.push({
        chunkId: item.chunkId,
        startLine: item.chunk.startLine,
        endLine: item.chunk.endLine,
      });
      map.set(rel, arr);
    }
    return map;
  }

  private filterByIgnore(
    map: Map<string, ChunkLookupEntry[]>,
    ignoreFilter: ProviderContext["ignoreFilter"],
    root: string,
  ): Map<string, ChunkLookupEntry[]> {
    if (!ignoreFilter) return map;
    const out = new Map<string, ChunkLookupEntry[]>();
    for (const [filePath, entries] of map) {
      const rel = filePath.startsWith(root)
        ? filePath.slice(root.length + 1)
        : filePath;
      if (!ignoreFilter.ignores(rel)) out.set(filePath, entries);
    }
    return out;
  }
}
```

- [ ] **Step 5: Wire `ChunkPhase` into Coordinator**

In `coordinator.ts`:

1. Import: `import { ChunkPhase } from "./chunk-phase.js";`
2. Add field: `private readonly chunkPhase: ChunkPhase;`
3. In constructor, after applier:
   `this.chunkPhase = new ChunkPhase(this.applier);`
4. Replace the `onChunkEnrichmentComplete` setter with a delegation:

```typescript
  set onChunkEnrichmentComplete(cb: (coll: string) => Promise<void>) {
    this.chunkPhase.setOnComplete(cb);
  }
```

5. In `prefetch()`, after computing `this.contexts`, call
   `this.chunkPhase.init(this.contexts, collectionName ?? "", this.runStartedAt);`.
6. In `onChunksStored`, replace the chunk-half (the `extractBatchChunkMap` +
   `startStreamingChunkEnrichment` call) with
   `this.chunkPhase.onBatch(coll, absolutePath, items);`.
7. In `startChunkEnrichment`, replace the entire body with
   `this.chunkPhase.enrichRemaining(collectionName, absolutePath, chunkMap);`.
8. Delete `startStreamingChunkEnrichment` and the original
   `startChunkEnrichment` bodies; delete the `chunkSemaphore` field,
   `extractBatchChunkMap`, and `CHUNK_ENRICHMENT_CONCURRENCY` from
   `coordinator.ts`.

`ProviderState` retains `chunkWork`, `streamingEnrichedFiles`,
`chunkEnrichmentDurationMs`, `chunkEnrichmentFailed`, `chunkEnrichmentInvoked`
fields temporarily — `awaitCompletion` still reads them. Sync them at the end of
`awaitCompletion` step 6 by reading `this.chunkPhase.getMetrics()` and
`hasChunkEnrichmentFailed(...)` instead. Replace the
`state.chunkEnrichmentDurationMs` read in `chunkMarker` construction:

```typescript
      // Before: durationMs: state.chunkEnrichmentDurationMs,
      durationMs: this.chunkPhase.getMetrics().totalChunkEnrichmentDurationMs,
      // and:
      // Before: if (state.prefetchFailed || state.chunkEnrichmentFailed) chunkStatus = "failed";
      if (state.prefetchFailed || this.chunkPhase.hasChunkEnrichmentFailed(state.provider.key)) chunkStatus = "failed";
```

In the `aggregateProviderMetrics` call, replace `totalChunkEnrichmentDurationMs`
with the value from `this.chunkPhase.getMetrics()`.

Drain: in `awaitCompletion` step 6, replace the `flatMap((s) => s.chunkWork)`
loop with `await this.chunkPhase.drain();`.

- [ ] **Step 6: Run vitest + tsc**

```bash
npx vitest run
npx tsc --noEmit
```

Expected: GREEN.

- [ ] **Step 7: Commit**

```bash
git add \
  src/core/domains/ingest/pipeline/enrichment/chunk-phase.ts \
  src/core/domains/ingest/pipeline/enrichment/coordinator.ts \
  tests/core/domains/ingest/pipeline/enrichment/chunk-phase.test.ts
git commit -m "$(cat <<'EOF'
refactor(enrichment): extract ChunkPhase with shared Semaphore + streaming dedup

ChunkPhase owns chunk-signal enrichment for both streaming (per-batch)
and post-flush catch-up entry points, sharing one Semaphore(10).
Private runChunkSignals helper deduplicates the build-apply-mark
skeleton previously copy-pasted across two methods. Coordinator
delegates onChunksStored chunk half and startChunkEnrichment.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

- [ ] **Step 8: Close beads task**

```bash
bd close $T5
```

---

## Task 6: Extract `FilePhase`

**Goal:** Move file-prefetch + per-batch file-signal apply + `pendingBatches`
drain into a new `FilePhase`. After this task `ProviderState` is reduced to a
small remainder used only inside the coordinator for the file-final marker
write.

**Beads:**

```bash
bd dolt pull
bd create \
  --title="Extract FilePhase: prefetch + per-batch apply + pendingBatches drain" \
  --description="Create file-phase.ts with init, startPrefetch, onBatch, awaitPrefetch, drain, getMetrics, hasPrefetchFailed, getPrefetchDurationMs. Owns Map<key, FilePhaseState> with prefetchPromise, fileMetadata, pendingBatches, fileWork, timing fields. On prefetch error writes markerStore.markPrefetchFailed. Coordinator delegates prefetch start, onChunksStored file half. Tests in file-phase.test.ts." \
  --type=task \
  --priority=2
# Capture as $T6
bd label add $T6 architecture
bd dep add $T6 $EPIC
bd dep add $T6 $T5
```

**Files:**

- Create: `src/core/domains/ingest/pipeline/enrichment/file-phase.ts`
- Create: `tests/core/domains/ingest/pipeline/enrichment/file-phase.test.ts`
- Modify: `src/core/domains/ingest/pipeline/enrichment/coordinator.ts`

---

- [ ] **Step 1: Mark task in progress**

```bash
bd update $T6 --status=in_progress
```

- [ ] **Step 2: Write failing tests**

Create `tests/core/domains/ingest/pipeline/enrichment/file-phase.test.ts`:

```typescript
import { describe, expect, it, vi } from "vitest";

import { MockQdrantManager } from "../../__helpers__/test-helpers.js";
import { EnrichmentApplier } from "../../../../../../src/core/domains/ingest/pipeline/enrichment/applier.js";
import { FilePhase } from "../../../../../../src/core/domains/ingest/pipeline/enrichment/file-phase.js";
import { EnrichmentMarkerStore } from "../../../../../../src/core/domains/ingest/pipeline/enrichment/marker-store.js";

function buildCtx(buildFileSignals = vi.fn().mockResolvedValue(new Map())) {
  return {
    key: "git",
    provider: {
      key: "git",
      buildFileSignals,
      buildChunkSignals: vi.fn(),
      resolveRoot: (p: string) => p,
      fileSignalTransform: undefined,
    } as any,
    effectiveRoot: "/repo",
    ignoreFilter: null,
  };
}

const items = [
  {
    chunkId: "c1",
    chunk: {
      metadata: { filePath: "/repo/src/a.ts" },
      startLine: 1,
      endLine: 10,
    },
  } as any,
];

describe("FilePhase", () => {
  it("buffers batches that arrive before prefetch resolves, then drains them", async () => {
    const qdrant = new MockQdrantManager();
    const applier = new EnrichmentApplier(qdrant as any);
    const marker = new EnrichmentMarkerStore(qdrant as any);

    let resolvePrefetch!: (v: Map<string, any>) => void;
    const buildFileSignals = vi.fn(
      () =>
        new Promise<Map<string, any>>((res) => {
          resolvePrefetch = res;
        }),
    );
    const ctx = buildCtx(buildFileSignals);

    const phase = new FilePhase(applier, marker);
    phase.init(new Map([[ctx.key, ctx]]), "coll", "run-1", "ts");
    phase.startPrefetch();
    phase.onBatch("coll", "/repo", items); // arrives before prefetch
    expect(applier.matchedFiles).toBe(0);

    resolvePrefetch(new Map([["src/a.ts", { authorPct: 100 }]]));
    await phase.awaitPrefetch();
    await phase.drain();
    expect(applier.matchedFiles).toBeGreaterThanOrEqual(1);
  });

  it("writes markPrefetchFailed when prefetch rejects", async () => {
    const qdrant = new MockQdrantManager();
    const applier = new EnrichmentApplier(qdrant as any);
    const marker = new EnrichmentMarkerStore(qdrant as any);
    await marker.markStart("coll", ["git"], "run-1", "ts");

    const ctx = buildCtx(vi.fn().mockRejectedValue(new Error("boom")));
    const phase = new FilePhase(applier, marker);
    phase.init(new Map([[ctx.key, ctx]]), "coll", "run-1", "ts");
    phase.startPrefetch();
    await phase.awaitPrefetch();
    expect(phase.hasPrefetchFailed("git")).toBe(true);
    const m = (await marker.read("coll"))!.git as any;
    expect(m.file.status).toBe("failed");
  });
});
```

- [ ] **Step 3: Run — verify FAIL**

```bash
npx vitest run tests/core/domains/ingest/pipeline/enrichment/file-phase.test.ts
```

Expected: FAIL — module not found.

- [ ] **Step 4: Create `file-phase.ts`**

Create `src/core/domains/ingest/pipeline/enrichment/file-phase.ts`. Move
`Coordinator.prefetch` body, `Coordinator.onChunksStored` file half (not the
chunk dispatch — that's already in `ChunkPhase`), and
`Coordinator.flushPendingBatches`. Then:

```typescript
/**
 * FilePhase — provider.buildFileSignals prefetch and per-batch
 * applyFileSignals dispatch. Buffers batches that arrive before prefetch
 * resolves; drains them via prefetch.then().
 */

import type { FileSignalOverlay } from "../../../../contracts/types/provider.js";
import { pipelineLog } from "../infra/debug-logger.js";
import type { ChunkItem } from "../types.js";
import type { EnrichmentApplier } from "./applier.js";
import type { EnrichmentMarkerStore } from "./marker-store.js";
import type { ProviderContext } from "./types.js";

interface PendingBatch {
  collectionName: string;
  absolutePath: string;
  items: ChunkItem[];
}

interface FilePhaseState {
  prefetchPromise: Promise<Map<string, FileSignalOverlay>> | null;
  fileMetadata: Map<string, FileSignalOverlay> | null;
  prefetchFailed: boolean;
  pendingBatches: PendingBatch[];
  fileWork: Promise<void>[];
  prefetchStartTime: number;
  prefetchEndTime: number;
  pipelineFlushTime: number;
  prefetchDurationMs: number;
  streamingApplies: number;
  flushApplies: number;
  fileMetadataCount: number;
}

function createState(): FilePhaseState {
  return {
    prefetchPromise: null,
    fileMetadata: null,
    prefetchFailed: false,
    pendingBatches: [],
    fileWork: [],
    prefetchStartTime: 0,
    prefetchEndTime: 0,
    pipelineFlushTime: 0,
    prefetchDurationMs: 0,
    streamingApplies: 0,
    flushApplies: 0,
    fileMetadataCount: 0,
  };
}

export interface FilePhaseMetrics {
  maxPrefetchDurationMs: number;
  totalStreamingApplies: number;
  totalFlushApplies: number;
  totalFileMetadataCount: number;
  firstProvider: {
    prefetchStartTime: number;
    prefetchEndTime: number;
    pipelineFlushTime: number;
  } | null;
}

export class FilePhase {
  private readonly states = new Map<string, FilePhaseState>();
  private contexts: Map<string, ProviderContext> = new Map();
  private coll = "";
  private runId = "";
  private runStartedAt = "";
  private changedPaths: string[] | undefined;

  constructor(
    private readonly applier: EnrichmentApplier,
    private readonly markerStore: EnrichmentMarkerStore,
  ) {}

  init(
    contexts: ReadonlyMap<string, ProviderContext>,
    coll: string,
    runId: string,
    runStartedAt: string,
  ): void {
    this.contexts = new Map(contexts);
    this.coll = coll;
    this.runId = runId;
    this.runStartedAt = runStartedAt;
    this.states.clear();
    for (const key of contexts.keys()) this.states.set(key, createState());
  }

  startPrefetch(changedPaths?: string[]): void {
    this.changedPaths = changedPaths;
    for (const ctx of this.contexts.values()) {
      const state = this.states.get(ctx.key)!;
      const root = ctx.effectiveRoot;
      if (!root) continue;
      state.prefetchStartTime = Date.now();

      pipelineLog.enrichmentPhase("PREFETCH_START", {
        provider: ctx.key,
        path: root,
      });
      state.prefetchPromise = ctx.provider
        .buildFileSignals(
          root,
          changedPaths ? { paths: changedPaths } : undefined,
        )
        .then((result) => {
          state.prefetchEndTime = Date.now();
          state.prefetchDurationMs =
            state.prefetchEndTime - state.prefetchStartTime;
          const filtered = this.filterByIgnore(result, ctx.ignoreFilter);
          state.fileMetadata = filtered;
          state.fileMetadataCount = filtered.size;
          pipelineLog.enrichmentPhase("PREFETCH_COMPLETE", {
            provider: ctx.key,
            filesInLog: result.size,
            durationMs: state.prefetchDurationMs,
          });
          pipelineLog.addStageTime(
            "enrichment_prefetch",
            state.prefetchDurationMs,
          );
          this.flushPending(ctx, state);
          return result;
        })
        .catch((error: unknown) => {
          state.prefetchFailed = true;
          state.prefetchEndTime = Date.now();
          state.prefetchDurationMs =
            state.prefetchEndTime - state.prefetchStartTime;
          const msg = error instanceof Error ? error.message : String(error);
          console.error(`[Enrichment:${ctx.key}] Prefetch failed:`, msg);
          pipelineLog.enrichmentPhase("PREFETCH_FAILED", {
            provider: ctx.key,
            error: msg,
            durationMs: state.prefetchDurationMs,
          });
          state.pendingBatches = [];
          if (this.coll) {
            void this.markerStore.markPrefetchFailed(
              this.coll,
              ctx.key,
              this.runId,
              this.runStartedAt,
              state.prefetchDurationMs,
            );
          }
          return new Map();
        });
    }
  }

  onBatch(coll: string, absolutePath: string, items: ChunkItem[]): void {
    for (const ctx of this.contexts.values()) {
      const state = this.states.get(ctx.key);
      if (!state || state.prefetchFailed) continue;
      state.pipelineFlushTime = Date.now();

      if (state.fileMetadata) {
        const pathBase = ctx.effectiveRoot ?? absolutePath;
        const work = this.applier.applyFileSignals(
          coll,
          ctx.key,
          state.fileMetadata,
          pathBase,
          items,
          ctx.provider.fileSignalTransform,
          this.runStartedAt,
        );
        state.fileWork.push(work);
        state.streamingApplies++;
        pipelineLog.enrichmentPhase("STREAMING_APPLY", {
          provider: ctx.key,
          chunks: items.length,
        });
      } else {
        state.pendingBatches.push({
          collectionName: coll,
          absolutePath,
          items,
        });
      }
    }
  }

  async awaitPrefetch(): Promise<void> {
    const promises = [...this.states.values()]
      .map((s) => s.prefetchPromise)
      .filter((p): p is Promise<Map<string, FileSignalOverlay>> => p !== null);
    if (promises.length > 0) await Promise.allSettled(promises);
  }

  async drain(): Promise<void> {
    const all = [...this.states.values()].flatMap((s) => s.fileWork);
    if (all.length === 0) return;
    await Promise.allSettled(all);
    for (const s of this.states.values()) s.fileWork.length = 0;
  }

  hasPrefetchFailed(providerKey: string): boolean {
    return this.states.get(providerKey)?.prefetchFailed ?? false;
  }

  getPrefetchDurationMs(providerKey: string): number {
    return this.states.get(providerKey)?.prefetchDurationMs ?? 0;
  }

  getMetrics(): FilePhaseMetrics {
    let max = 0,
      stream = 0,
      flush = 0,
      meta = 0;
    let first: FilePhaseMetrics["firstProvider"] = null;
    let i = 0;
    for (const s of this.states.values()) {
      max = Math.max(max, s.prefetchDurationMs);
      stream += s.streamingApplies;
      flush += s.flushApplies;
      meta += s.fileMetadataCount;
      if (i++ === 0) {
        first = {
          prefetchStartTime: s.prefetchStartTime,
          prefetchEndTime: s.prefetchEndTime,
          pipelineFlushTime: s.pipelineFlushTime,
        };
      }
    }
    return {
      maxPrefetchDurationMs: max,
      totalStreamingApplies: stream,
      totalFlushApplies: flush,
      totalFileMetadataCount: meta,
      firstProvider: first,
    };
  }

  private flushPending(ctx: ProviderContext, state: FilePhaseState): void {
    if (state.pendingBatches.length === 0) return;
    const batches = state.pendingBatches;
    state.pendingBatches = [];
    pipelineLog.enrichmentPhase("FLUSH_APPLY", {
      provider: ctx.key,
      batches: batches.length,
      chunks: batches.reduce((sum, b) => sum + b.items.length, 0),
    });
    for (const batch of batches) {
      if (!state.fileMetadata) continue;
      const pathBase = ctx.effectiveRoot ?? batch.absolutePath;
      const work = this.applier.applyFileSignals(
        batch.collectionName,
        ctx.key,
        state.fileMetadata,
        pathBase,
        batch.items,
        ctx.provider.fileSignalTransform,
        this.runStartedAt,
      );
      state.fileWork.push(work);
      state.flushApplies++;
    }
  }

  private filterByIgnore(
    input: Map<string, FileSignalOverlay>,
    ignoreFilter: ProviderContext["ignoreFilter"],
  ): Map<string, FileSignalOverlay> {
    if (!ignoreFilter) return input;
    const out = new Map<string, FileSignalOverlay>();
    let filtered = 0;
    for (const [path, value] of input) {
      if (ignoreFilter.ignores(path)) {
        filtered++;
      } else {
        out.set(path, value);
      }
    }
    if (filtered > 0) {
      pipelineLog.enrichmentPhase("PREFETCH_FILTERED", {
        filtered,
        remainingFiles: out.size,
      });
    }
    return out;
  }
}
```

- [ ] **Step 5: Wire `FilePhase` into Coordinator**

In `coordinator.ts`:

1. Import: `import { FilePhase } from "./file-phase.js";`
2. Add field: `private readonly filePhase: FilePhase;`
3. Constructor:
   `this.filePhase = new FilePhase(this.applier, this.markerStore);`
4. In `prefetch()`, after `this.contexts = new Map(...)`:

```typescript
this.filePhase.init(
  this.contexts,
  collectionName ?? "",
  this.runId,
  this.runStartedAt,
);
this.chunkPhase.init(this.contexts, collectionName ?? "", this.runStartedAt);
if (collectionName) {
  void this.markerStore.markStart(
    collectionName,
    [...this.contexts.keys()],
    this.runId,
    this.runStartedAt,
  );
}
this.filePhase.startPrefetch(changedPaths);
```

Delete the old prefetch loop, the `state.prefetchPromise` assignment, and the
`state.ignoreFilter`/`state.effectiveRoot` field assignments. The
`ProviderState` shape shrinks accordingly — remove these fields from the
interface and from `createProviderState`.

5. In `onChunksStored`, replace the file half with:

```typescript
this.filePhase.onBatch(collectionName, absolutePath, items);
this.chunkPhase.onBatch(collectionName, absolutePath, items);
```

6. Delete `flushPendingBatches`, `extractBatchChunkMap` (moved to ChunkPhase),
   the file-related fields on `ProviderState` (`prefetchPromise`,
   `fileMetadata`, `prefetchFailed`, `effectiveRoot`, `ignoreFilter`,
   `pendingBatches`, `fileWork`, `prefetchStartTime`, `prefetchEndTime`,
   `pipelineFlushTime`, `prefetchDurationMs`, `streamingApplies`,
   `flushApplies`, `fileMetadataCount`), and the helper `filterByIgnore`.

7. In `awaitCompletion`:
   - Replace `await Promise.allSettled(prefetchPromises)` with
     `await this.filePhase.awaitPrefetch();`
   - Replace the file-work drain with `await this.filePhase.drain();`
   - Build the file-final input from `this.filePhase.getPrefetchDurationMs(...)`
     and `this.filePhase.hasPrefetchFailed(...)` instead of state fields.
   - Build the metrics aggregation from `this.filePhase.getMetrics()` and
     `this.chunkPhase.getMetrics()`.

   The `aggregateProviderMetrics` helper is no longer needed — delete it.

`ProviderState` after this Task should contain only `provider` (used in the loop
over `this.states.values()` for the marker writes — Task 7 + 8 will collapse
this further).

- [ ] **Step 6: Run vitest + tsc**

```bash
npx vitest run
npx tsc --noEmit
```

Expected: GREEN.

- [ ] **Step 7: Commit**

```bash
git add \
  src/core/domains/ingest/pipeline/enrichment/file-phase.ts \
  src/core/domains/ingest/pipeline/enrichment/coordinator.ts \
  tests/core/domains/ingest/pipeline/enrichment/file-phase.test.ts
git commit -m "$(cat <<'EOF'
refactor(enrichment): extract FilePhase with prefetch + per-batch apply

FilePhase owns provider.buildFileSignals prefetch, per-batch
applyFileSignals dispatch, pendingBatches buffer drain, and
markPrefetchFailed write on prefetch error. ProviderState shrinks to
just {provider}. extractBatchChunkMap, flushPendingBatches,
filterByIgnore, aggregateProviderMetrics removed from coordinator.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

- [ ] **Step 8: Close beads task**

```bash
bd close $T6
```

---

## Task 7: Extract `CompletionRunner`

**Goal:** Move the 138-line `awaitCompletion` body into a new
`CompletionRunner.run(coll, contexts, startTime)` with explicit 7 steps of 3-5
lines each. Coordinator's `awaitCompletion` becomes a one-liner.

**Beads:**

```bash
bd dolt pull
bd create \
  --title="Extract CompletionRunner with explicit 7-step run() sequence" \
  --description="Create completion-runner.ts with run(coll, contexts, startTime) → EnrichmentMetrics. Sequence: drain prefetch → drain fileWork → backfill per ctx → markFileFinal per ctx → aggregate metrics → drain chunkWork → markChunkFinal per ctx. Coordinator.awaitCompletion becomes one-liner. Tests in completion-runner.test.ts." \
  --type=task \
  --priority=2
# Capture as $T7
bd label add $T7 architecture
bd dep add $T7 $EPIC
bd dep add $T7 $T6
```

**Files:**

- Create: `src/core/domains/ingest/pipeline/enrichment/completion-runner.ts`
- Create:
  `tests/core/domains/ingest/pipeline/enrichment/completion-runner.test.ts`
- Modify: `src/core/domains/ingest/pipeline/enrichment/coordinator.ts`

---

- [ ] **Step 1: Mark task in progress**

```bash
bd update $T7 --status=in_progress
```

- [ ] **Step 2: Write failing test**

Create
`tests/core/domains/ingest/pipeline/enrichment/completion-runner.test.ts`:

```typescript
import { describe, expect, it, vi } from "vitest";

import { MockQdrantManager } from "../../__helpers__/test-helpers.js";
import { EnrichmentApplier } from "../../../../../../src/core/domains/ingest/pipeline/enrichment/applier.js";
import { EnrichmentBackfiller } from "../../../../../../src/core/domains/ingest/pipeline/enrichment/backfiller.js";
import { ChunkPhase } from "../../../../../../src/core/domains/ingest/pipeline/enrichment/chunk-phase.js";
import { CompletionRunner } from "../../../../../../src/core/domains/ingest/pipeline/enrichment/completion-runner.js";
import { FilePhase } from "../../../../../../src/core/domains/ingest/pipeline/enrichment/file-phase.js";
import { EnrichmentMarkerStore } from "../../../../../../src/core/domains/ingest/pipeline/enrichment/marker-store.js";

describe("CompletionRunner", () => {
  it("runs the 7-step sequence and writes both file and chunk markers", async () => {
    const qdrant = new MockQdrantManager();
    const applier = new EnrichmentApplier(qdrant as any);
    const marker = new EnrichmentMarkerStore(qdrant as any);
    const filePhase = new FilePhase(applier, marker);
    const chunkPhase = new ChunkPhase(applier);
    const backfiller = new EnrichmentBackfiller(applier, qdrant as any);
    const runner = new CompletionRunner({
      filePhase,
      chunkPhase,
      backfiller,
      applier,
      markerStore: marker,
    });

    const ctx = {
      key: "git",
      provider: {
        key: "git",
        buildFileSignals: vi.fn().mockResolvedValue(new Map()),
        buildChunkSignals: vi.fn().mockResolvedValue(new Map()),
        resolveRoot: (p: string) => p,
        fileSignalTransform: undefined,
      } as any,
      effectiveRoot: "/repo",
      ignoreFilter: null,
    };
    const contexts = new Map([[ctx.key, ctx]]);
    filePhase.init(contexts, "coll", "run-1", "ts");
    chunkPhase.init(contexts, "coll", "ts");
    filePhase.startPrefetch();
    await marker.markStart("coll", ["git"], "run-1", "ts");

    const m = await runner.run("coll", contexts, Date.now() - 1000);
    expect(m.totalDurationMs).toBeGreaterThanOrEqual(0);
    const final = (await marker.read("coll"))!.git as any;
    expect(final.file.status).toBe("completed");
    expect(final.chunk.status).toBe("completed");
  });
});
```

- [ ] **Step 3: Run — verify FAIL**

```bash
npx vitest run tests/core/domains/ingest/pipeline/enrichment/completion-runner.test.ts
```

Expected: FAIL — module not found.

- [ ] **Step 4: Create `completion-runner.ts`**

Create `src/core/domains/ingest/pipeline/enrichment/completion-runner.ts`:

```typescript
/**
 * CompletionRunner — final 7-step sequence:
 *  1. drain prefetch
 *  2. drain fileWork
 *  3. backfill per ctx
 *  4. markFileFinal per ctx
 *  5. aggregate metrics
 *  6. drain chunkWork
 *  7. markChunkFinal per ctx
 */

import type { EnrichmentMetrics } from "../../../../types.js";
import { pipelineLog } from "../infra/debug-logger.js";
import type { EnrichmentApplier } from "./applier.js";
import type { EnrichmentBackfiller } from "./backfiller.js";
import type { ChunkPhase } from "./chunk-phase.js";
import type { FilePhase } from "./file-phase.js";
import type { EnrichmentMarkerStore } from "./marker-store.js";
import type { ChunkFinalInput, ProviderContext } from "./types.js";

export interface CompletionRunnerDeps {
  filePhase: FilePhase;
  chunkPhase: ChunkPhase;
  backfiller: EnrichmentBackfiller;
  applier: EnrichmentApplier;
  markerStore: EnrichmentMarkerStore;
}

export class CompletionRunner {
  constructor(private readonly deps: CompletionRunnerDeps) {}

  async run(
    coll: string,
    contexts: ReadonlyMap<string, ProviderContext>,
    startTime: number,
  ): Promise<EnrichmentMetrics> {
    const { filePhase, chunkPhase, backfiller, applier, markerStore } =
      this.deps;

    // 1. drain prefetch
    await filePhase.awaitPrefetch();

    // 2. drain fileWork
    await filePhase.drain();

    // 3. backfill per ctx
    if (applier.getMissedFileChunks().size > 0) {
      for (const ctx of contexts.values()) {
        if (filePhase.hasPrefetchFailed(ctx.key)) continue;
        await backfiller.runFor(
          coll,
          ctx,
          /* runStartedAt — owned by FilePhase init; passed through */ "",
        );
      }
    }

    // 4. markFileFinal per ctx
    for (const ctx of contexts.values()) {
      const fileUnenriched = 0; // recovery.countUnenriched is wired in coordinator until Task 8 — kept here as 0 to keep run() pure of side-state
      await markerStore.markFileFinal(coll, ctx.key, {
        status: filePhase.hasPrefetchFailed(ctx.key) ? "failed" : "completed",
        durationMs: filePhase.getPrefetchDurationMs(ctx.key),
        unenrichedChunks: fileUnenriched,
        matchedFiles: applier.matchedFiles,
        missedFiles: applier.missedFiles,
      });
    }

    // 5. aggregate metrics
    const fileMetrics = filePhase.getMetrics();
    const chunkMetrics = chunkPhase.getMetrics();
    const metrics: EnrichmentMetrics = {
      prefetchDurationMs: fileMetrics.maxPrefetchDurationMs,
      overlapMs: 0,
      overlapRatio: 0,
      streamingApplies: fileMetrics.totalStreamingApplies,
      flushApplies: fileMetrics.totalFlushApplies,
      chunkChurnDurationMs: chunkMetrics.totalChunkEnrichmentDurationMs,
      totalDurationMs: Date.now() - (startTime || Date.now()),
      matchedFiles: applier.matchedFiles,
      missedFiles: applier.missedFiles,
      missedPathSamples: [...applier.missedPathSamples],
      gitLogFileCount: fileMetrics.totalFileMetadataCount,
      estimatedSavedMs: 0,
    };
    if (
      fileMetrics.firstProvider &&
      fileMetrics.firstProvider.prefetchEndTime > 0 &&
      fileMetrics.firstProvider.pipelineFlushTime > 0
    ) {
      const overlapEnd = Math.min(
        fileMetrics.firstProvider.prefetchEndTime,
        fileMetrics.firstProvider.pipelineFlushTime,
      );
      metrics.overlapMs = Math.max(
        0,
        overlapEnd - fileMetrics.firstProvider.prefetchStartTime,
      );
      metrics.overlapRatio =
        metrics.prefetchDurationMs > 0
          ? Math.min(1, metrics.overlapMs / metrics.prefetchDurationMs)
          : 0;
    }
    metrics.estimatedSavedMs = Math.max(0, metrics.overlapMs);

    // 6. drain chunkWork
    await chunkPhase.drain();

    // 7. markChunkFinal per ctx
    for (const ctx of contexts.values()) {
      const chunkUnenriched = 0; // see note in step 4
      let chunkStatus: ChunkFinalInput["status"];
      if (
        filePhase.hasPrefetchFailed(ctx.key) ||
        chunkPhase.hasChunkEnrichmentFailed(ctx.key)
      ) {
        chunkStatus = "failed";
      } else if (chunkUnenriched > 0) {
        chunkStatus = "degraded";
      } else {
        chunkStatus = "completed";
      }
      await markerStore.markChunkFinal(coll, ctx.key, {
        status: chunkStatus,
        durationMs: chunkMetrics.totalChunkEnrichmentDurationMs,
        unenrichedChunks: chunkUnenriched,
      });
    }

    pipelineLog.enrichmentPhase("ALL_COMPLETE", { ...metrics });
    return metrics;
  }
}
```

> The `unenrichedChunks` reads from `EnrichmentRecovery.countUnenriched` are
> wired through Coordinator (which owns the optional `recovery` reference) in
> the next Task — Task 8 introduces a `unenrichedReader` callback parameter on
> `run()` so CompletionRunner stays decoupled from Recovery. Keeping the values
> at `0` here for one Task is safe: this plan's race-guard test in Task 3 covers
> the recovery path; the file/chunk markers still report `completed/degraded`
> based on prefetch and chunk-enrichment outcomes, just with the recovery count
> not yet plumbed through.

- [ ] **Step 5: Wire `CompletionRunner` into Coordinator**

In `coordinator.ts`:

1. Import: `import { CompletionRunner } from "./completion-runner.js";`
2. Field + ctor:
   `this.completion = new CompletionRunner({ filePhase: this.filePhase, chunkPhase: this.chunkPhase, backfiller: this.backfiller, applier: this.applier, markerStore: this.markerStore });`
3. Replace `awaitCompletion` body with:

```typescript
  async awaitCompletion(collectionName: string): Promise<EnrichmentMetrics> {
    if (this.contexts.size === 0) {
      return EMPTY_METRICS;
    }
    return this.completion.run(collectionName, this.contexts, this.startTime);
  }
```

Where `EMPTY_METRICS` is the same zero-valued object the current
`awaitCompletion` returns when `this.states.size === 0`. Define it as a
module-level constant in `coordinator.ts`.

4. Delete the old 138-line `awaitCompletion` body.
5. Delete the now-unused `aggregateProviderMetrics` helper if not removed
   earlier.

- [ ] **Step 6: Run vitest + tsc**

```bash
npx vitest run
npx tsc --noEmit
```

Expected: GREEN. Note: the `coordinator.test.ts` integration test may now show
`unenrichedChunks: 0` where it previously read recovery counts — verify this is
the only change. Task 8 plumbs the count back through.

- [ ] **Step 7: Commit**

```bash
git add \
  src/core/domains/ingest/pipeline/enrichment/completion-runner.ts \
  src/core/domains/ingest/pipeline/enrichment/coordinator.ts \
  tests/core/domains/ingest/pipeline/enrichment/completion-runner.test.ts
git commit -m "$(cat <<'EOF'
refactor(enrichment): extract CompletionRunner with explicit 7-step run

CompletionRunner.run() implements the finalization sequence as 7
labeled steps of 3-5 lines each. Coordinator.awaitCompletion is a
single delegation. unenrichedChunks plumbed through in Task 8.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

- [ ] **Step 8: Close beads task**

```bash
bd close $T7
```

---

## Task 8: Coordinator finalization + barrel cleanup

**Goal:** Final tidy. Plumb `recovery.countUnenriched` through CompletionRunner
via a callback. Delete `ProviderState`, `createProviderState`, the `providerKey`
deprecated getter. Update `enrichment/index.ts` barrel to export only the public
surface. Verify the public API of `EnrichmentCoordinator` is character-identical
to the pre-refactor signatures (line-counted).

**Beads:**

```bash
bd dolt pull
bd create \
  --title="Coordinator finalization + barrel cleanup + public API parity check" \
  --description="Plumb unenrichedChunks via callback param on CompletionRunner.run. Delete ProviderState, createProviderState, deprecated providerKey getter. Update enrichment/index.ts barrel: exports only EnrichmentCoordinator + public DTOs (FileEnrichmentMarker, ChunkEnrichmentMarker etc). Run a public-API-parity grep against the pre-refactor coordinator to confirm 9 public signatures unchanged. Update coordinator.test.ts assertions only where unenriched-count plumbing was missing in Task 7." \
  --type=task \
  --priority=2
# Capture as $T8
bd label add $T8 architecture
bd dep add $T8 $EPIC
bd dep add $T8 $T7
```

**Files:**

- Modify: `src/core/domains/ingest/pipeline/enrichment/completion-runner.ts` (+
  `unenrichedReader` callback param)
- Modify: `src/core/domains/ingest/pipeline/enrichment/coordinator.ts` (final
  cleanup)
- Modify: `src/core/domains/ingest/pipeline/enrichment/index.ts` (barrel)
- Modify: `tests/core/domains/ingest/pipeline/enrichment/coordinator.test.ts`
  (verify unenriched count plumbing)
- Modify:
  `tests/core/domains/ingest/pipeline/enrichment/completion-runner.test.ts`
  (cover the callback path)

---

- [ ] **Step 1: Mark task in progress**

```bash
bd update $T8 --status=in_progress
```

- [ ] **Step 2: Add `unenrichedReader` callback to CompletionRunner.run**

In `completion-runner.ts`, change the signature:

```typescript
  async run(
    coll: string,
    contexts: ReadonlyMap<string, ProviderContext>,
    startTime: number,
    unenrichedReader?: (providerKey: string, level: "file" | "chunk") => Promise<number>,
  ): Promise<EnrichmentMetrics> {
```

Replace the two `const fileUnenriched = 0;` / `const chunkUnenriched = 0;` lines
with:

```typescript
      const fileUnenriched = unenrichedReader
        ? await unenrichedReader(ctx.key, "file").catch(() => 0)
        : 0;
      ...
      const chunkUnenriched = unenrichedReader
        ? await unenrichedReader(ctx.key, "chunk").catch(() => 0)
        : 0;
```

- [ ] **Step 3: Wire the callback in Coordinator**

In `coordinator.ts`, update `awaitCompletion`:

```typescript
  async awaitCompletion(collectionName: string): Promise<EnrichmentMetrics> {
    if (this.contexts.size === 0) return EMPTY_METRICS;
    const reader = this.recovery
      ? (key: string, level: "file" | "chunk") => this.recovery!.countUnenriched(collectionName, key, level)
      : undefined;
    return this.completion.run(collectionName, this.contexts, this.startTime, reader);
  }
```

- [ ] **Step 4: Add a unit test for the callback path**

In `tests/core/domains/ingest/pipeline/enrichment/completion-runner.test.ts`,
append:

```typescript
it("uses unenrichedReader for file/chunk counts when provided", async () => {
  // construct components as in the previous test
  // ...
  const reader = vi.fn(async (_key: string, level: "file" | "chunk") =>
    level === "file" ? 0 : 5,
  );
  const m = await runner.run("coll", contexts, Date.now(), reader);
  expect(reader).toHaveBeenCalledTimes(2 * contexts.size);
  const final = (await marker.read("coll"))!.git as any;
  expect(final.chunk.status).toBe("degraded");
  expect(final.chunk.unenrichedChunks).toBe(5);
});
```

- [ ] **Step 5: Final coordinator cleanup**

In `coordinator.ts`:

1. Delete `interface ProviderState` (no fields are read from it any more).
2. Delete `function createProviderState`.
3. Delete the deprecated `get providerKey()` getter (still in API per spec? —
   verify spec lists `providerKeys` not `providerKey`. The deprecated single-key
   getter is removed.)

   ⚠ **Public API check**: confirm with `grep -r "\.providerKey[^s]" src tests`
   that nothing reads the singular getter. If anything does, replace with
   `.providerKeys[0] ?? ""`.

4. Delete the `Map<string, ProviderState>` field; iterate `this.contexts`
   instead wherever the file previously did
   `for (const state of this.states.values())`. The remaining loops should
   already use `this.contexts.values()` after Task 6. Remove the `this.states`
   field.
5. Verify the final file is in the 150-220 line range (target ~180).

- [ ] **Step 6: Update `enrichment/index.ts` barrel**

Replace `enrichment/index.ts` with the minimal public surface. Read the current
content first; the new content should look like:

```typescript
export { EnrichmentCoordinator } from "./coordinator.js";
export { EnrichmentApplier } from "./applier.js";
export { EnrichmentRecovery } from "./recovery.js";
export type {
  ChunkEnrichmentMarker,
  EnrichmentProviderHealth,
  FileEnrichmentMarker,
  ProviderContext,
} from "./types.js";
// health-mapper is consumed by IngestFacade at the public DTO boundary
export { mapLevelHealth } from "./health-mapper.js";
```

Internals (MarkerStore, FilePhase, ChunkPhase, Backfiller, CompletionRunner) are
NOT exported — they are private to the enrichment module.

- [ ] **Step 7: Public API parity check**

Run a quick grep to confirm the 9 public signatures of `EnrichmentCoordinator`
are present and correct:

```bash
grep -nE "^( )+(constructor|prefetch|onChunksStored|startChunkEnrichment|runRecovery|awaitCompletion|providerKeys|onChunkEnrichmentComplete)" \
  src/core/domains/ingest/pipeline/enrichment/coordinator.ts
```

Expected: 8 lines (constructor + 7 methods/getters). Compare against
`git show 1e6b6e95~:src/core/domains/ingest/pipeline/enrichment/coordinator.ts`
— same names, same arities. (`providerKey` deprecated getter is intentionally
gone.)

- [ ] **Step 8: Update existing `coordinator.test.ts` for unenriched count**

Find the assertions in
`tests/core/domains/ingest/pipeline/enrichment/coordinator.test.ts` that read
`marker.git.file.unenrichedChunks` / `marker.git.chunk.unenrichedChunks`. After
Task 7 the values were temporarily 0; after this Task they reflect the recovery
callback again. If the existing tests passed at Task 7, no edit is needed; if
they failed at Task 7 with `unenrichedChunks: 0`, they should now pass again.
Run them and verify.

```bash
npx vitest run tests/core/domains/ingest/pipeline/enrichment/coordinator.test.ts
```

Expected: PASS without further edits. Per the test patterns rule, do NOT rewrite
passing tests.

- [ ] **Step 9: Run full vitest + tsc**

```bash
npx vitest run
npx tsc --noEmit
```

Expected: all GREEN.

- [ ] **Step 10: Final commit**

```bash
git add \
  src/core/domains/ingest/pipeline/enrichment/completion-runner.ts \
  src/core/domains/ingest/pipeline/enrichment/coordinator.ts \
  src/core/domains/ingest/pipeline/enrichment/index.ts \
  tests/core/domains/ingest/pipeline/enrichment/completion-runner.test.ts
git commit -m "$(cat <<'EOF'
refactor(enrichment): coordinator finalization + barrel cleanup

Plumb unenriched count via callback param on CompletionRunner.run.
Delete ProviderState, createProviderState, deprecated providerKey
getter. enrichment/index.ts barrel exports only the public surface.
Coordinator settles at ~180 lines of pure wiring; the 9 public
signatures verified character-identical to the pre-refactor commit.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

- [ ] **Step 11: Close beads task and epic**

```bash
bd close $T8
bd close $EPIC
```

---

## Risk Register

| #   | Risk                                                                                                                                                          | Likelihood | Impact   | Mitigation                                                                                                                                                                                                                                          |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------- | -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Hot block in `applier.applyFileSignals` (lines 85-228, bugFixRate 58) gets accidentally edited beyond the field rename in Task 2, breaking enrichment writes. | Medium     | Critical | Task 2 explicitly enumerates the only 2 lines to change in the hot block (the `_missedFileChunks` rename). Reviewer must `git diff applier.ts` and confirm body of `applyFileSignals` is otherwise identical.                                       |
| 2   | `recovery.scrollUnenriched` (bugFixRate 70) is touched while adding `recoverAll` in Task 3.                                                                   | Low        | Critical | `recoverAll` is appended at the bottom of `recovery.ts`. Reviewer confirms `git diff recovery.ts` shows only an addition, no edits to existing methods.                                                                                             |
| 3   | Task 6 (FilePhase split) deletes `ProviderState` fields the existing `coordinator.test.ts` reads via reflection.                                              | Medium     | High     | The integration test reads only the public API (per design). Run `coordinator.test.ts` after Task 6 specifically; if it breaks, the failing assertion points at a hidden private-state read, fix by exposing a narrow getter on the relevant phase. |
| 4   | Race-guard regression: Task 3 changes how `runId` is read (now via `markerStore.getRunId` instead of `readRunId(marker, providerKey)`).                       | Medium     | High     | Task 3 adds a dedicated race-guard test that flips the runId mid-recovery. CI must run this test on every Task ≥3 commit (it lives in `recovery.test.ts` and runs in the default suite).                                                            |
| 5   | Plumbing gap in Task 7: `unenrichedChunks` reports 0 between Tasks 7 and 8; consumers reading the marker may see "completed" instead of "degraded".           | Medium     | Medium   | Task 7 commit message and Task 8 description note the gap. Tasks 7 and 8 SHOULD land in the same PR / same merge window. If split, document a window where the marker may misreport degraded as completed.                                          |
| 6   | Public API drift through any of the 8 Tasks.                                                                                                                  | Low        | High     | Task 8 step 7 runs an explicit grep parity check against `git show 1e6b6e95~:coordinator.ts`. Any earlier Task that breaks the public API must be reverted or fixed before its own commit.                                                          |

---

## Self-Review Notes

- Spec coverage: every Task in the spec's "Migration Plan" (8 steps) maps 1:1 to
  a Task above. ✓
- Out-of-scope items (`applyFileSignals` body, `scrollUnenriched`,
  `health-mapper`, `EnrichmentProvider`) are explicitly named in Risks 1-2. ✓
- TDD: Tasks 1, 2, 3, 5, 6, 7, 8 all have RED→GREEN→REFACTOR breakdown with
  actual test code. Task 4 is a pure type-introduction task and relies on the
  existing suite as its REFACTOR phase. ✓
- Type consistency: `ProviderContext` defined in Task 4, used in Tasks 5-8 with
  the same shape. `BackfillerProviderContext` in Task 2 explicitly noted as
  transitional. `FileFinalInput`, `ChunkFinalInput`, `RecoveryResultInput`
  defined once in Task 1. ✓
- Beads sync: every Task has `bd create` + label + dep. Epic created at the top.
  ✓
- Public API: enumerated in spec. Task 8 has a parity grep step. ✓

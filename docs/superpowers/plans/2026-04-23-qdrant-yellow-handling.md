# Qdrant Yellow-Status Handling Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `dinopowers:executing-plans`
> (NOT `superpowers:executing-plans`) to implement this plan task-by-task. Steps
> use checkbox (`- [ ]`) syntax for tracking. Per chaining rule, every wrapped
> skill call must use the `dinopowers:` form.

**Goal:** Teach the tea-rags MCP server to handle Qdrant background optimization
(`status=yellow`) gracefully — cheap metadata-based counts, a typed
`QdrantOptimizationInProgressError`, exposed health fields in DTOs, a payload
index migration for `is_empty` filters, and an eval-driven update of the
`/tea-rags:index` skill.

**Architecture:** Foundation-layer adapter translates yellow into a typed error
(fail-fast, no retry). Domain code switches from exact `countPoints` to cheap
`getCollectionInfo().pointsCount` where exact is not required. A schema v12
migration adds payload indexes on enrichment `enrichedAt` fields so the
remaining filtered counts stay fast. The `/tea-rags:index` skill is taught about
the new signals via eval-driven iteration.

**Tech Stack:** TypeScript, @qdrant/js-client-rest, Vitest, project's InfraError
hierarchy, existing `SchemaMigrator` framework (v4–v11 in place).

**Spec:** `docs/superpowers/specs/2026-04-23-qdrant-yellow-handling-design.md`

---

## File Structure

New files:

- `src/core/infra/migration/schema_migrations/schema-v12-enrichment-payload-indexes.ts`
  — schema v12 migration
- `tests/core/infra/migration/schema_migrations/schema-v12-enrichment-payload-indexes.test.ts`
  — migration unit tests

Modified files (grouped by Task for atomic commits):

| File                                                  | Tasks touching it                                | Why                                                                        |
| ----------------------------------------------------- | ------------------------------------------------ | -------------------------------------------------------------------------- |
| `src/core/adapters/qdrant/errors.ts`                  | 1.1                                              | New `QdrantOptimizationInProgressError` class                              |
| `src/core/adapters/qdrant/client.ts`                  | 1.2 (getCollectionInfo), 1.5 (countPoints probe) | Hot file (26 commits / 16d) — split into two Tasks per impact directive    |
| `src/core/api/public/dto/collection.ts`               | 1.3                                              | Extend `CollectionInfo` with `status`, `optimizerStatus`                   |
| `src/core/api/public/dto/ingest.ts`                   | 1.4                                              | Extend `IndexStatus` with Qdrant health fields for `/tea-rags:index` skill |
| `src/core/domains/ingest/pipeline/status-module.ts`   | 1.4                                              | Populate new `IndexStatus` fields from `getCollectionInfo`                 |
| `src/core/domains/ingest/sync/deletion-strategy.ts`   | 1.6                                              | Switch `countPoints` → `getCollectionInfo().pointsCount` at lines 31, 115  |
| `src/core/infra/migration/schema-migrator.ts`         | 2.2                                              | Register `SchemaV12EnrichmentPayloadIndexes`                               |
| `src/core/infra/migration/schema_migrations/index.ts` | 2.2                                              | Barrel export                                                              |
| `tests/core/infra/migration/schema-migrator.test.ts`  | 2.3                                              | Update migration count assertions (7→8 / 8→9)                              |
| Tests alongside each source change                    | 1.1, 1.2, 1.4, 1.5, 1.6                          | TDD — red-green-refactor per project rule                                  |

No changes to `src/mcp/tools/collection.ts`: the existing `get_collection_info`
tool calls `app.getCollectionInfo(name)` and returns `info` verbatim via
`formatMcpResponse`. New fields propagate automatically once `CollectionInfo`
DTO is extended.

---

## Section 1 — Adapter + errors + DTO

### Task 1.1: Add `QdrantOptimizationInProgressError`

**Files:**

- Modify: `src/core/adapters/qdrant/errors.ts`
- Test: `tests/core/adapters/qdrant/errors.test.ts` (create if missing)

**Impact signal:** `errors.ts` is a 100%-owner silo — comprehensive tests
substitute for pair-review.

- [ ] **Step 1: Write the failing test**

Create or extend `tests/core/adapters/qdrant/errors.test.ts`:

```ts
import { describe, expect, it } from "vitest";

import { InfraError } from "../../../../src/core/adapters/errors.js";
import {
  QdrantOperationError,
  QdrantOptimizationInProgressError,
  QdrantUnavailableError,
} from "../../../../src/core/adapters/qdrant/errors.js";

describe("QdrantOptimizationInProgressError", () => {
  it("sets the correct code, httpStatus, and hint", () => {
    const err = new QdrantOptimizationInProgressError("code_abc");

    expect(err).toBeInstanceOf(InfraError);
    expect(err.code).toBe("INFRA_QDRANT_OPTIMIZATION_IN_PROGRESS");
    expect(err.httpStatus).toBe(503);
    expect(err.hint).toContain("optimization");
    expect(err.hint).toContain("force-reindex");
  });

  it("includes the collection name in the message", () => {
    const err = new QdrantOptimizationInProgressError("code_abc");
    expect(err.message).toContain("code_abc");
  });

  it("preserves the underlying cause", () => {
    const root = new Error("aborted");
    const err = new QdrantOptimizationInProgressError("code_abc", root);
    expect(err.cause).toBe(root);
  });

  it("is distinguishable from QdrantOperationError and QdrantUnavailableError", () => {
    const err = new QdrantOptimizationInProgressError("code_abc");
    expect(err).not.toBeInstanceOf(QdrantOperationError);
    expect(err).not.toBeInstanceOf(QdrantUnavailableError);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/core/adapters/qdrant/errors.test.ts`

Expected: FAIL — `QdrantOptimizationInProgressError is not exported`.

- [ ] **Step 3: Add the class to `src/core/adapters/qdrant/errors.ts`**

Append after `CollectionAlreadyExistsError` (end of file):

```ts
export class QdrantOptimizationInProgressError extends InfraError {
  constructor(collectionName: string, cause?: Error) {
    super({
      code: "INFRA_QDRANT_OPTIMIZATION_IN_PROGRESS",
      message: `Qdrant collection "${collectionName}" is optimizing`,
      hint:
        `Collection is under background optimization (status=yellow). ` +
        `Wait 1-5 minutes and retry, or run /tea-rags:force-reindex to build ` +
        `a new collection in parallel without waiting.`,
      httpStatus: 503,
      cause,
    });
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/core/adapters/qdrant/errors.test.ts`

Expected: PASS — 4 assertions green.

- [ ] **Step 5: Commit**

```bash
git add src/core/adapters/qdrant/errors.ts tests/core/adapters/qdrant/errors.test.ts
git commit -m "feat(adapters): add QdrantOptimizationInProgressError

Introduce typed error for Qdrant yellow-status (background optimization)
so callers can distinguish between 'server is down' and 'server is busy
optimizing, retry later'. Includes hint pointing to force-reindex as a
parallel workaround."
```

---

### Task 1.2: Extend `getCollectionInfo` with `status` + `optimizerStatus`

**Files:**

- Modify: `src/core/adapters/qdrant/client.ts:265-299` (function
  `getCollectionInfo`)
- Test: `tests/core/adapters/qdrant/client.test.ts:232-399` (existing
  `describe("getCollectionInfo")` block)

**Impact signal:** client.ts is extreme-churn shared file — keep the diff
minimal, only touch the return object of `getCollectionInfo`. Do NOT modify
`countPoints` in this Task (that's Task 1.5).

**Dependency:** Depends on Task 1.3 for the DTO field declaration, but
TypeScript lets us add fields to the returned object and widen the DTO
non-breakingly. Implement 1.2 first; 1.3 adds the matching DTO typing.

- [ ] **Step 1: Write the failing test**

Add a new test case inside `describe("getCollectionInfo", () => { ... })` in
`tests/core/adapters/qdrant/client.test.ts`:

```ts
it("returns status and optimizerStatus from Qdrant metadata", async () => {
  mockClient.getCollection.mockResolvedValue({
    collection_name: "yellow-col",
    points_count: 100,
    status: "yellow",
    optimizer_status: "ok",
    config: {
      params: {
        vectors: { size: 384, distance: "Cosine" },
      },
    },
  });

  const info = await manager.getCollectionInfo("yellow-col");

  expect(info.status).toBe("yellow");
  expect(info.optimizerStatus).toBe("ok");
});

it("defaults optimizerStatus to 'unknown' when Qdrant omits it", async () => {
  mockClient.getCollection.mockResolvedValue({
    collection_name: "minimal",
    points_count: 0,
    status: "green",
    config: { params: { vectors: { size: 384, distance: "Cosine" } } },
  });

  const info = await manager.getCollectionInfo("minimal");

  expect(info.status).toBe("green");
  expect(info.optimizerStatus).toBe("unknown");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run:
`npx vitest run tests/core/adapters/qdrant/client.test.ts -t "getCollectionInfo"`

Expected: FAIL — `info.status` is `undefined`, `info.optimizerStatus` is
`undefined`.

- [ ] **Step 3: Extend the return object in `client.ts:292-298`**

Replace the existing `return { ... }` inside `getCollectionInfo`:

```ts
return {
  name,
  vectorSize: size,
  pointsCount: info.points_count || 0,
  distance,
  hybridEnabled,
  status: (info.status ?? "green") as "green" | "yellow" | "red",
  optimizerStatus:
    typeof info.optimizer_status === "string"
      ? info.optimizer_status
      : "unknown",
};
```

Note: `optimizer_status` from Qdrant can be either `"ok"` (string) or an error
object; we coerce the error-object case to `"unknown"` for a stable type.
Detailed error reporting is out of scope.

- [ ] **Step 4: Run full `getCollectionInfo` suite to verify nothing regressed**

Run:
`npx vitest run tests/core/adapters/qdrant/client.test.ts -t "getCollectionInfo"`

Expected: PASS — all existing cases plus two new ones. Existing cases pass
because the new fields default to `"green"` / `"unknown"` when mocks don't
supply them.

Note: existing `toEqual({ ... })` assertions (e.g. at line 249-256) will fail
because the returned object now has extra keys. Update them by adding
`status: "green", optimizerStatus: "unknown"` to each `toEqual({...})` in the
`getCollectionInfo` describe block.

- [ ] **Step 5: Commit**

```bash
git add src/core/adapters/qdrant/client.ts tests/core/adapters/qdrant/client.test.ts
git commit -m "feat(adapters): expose Qdrant status and optimizerStatus in getCollectionInfo

Propagate 'status' (green/yellow/red) and 'optimizer_status' fields from
the Qdrant collection metadata response. Both are already returned by
GET /collections/{name} at ~10ms latency even during yellow phases, so no
new HTTP cost. Enables downstream code to observe collection health."
```

---

### Task 1.3: Extend `CollectionInfo` DTO

**Files:**

- Modify: `src/core/api/public/dto/collection.ts`

**Impact signal:** Small file (357 bytes), not in hot-file list — safe, fast
change.

- [ ] **Step 1: Inspect existing DTO**

Open `src/core/api/public/dto/collection.ts`. Confirm it matches the shape we
saw:

```ts
export interface CollectionInfo {
  name: string;
  vectorSize: number;
  pointsCount: number;
  distance: "Cosine" | "Euclid" | "Dot";
  hybridEnabled?: boolean;
}
```

- [ ] **Step 2: Extend the interface**

Replace the `CollectionInfo` block with:

```ts
export interface CollectionInfo {
  name: string;
  vectorSize: number;
  pointsCount: number;
  distance: "Cosine" | "Euclid" | "Dot";
  hybridEnabled?: boolean;
  /** Qdrant collection health status. `yellow` indicates background optimization. */
  status: "green" | "yellow" | "red";
  /** Optimizer state string from Qdrant (`"ok"` or `"unknown"` when absent). */
  optimizerStatus: string;
}
```

- [ ] **Step 3: Run type-check to ensure no callers break**

Run: `npx tsc --noEmit`

Expected: PASS. All existing callers of `CollectionInfo` now see the new
required fields; the implementation in `QdrantManager.getCollectionInfo` (Task
1.2) already populates them. If any consumer asserts object shape (e.g. via
`satisfies`), fix per compiler output.

- [ ] **Step 4: Commit**

```bash
git add src/core/api/public/dto/collection.ts
git commit -m "feat(contracts): add status and optimizerStatus to CollectionInfo DTO

Surface Qdrant collection health through the public DTO so MCP tools and
domain code can observe yellow/red states. Fields are mandatory because
getCollectionInfo always returns them after the adapter change."
```

---

### Task 1.4: Surface Qdrant health in `IndexStatus.infraHealth`

**Files:**

- Modify: `src/core/api/public/dto/ingest.ts:89-93` (interface
  `IndexStatus.infraHealth`)
- Modify: `src/core/api/internal/ops/indexing-ops.ts:118-139` (function
  `getStatus` where `infraHealth` is assembled)
- Modify: `src/mcp/tools/code.ts:289-298` (`formatInfraHealth` — surface yellow
  in human-readable output)
- Test: `tests/core/api/ingest-facade.test.ts:126-134` (existing
  `delegates getIndexStatus with infraHealth` test)

**Why this Task exists:** the `/tea-rags:index` skill consumes
`get_index_status`, not `get_collection_info`. Without propagating Qdrant health
into `IndexStatus.infraHealth`, Section 3 has nothing to observe.

**Dependency:** Task 1.2 (`getCollectionInfo` returns `status` and
`optimizerStatus`).

**Note on location:** `infraHealth` is NOT assembled in `status-module.ts`. It's
assembled in `IndexingOps.getStatus()` in `indexing-ops.ts:118-139`. The
existing code already calls `qdrant.checkHealth()`; we'll add a second cheap
`getCollectionInfo` call when Qdrant is healthy, guarded by `collectionExists`.

- [ ] **Step 1: Extend the DTO**

In `src/core/api/public/dto/ingest.ts`, replace the `infraHealth` property
inside the `IndexStatus` interface (currently lines 89-93):

```ts
  /** Infrastructure health status (Qdrant + embedding provider) */
  infraHealth?: {
    qdrant: {
      available: boolean;
      url: string;
      /** Qdrant collection health. `yellow` = background optimization running. */
      status?: "green" | "yellow" | "red";
      /** Optimizer state (`"ok"` or `"unknown"`). */
      optimizerStatus?: string;
    };
    embedding: { available: boolean; provider: string; url?: string };
  };
```

Both new fields are optional because Qdrant may be unreachable or the collection
may not exist yet.

Also update the duplicate definition in `src/core/types.ts:162` to match (the
same `infraHealth` shape appears there — grep confirmed). Change it in lockstep.

- [ ] **Step 2: Update the existing `ingest-facade.test.ts:126-134` test to
      expect new fields on yellow**

Replace the test at line 126:

```ts
it("delegates getIndexStatus with infraHealth including Qdrant collection status", async () => {
  const { facade } = makeFacade();
  const status = await facade.getIndexStatus("/tmp/test-project");
  expect(status).toMatchObject({ indexed: true });
  expect(status.infraHealth).toEqual({
    qdrant: {
      available: true,
      url: "http://localhost:6333",
      status: "green",
      optimizerStatus: "ok",
    },
    embedding: { available: true, provider: "mock" },
  });
});
```

This assumes the existing `makeFacade()` mock returns a green collection. If the
mock factory needs updating to supply the new fields on `getCollectionInfo`, do
that — locate the mock and add `status: "green", optimizerStatus: "ok"` to the
`getCollectionInfo` mock return. Grep for `getCollectionInfo` in
`tests/core/api/ingest-facade.test.ts` and in adjacent `__helpers__` to find
where to add them.

Also add a new test case for yellow, directly after:

```ts
it("surfaces yellow collection status through infraHealth.qdrant", async () => {
  const { facade, mockQdrant } = makeFacade();
  // Override the getCollectionInfo mock to return yellow.
  // Exact override syntax depends on how makeFacade exposes the mock;
  // inspect makeFacade's return shape before wiring. The assertion is
  // the contract; the mock wiring is an implementation detail.
  mockQdrant.getCollectionInfo = vi.fn().mockResolvedValue({
    name: "test_col",
    vectorSize: 384,
    pointsCount: 100,
    distance: "Cosine",
    hybridEnabled: false,
    status: "yellow",
    optimizerStatus: "ok",
  });

  const status = await facade.getIndexStatus("/tmp/test-project");
  expect(status.infraHealth?.qdrant.status).toBe("yellow");
  expect(status.infraHealth?.qdrant.optimizerStatus).toBe("ok");
});
```

If `makeFacade()` does NOT expose the qdrant mock: first refactor `makeFacade()`
to return it (additive, backward-compatible), then write this test. Do this as a
separate Step 2a commit if needed.

- [ ] **Step 3: Run tests to verify they fail**

Run: `npx vitest run tests/core/api/ingest-facade.test.ts -t "infraHealth"`

Expected: FAIL — `status` and `optimizerStatus` are `undefined` under
`infraHealth.qdrant`.

- [ ] **Step 4: Extend `IndexingOps.getStatus` in `indexing-ops.ts:118-139`**

Replace the body of `getStatus` (lines 118-139):

```ts
  /** Indexing status with infrastructure health checks. */
  async getStatus(path: string): Promise<IndexStatus> {
    const [qdrantHealthy, embeddingHealthy] = await Promise.all([
      this.qdrant.checkHealth(),
      this.embeddings.checkHealth(),
    ]);

    const infraHealth: IndexStatus["infraHealth"] = {
      qdrant: { available: qdrantHealthy, url: this.qdrant.url },
      embedding: {
        available: embeddingHealthy,
        provider: this.embeddings.getProviderName(),
        ...(this.embeddings.getBaseUrl ? { url: this.embeddings.getBaseUrl() } : {}),
      },
    };

    if (qdrantHealthy) {
      try {
        const absolutePath = await validatePath(path);
        const collectionName = resolveCollectionName(absolutePath);
        if (await this.qdrant.collectionExists(collectionName)) {
          const info = await this.qdrant.getCollectionInfo(collectionName);
          infraHealth.qdrant.status = info.status;
          infraHealth.qdrant.optimizerStatus = info.optimizerStatus;
        }
      } catch {
        // Non-fatal: status/optimizerStatus stay undefined; available flag is already set.
      }
    }

    if (!qdrantHealthy) {
      return { isIndexed: false, status: "unavailable", infraHealth };
    }

    const status = await this.status.getIndexStatus(path);
    return { ...status, infraHealth };
  }
```

Imports to add at top of file (if missing):

```ts
import {
  resolveCollectionName,
  validatePath,
} from "../../../infra/collection-name.js";
```

Grep to confirm the correct relative path — `indexing-ops.ts` already imports
from `../../../infra/...` for similar utilities.

- [ ] **Step 5: Update `formatInfraHealth` in `src/mcp/tools/code.ts:289-298`**

Replace the function body so the human-readable output mentions yellow:

```ts
function formatInfraHealth(h: NonNullable<IndexStatus["infraHealth"]>): string {
  const qdrantStatus = h.qdrant.available ? "available" : "unavailable";
  const embeddingStatus = h.embedding.available ? "available" : "unavailable";
  const embeddingUrl = h.embedding.url ? ` (${h.embedding.url})` : "";
  const collectionHealth =
    h.qdrant.status && h.qdrant.status !== "green"
      ? ` [collection status: ${h.qdrant.status}${
          h.qdrant.optimizerStatus && h.qdrant.optimizerStatus !== "ok"
            ? `, optimizer: ${h.qdrant.optimizerStatus}`
            : ""
        }]`
      : "";
  return (
    `Infrastructure:\n` +
    `  Qdrant: ${qdrantStatus} (${h.qdrant.url})${collectionHealth}\n` +
    `  Embedding (${h.embedding.provider}): ${embeddingStatus}${embeddingUrl}`
  );
}
```

Green status stays silent (regression guard). Yellow/red append a
`[collection status: ...]` tag.

- [ ] **Step 6: Run tests to verify they pass**

Run: `npx vitest run tests/core/api/ingest-facade.test.ts -t "infraHealth"`

Expected: PASS — both existing (green) and new (yellow) cases pass.

- [ ] **Step 7: Run full test suite**

Run: `npx vitest run`

Expected: PASS — no regressions.

- [ ] **Step 8: Commit**

```bash
git add src/core/api/public/dto/ingest.ts src/core/types.ts src/core/api/internal/ops/indexing-ops.ts src/mcp/tools/code.ts tests/core/api/ingest-facade.test.ts
git commit -m "feat(contracts): surface Qdrant collection status in IndexStatus.infraHealth

IndexingOps.getStatus now queries getCollectionInfo when Qdrant is
reachable and the collection exists, populating status and
optimizerStatus under infraHealth.qdrant. formatInfraHealth appends a
[collection status: ...] tag for non-green states so get_index_status
output is immediately readable. Green path unchanged (regression guard
covered by existing test)."
```

---

### Task 1.5: Add yellow probe to `countPoints` catch block

**Files:**

- Modify: `src/core/adapters/qdrant/client.ts:305-319` (function `countPoints`)
- Test: `tests/core/adapters/qdrant/client.test.ts:2366-2400` (existing
  `describe("countPoints")`)

**Dependencies:** Task 1.1 (error class), Task 1.2 (getCollectionInfo returns
status for the probe to inspect — but we probe via raw `client.getCollection`,
not `getCollectionInfo`, to keep the error-path cheap).

**Impact directive:** Small, surgical change in a 26-commit hot file. Separate
commit from Task 1.2. Tests must cover all three catch paths.

- [ ] **Step 1: Write the failing tests**

Append to `describe("countPoints", ...)` in
`tests/core/adapters/qdrant/client.test.ts`:

```ts
import { QdrantOptimizationInProgressError } from "../../../../src/core/adapters/qdrant/errors.js";

// ... inside describe("countPoints", ...)

it("throws QdrantOptimizationInProgressError when count fails and collection is yellow", async () => {
  const rawError = new Error("This operation was aborted");
  mockClient.count.mockRejectedValueOnce(rawError);
  mockClient.getCollection.mockResolvedValueOnce({
    collection_name: "col",
    status: "yellow",
    optimizer_status: "ok",
    config: { params: { vectors: { size: 384, distance: "Cosine" } } },
    points_count: 100,
  });

  const err = await manager.countPoints("col").catch((e) => e);

  expect(err).toBeInstanceOf(QdrantOptimizationInProgressError);
  expect(err.cause).toBe(rawError);
});

it("falls through to QdrantOperationError when count fails but collection is green", async () => {
  const rawError = Object.assign(new Error("boom"), {
    data: { status: { error: "transient" } },
  });
  mockClient.count.mockRejectedValueOnce(rawError);
  mockClient.getCollection.mockResolvedValueOnce({
    collection_name: "col",
    status: "green",
    optimizer_status: "ok",
    config: { params: { vectors: { size: 384, distance: "Cosine" } } },
    points_count: 100,
  });

  const err = await manager.countPoints("col").catch((e) => e);

  expect(err).toBeInstanceOf(QdrantOperationError);
  expect(err.message).toContain("transient");
});

it("falls through to QdrantOperationError when probe itself fails", async () => {
  const rawError = new Error("aborted");
  mockClient.count.mockRejectedValueOnce(rawError);
  mockClient.getCollection.mockRejectedValueOnce(new Error("probe failed"));

  const err = await manager.countPoints("col").catch((e) => e);

  expect(err).toBeInstanceOf(QdrantOperationError);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/core/adapters/qdrant/client.test.ts -t "countPoints"`

Expected: FAIL — the two new `yellow` / `probe-failed` tests fail because
`countPoints` currently always throws `QdrantOperationError`.

- [ ] **Step 3: Import the new error and extend the catch block in `client.ts`**

At the top of `src/core/adapters/qdrant/client.ts`, add to the existing error
import:

```ts
import {
  // ... existing imports ...
  QdrantOperationError,
  QdrantOptimizationInProgressError,
  QdrantUnavailableError,
} from "./errors.js";
```

Replace `countPoints` (currently lines 305-319) with:

```ts
  async countPoints(collectionName: string, filter?: Record<string, unknown>): Promise<number> {
    try {
      const result = await this.call(async () => this.client.count(collectionName, { filter, exact: true }));
      return result.count;
    } catch (error: unknown) {
      if (error instanceof QdrantUnavailableError) throw error;

      // Probe: is Qdrant still alive (yellow) or genuinely unreachable?
      try {
        const info = await this.call(async () => this.client.getCollection(collectionName));
        if (info.status === "yellow") {
          throw new QdrantOptimizationInProgressError(
            collectionName,
            error instanceof Error ? error : undefined,
          );
        }
      } catch (probeError) {
        if (probeError instanceof QdrantOptimizationInProgressError) throw probeError;
        // probe failed too → fall through to generic QdrantOperationError below
      }

      const errorData = error as { data?: { status?: { error?: string } }; message?: string };
      const errorMessage = errorData?.data?.status?.error || errorData?.message || String(error);
      throw new QdrantOperationError(
        "countPoints",
        `collection "${collectionName}": ${errorMessage}`,
        error instanceof Error ? error : undefined,
      );
    }
  }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/core/adapters/qdrant/client.test.ts -t "countPoints"`

Expected: PASS — original 3 cases plus new 3 cases all green.

- [ ] **Step 5: Run full adapter suite to verify no regression**

Run: `npx vitest run tests/core/adapters/qdrant/`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/core/adapters/qdrant/client.ts tests/core/adapters/qdrant/client.test.ts
git commit -m "feat(adapters): probe collection status on countPoints failure

When countPoints fails, fetch the collection metadata to check whether
Qdrant is simply in yellow (background optimization) vs genuinely down.
Yellow throws the new typed QdrantOptimizationInProgressError with an
actionable hint; everything else falls through to QdrantOperationError
as before. No retry, no wait — fail-fast so callers can decide UX."
```

---

### Task 1.6: Switch `deletion-strategy.ts` to cheap count

**Files:**

- Modify: `src/core/domains/ingest/sync/deletion-strategy.ts:31, 115`
- Test: `tests/core/domains/ingest/sync/deletion-strategy.test.ts`

**Dependency:** Task 1.2 (getCollectionInfo returns `pointsCount` — already did,
this Task just switches the call).

**Impact signal:** deletion-strategy.ts is low-blast-radius, stable.

- [ ] **Step 1: Inspect current test patterns**

Open `tests/core/domains/ingest/sync/deletion-strategy.test.ts`. Locate any test
that mocks `qdrant.countPoints` — those need to be updated to mock
`qdrant.getCollectionInfo` instead (returning an object with `pointsCount`).

- [ ] **Step 2: Update the tests first (TDD: expect the new method signature)**

Wherever the existing test does:

```ts
qdrant.countPoints = vi.fn().mockResolvedValueOnce(10).mockResolvedValueOnce(7);
```

Change to:

```ts
qdrant.getCollectionInfo = vi
  .fn()
  .mockResolvedValueOnce({
    name: "c",
    vectorSize: 384,
    pointsCount: 10,
    distance: "Cosine",
    status: "green",
    optimizerStatus: "ok",
  })
  .mockResolvedValueOnce({
    name: "c",
    vectorSize: 384,
    pointsCount: 7,
    distance: "Cosine",
    status: "green",
    optimizerStatus: "ok",
  });
```

Keep behavioral assertions unchanged — `performDeletion` should still return
`totalBefore - totalAfter = 3`.

- [ ] **Step 3: Run tests to verify they fail**

Run: `npx vitest run tests/core/domains/ingest/sync/deletion-strategy.test.ts`

Expected: FAIL — current `performDeletion` still calls `countPoints`, not
`getCollectionInfo`.

- [ ] **Step 4: Update `deletion-strategy.ts`**

Line 31, change:

```ts
const totalBefore = await qdrant.countPoints(collectionName);
```

to:

```ts
const totalBefore = (await qdrant.getCollectionInfo(collectionName))
  .pointsCount;
```

Line 115, change:

```ts
const totalAfter = await qdrant.countPoints(collectionName);
```

to:

```ts
const totalAfter = (await qdrant.getCollectionInfo(collectionName)).pointsCount;
```

No other changes. The return value `Math.max(0, totalBefore - totalAfter)` stays
the same.

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run tests/core/domains/ingest/sync/deletion-strategy.test.ts`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/core/domains/ingest/sync/deletion-strategy.ts tests/core/domains/ingest/sync/deletion-strategy.test.ts
git commit -m "feat(ingest): use cached pointsCount for deletion delta reporting

totalBefore - totalAfter does not need point-exact accuracy. Switching
to getCollectionInfo().pointsCount drops the 60s exact-count HTTP call
on the deletion hot path, so deletion keeps working during Qdrant
yellow phases without timing out."
```

---

## Section 2 — Schema v12 migration

### Task 2.1: Create `SchemaV12EnrichmentPayloadIndexes`

**Files:**

- Create:
  `src/core/infra/migration/schema_migrations/schema-v12-enrichment-payload-indexes.ts`
- Create:
  `tests/core/infra/migration/schema_migrations/schema-v12-enrichment-payload-indexes.test.ts`

**Reference pattern:**
`src/core/infra/migration/schema_migrations/schema-v6-filter-field-indexes.ts` —
the closest precedent (multiple `ensureIndex` calls, no conditional logic).

**Decision from spec D1:** hardcoded field list. If a future `static` provider
needs its own `enrichedAt` indexes, it will ship v13.

- [ ] **Step 1: Write the failing test**

Create
`tests/core/infra/migration/schema_migrations/schema-v12-enrichment-payload-indexes.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest";

import { SchemaV12EnrichmentPayloadIndexes } from "../../../../../src/core/infra/migration/schema_migrations/schema-v12-enrichment-payload-indexes.js";
import type { IndexStore } from "../../../../../src/core/infra/migration/types.js";

function createMockStore(): IndexStore {
  return {
    getSchemaVersion: vi.fn().mockResolvedValue(0),
    ensureIndex: vi.fn().mockResolvedValue(true),
    storeSchemaVersion: vi.fn().mockResolvedValue(undefined),
    hasPayloadIndex: vi.fn().mockResolvedValue(false),
    getCollectionInfo: vi
      .fn()
      .mockResolvedValue({ hybridEnabled: false, vectorSize: 384 }),
    updateSparseConfig: vi.fn().mockResolvedValue(undefined),
    deletePointsByFilter: vi.fn().mockResolvedValue(undefined),
    scrollAllPayload: vi.fn().mockResolvedValue([]),
    batchSetPayload: vi.fn().mockResolvedValue(undefined),
    deletePayloadKeys: vi.fn().mockResolvedValue(undefined),
  };
}

describe("SchemaV12EnrichmentPayloadIndexes", () => {
  const COLLECTION = "test_col";

  it("declares version 12 and a matching name", () => {
    const store = createMockStore();
    const migration = new SchemaV12EnrichmentPayloadIndexes(COLLECTION, store);
    expect(migration.version).toBe(12);
    expect(migration.name).toBe("schema-v12-enrichment-payload-indexes");
  });

  it("ensures datetime indexes on git.file.enrichedAt and git.chunk.enrichedAt", async () => {
    const store = createMockStore();
    const migration = new SchemaV12EnrichmentPayloadIndexes(COLLECTION, store);

    const result = await migration.apply();

    expect(store.ensureIndex).toHaveBeenCalledWith(
      COLLECTION,
      "git.file.enrichedAt",
      "datetime",
    );
    expect(store.ensureIndex).toHaveBeenCalledWith(
      COLLECTION,
      "git.chunk.enrichedAt",
      "datetime",
    );
    expect(store.ensureIndex).toHaveBeenCalledTimes(2);

    expect(result.applied).toEqual([
      "git.file.enrichedAt:datetime",
      "git.chunk.enrichedAt:datetime",
    ]);
  });

  it("is idempotent when indexes already exist (ensureIndex returns false)", async () => {
    const store = createMockStore();
    store.ensureIndex = vi.fn().mockResolvedValue(false); // index already existed
    const migration = new SchemaV12EnrichmentPayloadIndexes(COLLECTION, store);

    const result = await migration.apply();

    expect(store.ensureIndex).toHaveBeenCalledTimes(2); // still called, but no-op
    expect(result.applied).toEqual([
      "git.file.enrichedAt:datetime",
      "git.chunk.enrichedAt:datetime",
    ]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run:
`npx vitest run tests/core/infra/migration/schema_migrations/schema-v12-enrichment-payload-indexes.test.ts`

Expected: FAIL — `Cannot find module 'schema-v12-enrichment-payload-indexes'`.

- [ ] **Step 3: Create the migration file**

Create
`src/core/infra/migration/schema_migrations/schema-v12-enrichment-payload-indexes.ts`:

```ts
import type { IndexStore, Migration, StepResult } from "../types.js";

/**
 * Add payload indexes on enrichment `enrichedAt` fields so `is_empty`
 * filters used by EnrichmentRecovery.countUnenriched remain fast even
 * when Qdrant is in yellow (background optimization) state.
 *
 * Fields are hardcoded to current providers at the time this migration
 * was authored. Additional providers ship their own follow-up
 * migrations — see docs/superpowers/specs/2026-04-23-qdrant-yellow-handling-design.md.
 */
export class SchemaV12EnrichmentPayloadIndexes implements Migration {
  readonly name = "schema-v12-enrichment-payload-indexes";
  readonly version = 12;

  constructor(
    private readonly collection: string,
    private readonly store: IndexStore,
  ) {}

  async apply(): Promise<StepResult> {
    await this.store.ensureIndex(
      this.collection,
      "git.file.enrichedAt",
      "datetime",
    );
    await this.store.ensureIndex(
      this.collection,
      "git.chunk.enrichedAt",
      "datetime",
    );
    return {
      applied: [
        "git.file.enrichedAt:datetime",
        "git.chunk.enrichedAt:datetime",
      ],
    };
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run:
`npx vitest run tests/core/infra/migration/schema_migrations/schema-v12-enrichment-payload-indexes.test.ts`

Expected: PASS — 3 test cases green.

- [ ] **Step 5: Commit**

```bash
git add src/core/infra/migration/schema_migrations/schema-v12-enrichment-payload-indexes.ts tests/core/infra/migration/schema_migrations/schema-v12-enrichment-payload-indexes.test.ts
git commit -m "feat(pipeline): schema v12 migration adds enrichment payload indexes

Qdrant's is_empty filter on nested datetime fields (used by
EnrichmentRecovery.countUnenriched) needs payload indexes to stay cheap
during yellow phases. Hardcodes git.file.enrichedAt and
git.chunk.enrichedAt per the design decision to snapshot provider state
at migration-author time."
```

---

### Task 2.2: Register `SchemaV12` in migrator + barrel

**Files:**

- Modify: `src/core/infra/migration/schema_migrations/index.ts`
- Modify: `src/core/infra/migration/schema-migrator.ts`

- [ ] **Step 1: Add barrel export**

Append to `src/core/infra/migration/schema_migrations/index.ts`:

```ts
export { SchemaV12EnrichmentPayloadIndexes } from "./schema-v12-enrichment-payload-indexes.js";
```

The file should now list v4 through v12 in order.

- [ ] **Step 2: Register in `SchemaMigrator`**

Open `src/core/infra/migration/schema-migrator.ts`. Extend the import:

```ts
import {
  SchemaV4RelativePathKeyword,
  SchemaV5RelativePathText,
  SchemaV6FilterFieldIndexes,
  SchemaV7SparseConfig,
  SchemaV8SymbolIdText,
  SchemaV9EnrichedAtBackfill,
  SchemaV10PurgeMarkdownChunks,
  SchemaV11RenameParentSymbolId,
  SchemaV12EnrichmentPayloadIndexes,
} from "./schema_migrations/index.js";
```

In the constructor body, append to the `this.migrations` array — after
`SchemaV11RenameParentSymbolId`:

```ts
this.migrations = [
  new SchemaV4RelativePathKeyword(collection, indexStore),
  new SchemaV5RelativePathText(collection, indexStore),
  new SchemaV6FilterFieldIndexes(collection, indexStore),
  new SchemaV7SparseConfig(collection, indexStore, options.enableHybrid),
  new SchemaV8SymbolIdText(collection, indexStore),
  ...(enrichmentStore && options.providerKey
    ? [
        new SchemaV9EnrichedAtBackfill(
          collection,
          enrichmentStore,
          options.providerKey,
        ),
      ]
    : []),
  new SchemaV10PurgeMarkdownChunks(collection, indexStore, snapshotStore),
  new SchemaV11RenameParentSymbolId(
    collection,
    indexStore as IndexStore &
      Required<
        Pick<
          IndexStore,
          "scrollAllPayload" | "batchSetPayload" | "deletePayloadKeys"
        >
      >,
  ),
  new SchemaV12EnrichmentPayloadIndexes(collection, indexStore),
];
```

- [ ] **Step 3: Run type-check**

Run: `npx tsc --noEmit`

Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add src/core/infra/migration/schema_migrations/index.ts src/core/infra/migration/schema-migrator.ts
git commit -m "feat(pipeline): register schema v12 in SchemaMigrator

Adds the new migration to the hardcoded list in SchemaMigrator and the
barrel export. latestVersion automatically becomes 12."
```

---

### Task 2.3: Update migrator integration tests

**Files:**

- Modify: `tests/core/infra/migration/schema-migrator.test.ts`

**Why:** existing assertions hardcode the number of registered migrations ("has
7 schema migrations (v4-v11)"). These need bumping to match v12.

- [ ] **Step 1: Update assertions**

In `tests/core/infra/migration/schema-migrator.test.ts`:

- Find every `expect(migrations).toHaveLength(7)` → change to
  `.toHaveLength(8)`.
- Find every `expect(migrations).toHaveLength(8)` (with-enrichment case) →
  change to `.toHaveLength(9)`.
- Find any test descriptions like `"has 7 schema migrations (v4-v11)"` → rewrite
  to `"has 8 schema migrations (v4-v12)"`.
- Similarly for the v4-v11 range:
  `expect(migrations.filter((m) => m.version >= 4 && m.version <= 11)).toHaveLength(7)`
  →
  `expect(migrations.filter((m) => m.version >= 4 && m.version <= 12)).toHaveLength(8)`.

If there is an ordering or latestVersion assertion:
`expect(migrator.latestVersion).toBe(11)` →
`expect(migrator.latestVersion).toBe(12)`.

- [ ] **Step 2: Run the full migration test suite**

Run: `npx vitest run tests/core/infra/migration/`

Expected: PASS — all updated assertions green, existing v4-v11 tests untouched.

- [ ] **Step 3: Run the entire test suite to catch incidental regressions**

Run: `npx vitest run`

Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add tests/core/infra/migration/schema-migrator.test.ts
git commit -m "test(pipeline): update SchemaMigrator assertions for v12 registration

Bumps expected migration count from 7→8 (no enrichment) and 8→9 (with
enrichment provider), and updates version-range filters to include v12."
```

---

## Section 3 — Skill update via `/optimize-skill` (gated)

### Task 3.0: Gate — verify live MCP exposes new fields

**This is a gate, not a code Task.** Section 3.1 must NOT start before this gate
passes.

- [ ] **Step 1: Build + reconnect the MCP server**

Per `.claude/rules/.local/mcp-testing.md`:

```bash
npm run build && npx vitest run
```

Expected: clean build, all tests pass (Sections 1 and 2 changes).

- [ ] **Step 2: Request user reconnect**

Invoke the `AskUserQuestion` tool:

```
question: "MCP server code was modified (Sections 1 and 2 of the qdrant-yellow-handling plan). Please reconnect the tea-rags MCP server so the new CollectionInfo and IndexStatus fields become observable. Select 'Done' after reconnect."
options:
  - label: "Done",  description: "I've reconnected the MCP server"
  - label: "Skip",  description: "Skip Section 3 (defer skill update)"
```

- [ ] **Step 3: Verify new fields are surfaced**

After user confirms reconnect, call `mcp__tea-rags__get_index_status` on the
current project path. Inspect the response:

- `response.infraHealth.qdrant.status` must be one of `"green"` / `"yellow"` /
  `"red"` (not undefined).
- `response.infraHealth.qdrant.optimizerStatus` must be a string (typically
  `"ok"` or `"unknown"`).

If any field is missing: STOP. The build did not take effect. Re-run
`npm run build`, ask user to reconnect again, retest.

Also call `mcp__tea-rags__get_collection_info` with the current collection name.
Verify:

- `response.status` present.
- `response.optimizerStatus` present.

- [x] **Step 4: Record results in the plan**

Gate passed 2026-04-23. Observed via live MCP on `code_8b243ffe`:

- `get_collection_info`: `status: "green"`, `optimizerStatus: "ok"`
- `get_index_status`: `infraHealth` populated; `formatInfraHealth` suppresses
  collection-health tag on green (regression guard verified).

---

### Task 3.1: Update `/tea-rags:index` skill via `/optimize-skill`

**Files:**

- Modified: `/tea-rags:index` SKILL.md (location resolved by `/optimize-skill`)

**Per project rule "no silent skill patches":** surface the diff of SKILL.md
edits before accepting any changes. Do NOT merge blindly.

**Policy from spec D6:** inform + auto-proceed on yellow.

- [ ] **Step 1: Draft the four eval scenarios**

Write them as a scratch file (not committed) for handoff to `/optimize-skill`:

```
Scenario A: yellow at start
- get_index_status returns {..., infraHealth: {qdrant: {status: "yellow", optimizerStatus: "ok", ...}}}
- Expected: skill emits informational note mentioning both fields ("Qdrant is
  optimizing in background (status=yellow, optimizer_status=ok)"), then
  proceeds with normal incremental reindex branch.

Scenario B: red status
- get_index_status returns {..., infraHealth: {qdrant: {status: "red", optimizerStatus: "ok", ...}}}
- Expected: skill surfaces a blocking message, proposes running
  get_collection_info for diagnostics, does NOT auto-proceed.

Scenario C: new error code during index
- any MCP call throws with code INFRA_QDRANT_OPTIMIZATION_IN_PROGRESS
- Expected: skill parses [CODE], reads Hint from the response, offers three
  user-facing options (wait and retry, /tea-rags:force-reindex, skip).

Scenario D: green path regression
- get_index_status returns {..., infraHealth: {qdrant: {status: "green", ...}}}
- Expected: skill behaves IDENTICALLY to the pre-change version. No extra
  logging, no prompts. This is a regression guard.
```

- [ ] **Step 2: Invoke `/optimize-skill`**

Invoke the `Skill` tool with `optimize-skill`. Pass:

- target skill: `/tea-rags:index`
- eval scenarios: the 4 above
- constraint: "No silent edits — surface each proposed SKILL.md diff for
  explicit user review before accepting. Iterate until 100% pass rate across all
  4 scenarios."

- [ ] **Step 3: Review each SKILL.md diff before acceptance**

`/optimize-skill` will propose edits and re-run evals. For each iteration:

1. Read the proposed diff (sections changed, exact text).
2. Confirm it matches the spec's Section 3.6 scope: only "Check and update
   index" section, error handling block, and optionally a new "Qdrant health
   states" reference table.
3. Reject any diff that touches unrelated sections.

If `/optimize-skill` cannot reach 100% without touching unrelated sections:
escalate — do NOT weaken the evals or let scope creep.

- [ ] **Step 4: Commit the approved SKILL.md change**

Once all 4 scenarios pass:

```bash
# /optimize-skill writes to the plugin cache path; use git status to confirm
git status
# Stage only the SKILL.md and any eval fixtures that live in-repo
git add <paths from git status>
git commit -m "docs(skills): teach /tea-rags:index about Qdrant yellow status

Skill now recognizes status=yellow as a normal operating state (informs +
proceeds), reacts to status=red with diagnostics, and handles the new
INFRA_QDRANT_OPTIMIZATION_IN_PROGRESS error with three user options.
Green path is unchanged — regression guard eval passes.

Edits produced by /optimize-skill after 4-scenario eval convergence."
```

- [ ] **Step 5: Final validation**

Invoke `mcp__tea-rags__get_index_status` once more; the skill's handler should
surface the yellow note if Qdrant is currently yellow, or no extra output if
green. This confirms the skill was actually picked up.

---

## Beads Sync (after Section 1 and 2 plan lands)

Per `.claude/rules/.local/plan-beads-sync.md`, before executing any Task:

- [ ] **Create beads epic and tasks**

```bash
bd dolt pull
bd create --title="Epic: Qdrant yellow-status handling" --description="Handle background optimization gracefully in MCP adapter, add migration for is_empty indexes, update /tea-rags:index skill via /optimize-skill. Spec: docs/superpowers/specs/2026-04-23-qdrant-yellow-handling-design.md" --type=feature --priority=2
# Capture the returned epic id, e.g. EPIC=tea-rags-mcp-xxx

bd create --title="Task 1.1: Add QdrantOptimizationInProgressError" --description="..." --type=feature --priority=2
# Label: api
bd label add <id> api

# Similarly for Tasks 1.2 ... 3.1
# Labels per task:
#   1.1 api
#   1.2, 1.5 api, bugfix
#   1.3, 1.4 api
#   1.6 performance
#   2.1, 2.2, 2.3 architecture, performance
#   3.0 dx
#   3.1 dx
```

- [ ] **Link dependencies** (mirroring plan ordering):

```bash
bd dep add <task1.5> <task1.1>   # 1.5 depends on 1.1
bd dep add <task1.5> <task1.2>   # 1.5 depends on 1.2
bd dep add <task1.6> <task1.2>   # 1.6 depends on 1.2
bd dep add <task2.2> <task2.1>   # 2.2 depends on 2.1
bd dep add <task2.3> <task2.2>   # 2.3 depends on 2.2
bd dep add <task3.0> <task1.6>   # 3.0 gate requires all Section 1
bd dep add <task3.0> <task2.3>   # 3.0 gate requires all Section 2
bd dep add <task3.1> <task3.0>   # 3.1 requires gate

# Link all tasks to epic:
for id in <all task ids>; do bd dep add $id $EPIC; done
```

---

## Session close

Once all Tasks are complete:

- [ ] `git status` — expect a clean tree
- [ ] `bd close <all task ids>` — close beads tasks in a single call
- [ ] `bd close $EPIC`
- [ ] `bd dolt pull && git add -A && git commit -m "chore(beads): close qdrant-yellow-handling epic"`
      (if beads db changed)

Do NOT push — this is an ephemeral branch per the project's git workflow, and
per user preference pushes require explicit request.

---

## Execution choice

**Plan saved to `docs/superpowers/plans/2026-04-23-qdrant-yellow-handling.md`.**

Two execution options:

1. **Subagent-Driven (recommended)** — dispatch a fresh subagent per Task,
   review between Tasks, fast iteration. Uses
   `dinopowers:subagent-driven-development` (wrapper over
   `superpowers:subagent-driven-development`).
2. **Inline Execution** — execute Tasks in this session using
   `dinopowers:executing-plans`, batch execution with checkpoints.

Which approach, O Мудрейший Господин?

# Sparse Vector Migration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use
> superpowers:subagent-driven-development (recommended) or
> superpowers:executing-plans to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** Auto-migrate BM25 sparse vectors when tokenizer changes, and enable
hybrid search on existing non-hybrid collections.

**Architecture:** Two mechanisms: (1) Schema migration v7 adds sparse config to
non-hybrid collections. (2) `checkSparseVectorVersion()` on `SchemaManager`
rebuilds sparse vectors when `CURRENT_SPARSE_VERSION` changes. Both run in
`ReindexPipeline.runMigrations()`.

**Tech Stack:** Qdrant JS client, Node.js, Vitest

**Spec:** `docs/superpowers/specs/2026-03-22-sparse-vector-migration-design.md`

**Worktree:** `.worktrees/sparse-migration` (branch `sparse-vector-migration`)

---

### Task 1: Default `enableHybrid` to `true`

**Files:**

- Modify: `src/bootstrap/config/schemas.ts:62`
- Test: `tests/bootstrap/config.test.ts` (if exists, verify default)

- [ ] **Step 1: Change default**

In `src/bootstrap/config/schemas.ts:62`, change:

```typescript
enableHybrid: booleanFromEnv,
```

to:

```typescript
enableHybrid: booleanFromEnvWithDefault(true),
```

- [ ] **Step 2: Add test asserting new default**

In `tests/bootstrap/ingest-env.test.ts`, add test:

```typescript
it("should default enableHybrid to true when env var is unset", () => {
  // unset INGEST_ENABLE_HYBRID, parse config, assert enableHybridSearch=true
});
```

- [ ] **Step 3: Run tests — verify new test passes, no regressions**

```bash
npx vitest run tests/bootstrap/
```

- [ ] **Step 4: Commit**

```bash
git add src/bootstrap/config/schemas.ts tests/bootstrap/ingest-env.test.ts
git commit -m "feat(config): default enableHybrid to true

BREAKING CHANGE: INGEST_ENABLE_HYBRID now defaults to true.
Existing non-hybrid collections auto-migrate on next reindex."
```

---

### Task 2: `QdrantManager` — new methods

**Files:**

- Modify: `src/core/adapters/qdrant/client.ts`
- Test: `tests/core/adapters/qdrant/client.test.ts`

- [ ] **Step 1: Write tests for `updateCollectionSparseConfig()`**

```typescript
describe("updateCollectionSparseConfig", () => {
  it("should call client.updateCollection with sparse_vectors config", async () => {
    mockClient.updateCollection.mockResolvedValue({});
    await manager.updateCollectionSparseConfig("test_collection");
    expect(mockClient.updateCollection).toHaveBeenCalledWith(
      "test_collection",
      {
        sparse_vectors: { text: { modifier: "idf" } },
      },
    );
  });
});
```

- [ ] **Step 2: Write tests for `scrollWithVectors()`**

```typescript
describe("scrollWithVectors", () => {
  it("should yield batches with id, payload, and vectors", async () => {
    mockClient.scroll.mockResolvedValueOnce({
      points: [
        { id: "id1", payload: { content: "hello" }, vector: { dense: [1, 2] } },
        { id: "id2", payload: { content: "world" }, vector: { dense: [3, 4] } },
      ],
      next_page_offset: null,
    });

    const batches: unknown[] = [];
    for await (const batch of manager.scrollWithVectors("test_col", 100)) {
      batches.push(batch);
    }
    expect(batches).toHaveLength(1);
    expect(batches[0]).toHaveLength(2);
  });

  it("should handle pagination", async () => {
    mockClient.scroll
      .mockResolvedValueOnce({
        points: [{ id: "id1", payload: { content: "a" }, vector: [1, 2] }],
        next_page_offset: "offset1",
      })
      .mockResolvedValueOnce({
        points: [{ id: "id2", payload: { content: "b" }, vector: [3, 4] }],
        next_page_offset: null,
      });

    const batches: unknown[] = [];
    for await (const batch of manager.scrollWithVectors("test_col", 1)) {
      batches.push(batch);
    }
    expect(batches).toHaveLength(2);
  });
});
```

- [ ] **Step 3: Run tests — verify FAIL**

```bash
npx vitest run tests/core/adapters/qdrant/client.test.ts
```

- [ ] **Step 4: Implement `updateCollectionSparseConfig()`**

Add to `QdrantManager`:

```typescript
async updateCollectionSparseConfig(collectionName: string): Promise<void> {
  await this.client.updateCollection(collectionName, {
    sparse_vectors: { text: { modifier: "idf" } },
  });
}
```

- [ ] **Step 5: Implement `scrollWithVectors()`**

Add to `QdrantManager`:

```typescript
async *scrollWithVectors(
  collectionName: string,
  batchSize = 100,
): AsyncGenerator<{ id: string | number; payload: Record<string, unknown>; vector: unknown }[]> {
  let offset: string | number | null = null;

  do {
    const result = await this.client.scroll(collectionName, {
      limit: batchSize,
      offset: offset ?? undefined,
      with_payload: true,
      with_vector: true,
    });

    const batch = result.points
      .filter((p) => p.payload && p.vector)
      .map((p) => ({
        id: p.id,
        payload: p.payload as Record<string, unknown>,
        vector: p.vector,
      }));

    if (batch.length > 0) yield batch;
    offset = result.next_page_offset ?? null;
  } while (offset !== null);
}
```

- [ ] **Step 6: Run tests — verify PASS**

- [ ] **Step 7: Commit**

```bash
git add src/core/adapters/qdrant/client.ts tests/core/adapters/qdrant/client.test.ts
git commit -m "feat(qdrant): add updateCollectionSparseConfig() and scrollWithVectors()"
```

---

### Task 3: `SchemaManager` — accept `enableHybrid`, migration v7, `checkSparseVectorVersion()`

**Files:**

- Modify: `src/core/adapters/qdrant/schema-migration.ts`
- Test: `tests/core/adapters/qdrant/schema-migration.test.ts`

- [ ] **Step 1: Write tests**

Test cases:

1. **v7 migration — non-hybrid + enableHybrid=true**: calls
   `updateCollectionSparseConfig`
2. **v7 migration — non-hybrid + enableHybrid=false**: no-op
3. **v7 migration — already hybrid**: no-op
4. **v7 ordering**: `updateCollectionSparseConfig` called before
   `storeSchemaMetadata`
5. **getSchemaVersion fallback**: returns 6 not CURRENT_SCHEMA_VERSION **NOTE:**
   Existing test at ~line 63 asserts
   `expect(version).toBe(CURRENT_SCHEMA_VERSION)` — update to
   `expect(version).toBe(6)` since business logic changed intentionally.
6. **checkSparseVectorVersion — rebuild**: sparseVersion=0, enableHybrid=true →
   rebuilds
7. **checkSparseVectorVersion — skip (disabled)**: enableHybrid=false → skip
8. **checkSparseVectorVersion — skip (current)**: sparseVersion=1 → skip
9. **checkSparseVectorVersion — safety net**: non-hybrid + enableHybrid=true →
   adds sparse config first
10. **rebuildSparseVectors**: scrolls points, generates sparse, upserts with
    dense unchanged
11. **rebuildSparseVectors — skips metadata points**: `__schema_metadata__` and
    indexing marker skipped
12. **rebuildSparseVectors — empty collection**: no points to migrate,
    sparseVersion bumped
13. **rebuildSparseVectors — unnamed→named normalization**: points with unnamed
    vector format (plain `number[]`) correctly upserted with named
    `{dense, text}` format

- [ ] **Step 2: Run tests — verify FAIL**

- [ ] **Step 3: Implement changes to `schema-migration.ts`**

Key changes:

- `CURRENT_SCHEMA_VERSION = 7`
- Add `CURRENT_SPARSE_VERSION = 1`
- Add `sparseVersion?: number` to `SchemaMetadata` interface
- Constructor:
  `constructor(private readonly qdrant: QdrantManager, private readonly enableHybrid = false)`
- `getSchemaVersion()` fallback: return `6` instead of `CURRENT_SCHEMA_VERSION`
- Add migration v7 block in `ensureCurrentSchema()`:
  ```typescript
  if (currentVersion < 7) {
    const info = await this.qdrant.getCollectionInfo(collectionName);
    if (!info.hybridEnabled && this.enableHybrid) {
      await this.qdrant.updateCollectionSparseConfig(collectionName);
      migrationsApplied.push("v7: Enabled sparse vectors on collection");
    }
  }
  ```
- Add `checkSparseVectorVersion(collectionName)`:

  ```typescript
  async checkSparseVectorVersion(collectionName: string): Promise<void> {
    if (!this.enableHybrid) return;

    // Safety net: ensure sparse config exists
    const info = await this.qdrant.getCollectionInfo(collectionName);
    if (!info.hybridEnabled) {
      await this.qdrant.updateCollectionSparseConfig(collectionName);
    }

    const metadata = await this.getSchemaMetadata(collectionName);
    const currentSparseVersion = metadata?.sparseVersion ?? 0;
    if (currentSparseVersion >= CURRENT_SPARSE_VERSION) return;

    await this.rebuildSparseVectors(collectionName);
    await this.updateSparseVersion(collectionName, CURRENT_SPARSE_VERSION);
  }
  ```

- Add `rebuildSparseVectors(collectionName)`: scroll → generateSparseVector →
  upsert
- Add helper `extractDenseVector(vector)`: handles named (`vector.dense`) and
  unnamed (plain array) formats
- Add `updateSparseVersion()`: reads existing metadata, adds sparseVersion,
  upserts

- [ ] **Step 4: Run tests — verify PASS**

- [ ] **Step 5: Commit**

```bash
git add src/core/adapters/qdrant/schema-migration.ts tests/core/adapters/qdrant/schema-migration.test.ts
git commit -m "feat(qdrant): schema v7 + sparse vector auto-migration"
```

---

### Task 4: Thread `enableHybrid` through DI

**Files:**

- Modify: `src/core/domains/ingest/factory.ts:32-52`
- Modify: `src/core/api/internal/facades/ingest-facade.ts:68`

- [ ] **Step 1: Update `createIngestDependencies` signature**

In `factory.ts`, add `enableHybrid` parameter:

```typescript
export function createIngestDependencies(
  qdrant: QdrantManager,
  snapshotDir: string,
  payloadBuilder: PayloadBuilder,
  syncTuning?: SynchronizerTuning,
  enableHybrid = false,
): IngestDependencies {
  return {
    createSchemaManager: () => new SchemaManager(qdrant, enableHybrid),
    // ... rest unchanged
  };
}
```

- [ ] **Step 2: Update `IngestFacade` to pass `enableHybrid`**

In `ingest-facade.ts:68`, change:

```typescript
const deps = createIngestDependencies(
  qdrant,
  resolvedSnapshotDir,
  new StaticPayloadBuilder(),
  syncTuning,
);
```

to:

```typescript
const deps = createIngestDependencies(
  qdrant,
  resolvedSnapshotDir,
  new StaticPayloadBuilder(),
  syncTuning,
  ingestConfig.enableHybridSearch,
);
```

- [ ] **Step 3: Run full test suite**

```bash
npx vitest run
```

- [ ] **Step 4: Commit**

```bash
git add src/core/domains/ingest/factory.ts src/core/api/internal/facades/ingest-facade.ts
git commit -m "improve(ingest): thread enableHybrid through DI to SchemaManager"
```

---

### Task 5: Wire `checkSparseVectorVersion()` into `ReindexPipeline`

**Files:**

- Modify: `src/core/domains/ingest/reindexing.ts:132-142`

- [ ] **Step 1: Add call after schema migration**

In `reindexing.ts`, `runMigrations()` method, after `ensureCurrentSchema`:

```typescript
private async runMigrations(collectionName: string, absolutePath: string): Promise<void> {
  const migrator = this.deps.createMigrator(collectionName, absolutePath);
  await migrator.ensureMigrated();

  const schemaManager = this.deps.createSchemaManager();
  const schemaMigration = await schemaManager.ensureCurrentSchema(collectionName);
  if (schemaMigration.migrationsApplied.length > 0) {
    pipelineLog.reindexPhase("schema_migration", {
      fromVersion: schemaMigration.fromVersion,
      toVersion: schemaMigration.toVersion,
      migrations: schemaMigration.migrationsApplied,
    });
  }

  // Sparse vector data migration (independent of schema version)
  await schemaManager.checkSparseVectorVersion(collectionName);
}
```

- [ ] **Step 2: Run full test suite**

```bash
npx vitest run
```

- [ ] **Step 3: Commit**

```bash
git add src/core/domains/ingest/reindexing.ts
git commit -m "improve(ingest): wire checkSparseVectorVersion() into runMigrations()"
```

---

### Task 6: Build verification + integration test

- [ ] **Step 1: Type-check + tests + build**

```bash
npx tsc --noEmit && npx vitest run && npm run build
```

- [ ] **Step 2: Integration test (after MCP reconnect)**

Reconnect MCP, then:

1. `get_index_status` — verify qdrantUrl present
2. `reindex_changes` on current project — should trigger v7 migration + sparse
   rebuild
3. `hybrid_search` — should return results with improved BM25 scores

- [ ] **Step 3: Final commit if needed**

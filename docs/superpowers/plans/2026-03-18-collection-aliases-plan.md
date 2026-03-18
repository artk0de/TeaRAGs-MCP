# Collection Aliases — Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development
> (if subagents available) or superpowers:executing-plans to implement this
> plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Zero-downtime forceReindex via Qdrant collection aliases — search
stays available while a new version of the collection is built in background.

**Architecture:** QdrantManager gets alias CRUD methods. IndexPipeline creates
versioned collections (`_v1`, `_v2`), indexes into them, then atomically
switches the alias. Orphan cleanup runs before each forceReindex. Snapshot meta
tracks `aliasVersion`.

**Tech Stack:** TypeScript, Qdrant REST API (`update_aliases`, `GET /aliases`),
Vitest

**Spec:** `docs/superpowers/specs/2026-03-18-collection-aliases-design.md`

---

### Task 1: QdrantManager Alias Methods

**Files:**

- Create: `src/core/adapters/qdrant/aliases.ts`
- Modify: `src/core/adapters/qdrant/client.ts`
- Modify: `src/core/adapters/qdrant/errors.ts`
- Modify: `src/core/contracts/errors.ts`
- Test: `tests/core/adapters/qdrant/aliases.test.ts`

- [ ] **Step 1: Write failing tests for alias operations**

Test `createAlias(alias, collection)`, `switchAlias(alias, from, to)`,
`deleteAlias(alias)`, `isAlias(name)`, `listAliases()`.

Mock `QdrantClient` methods: `updateCollectionAliases()`,
`getCollectionAliases()`.

```typescript
describe("QdrantAliasManager", () => {
  it("createAlias calls updateCollectionAliases with create_alias action", async () => {
    await manager.createAlias("code_abc", "code_abc_v1");
    expect(client.updateCollectionAliases).toHaveBeenCalledWith({
      actions: [
        {
          create_alias: {
            alias_name: "code_abc",
            collection_name: "code_abc_v1",
          },
        },
      ],
    });
  });

  it("switchAlias atomically deletes old and creates new", async () => {
    await manager.switchAlias("code_abc", "code_abc_v1", "code_abc_v2");
    expect(client.updateCollectionAliases).toHaveBeenCalledWith({
      actions: [
        { delete_alias: { alias_name: "code_abc" } },
        {
          create_alias: {
            alias_name: "code_abc",
            collection_name: "code_abc_v2",
          },
        },
      ],
    });
  });

  it("isAlias returns true for alias, false for real collection", async () => {
    client.getCollectionAliases.mockResolvedValue({
      aliases: [{ alias_name: "code_abc", collection_name: "code_abc_v1" }],
    });
    expect(await manager.isAlias("code_abc")).toBe(true);
    expect(await manager.isAlias("code_xyz")).toBe(false);
  });

  it("listAliases returns all alias mappings", async () => {
    // ...
  });
});
```

- [ ] **Step 2: Run tests — expect FAIL (module not found)**

Run: `npx vitest run tests/core/adapters/qdrant/aliases.test.ts`

- [ ] **Step 3: Add `INFRA_ALIAS_OPERATION` to ErrorCode union**

In `src/core/contracts/errors.ts`, add `INFRA_ALIAS_OPERATION` to the
`ErrorCode` type.

- [ ] **Step 4: Add `AliasOperationError` to
      `src/core/adapters/qdrant/errors.ts`**

```typescript
export class AliasOperationError extends InfraError {
  constructor(operation: string, detail: string, cause?: Error) {
    super({
      code: "INFRA_ALIAS_OPERATION",
      message: `Alias operation "${operation}" failed: ${detail}`,
      hint: "Check Qdrant server status and collection names",
      httpStatus: 500,
      cause,
    });
  }
}
```

- [ ] **Step 5: Create `src/core/adapters/qdrant/aliases.ts`**

```typescript
import { QdrantClient } from "@qdrant/js-client-rest";
import { AliasOperationError } from "./errors.js";

export class QdrantAliasManager {
  constructor(private readonly client: QdrantClient) {}

  async createAlias(alias: string, collection: string): Promise<void> { ... }
  async switchAlias(alias: string, fromCollection: string, toCollection: string): Promise<void> { ... }
  async deleteAlias(alias: string): Promise<void> { ... }
  async isAlias(name: string): Promise<boolean> { ... }
  async listAliases(): Promise<Array<{ aliasName: string; collectionName: string }>> { ... }
}
```

Each method wraps errors in `AliasOperationError`.

- [ ] **Step 6: Expose alias manager from QdrantManager**

In `src/core/adapters/qdrant/client.ts`, add:

```typescript
get aliases(): QdrantAliasManager {
  return this._aliases ??= new QdrantAliasManager(this.client);
}
```

- [ ] **Step 7: Run tests — expect PASS**

Run: `npx vitest run tests/core/adapters/qdrant/aliases.test.ts`

- [ ] **Step 8: Run full test suite**

Run: `npx vitest run`

- [ ] **Step 9: Commit**

```bash
git commit -m "feat(qdrant): add QdrantAliasManager with create, switch, delete, isAlias, listAliases"
```

---

### Task 2: Snapshot aliasVersion Support

**Files:**

- Modify: `src/core/domains/ingest/sync/sharded-snapshot.ts`
- Test: `tests/core/domains/ingest/sync/sharded-snapshot.test.ts`

- [ ] **Step 1: Write failing test for aliasVersion in snapshot meta**

```typescript
it("saves and loads aliasVersion in snapshot meta", async () => {
  const manager = new ShardedSnapshotManager(dir, 4);
  await manager.save(files, "/project", { aliasVersion: 3 });
  const loaded = await manager.load();
  expect(loaded.aliasVersion).toBe(3);
});

it("defaults aliasVersion to 0 when not present", async () => {
  // Load a v3 snapshot without aliasVersion
  const loaded = await manager.load();
  expect(loaded.aliasVersion).toBe(0);
});
```

- [ ] **Step 2: Run tests — expect FAIL**

- [ ] **Step 3: Add `aliasVersion` to SnapshotMeta interface**

In `sharded-snapshot.ts`, add `aliasVersion?: number` to `SnapshotMeta`. In
`save()`, write `aliasVersion` to meta.json. In `load()`, read
`aliasVersion ?? 0`.

Update `LoadedSnapshot` (line 61 in `sharded-snapshot.ts`) to include
`aliasVersion: number`.

- [ ] **Step 4: Run tests — expect PASS**

- [ ] **Step 5: Run full test suite**

Run: `npx vitest run`

- [ ] **Step 6: Commit**

```bash
git commit -m "feat(ingest): add aliasVersion to sharded snapshot meta"
```

---

### Task 3: Orphan Cleanup

**Files:**

- Create: `src/core/domains/ingest/alias-cleanup.ts`
- Test: `tests/core/domains/ingest/alias-cleanup.test.ts`

- [ ] **Step 1: Write failing tests for orphan detection and cleanup**

```typescript
describe("cleanupOrphanedVersions", () => {
  it("deletes versioned collections not pointed to by alias", async () => {
    // Alias code_abc → code_abc_v2
    // Collections: code_abc_v1, code_abc_v2, code_abc_v3
    // Expected: delete code_abc_v1 and code_abc_v3
    mockQdrant.aliases.listAliases.mockResolvedValue([
      { aliasName: "code_abc", collectionName: "code_abc_v2" },
    ]);
    mockQdrant.listCollections.mockResolvedValue([
      "code_abc_v1", "code_abc_v2", "code_abc_v3", "other_collection",
    ]);

    await cleanupOrphanedVersions(mockQdrant, "code_abc");

    expect(mockQdrant.deleteCollection).toHaveBeenCalledWith("code_abc_v1");
    expect(mockQdrant.deleteCollection).toHaveBeenCalledWith("code_abc_v3");
    expect(mockQdrant.deleteCollection).not.toHaveBeenCalledWith("code_abc_v2");
    expect(mockQdrant.deleteCollection).not.toHaveBeenCalledWith("other_collection");
  });

  it("does nothing when no orphans exist", async () => { ... });
  it("does nothing when alias not found", async () => { ... });
});
```

- [ ] **Step 2: Run tests — expect FAIL**

- [ ] **Step 3: Implement `cleanupOrphanedVersions()`**

```typescript
export async function cleanupOrphanedVersions(
  qdrant: QdrantManager,
  collectionName: string,
): Promise<number> {
  const aliases = await qdrant.aliases.listAliases();
  const activeCollection = aliases.find(
    (a) => a.aliasName === collectionName,
  )?.collectionName;
  if (!activeCollection) return 0;

  const allCollections = await qdrant.listCollections();
  const orphans = allCollections.filter(
    (c) => c.startsWith(`${collectionName}_v`) && c !== activeCollection,
  );

  for (const orphan of orphans) {
    await qdrant.deleteCollection(orphan);
  }
  return orphans.length;
}
```

- [ ] **Step 4: Run tests — expect PASS**

- [ ] **Step 5: Run full test suite**

Run: `npx vitest run`

- [ ] **Step 6: Update barrel file**

Add `export { cleanupOrphanedVersions } from "./alias-cleanup.js"` to
`src/core/domains/ingest/index.ts`.

- [ ] **Step 7: Commit**

```bash
git commit -m "feat(ingest): add cleanupOrphanedVersions for alias-based reindex"
```

---

### Task 4: IndexPipeline — Versioned forceReindex

**Files:**

- Modify: `src/core/domains/ingest/indexing.ts`
- Test: `tests/core/domains/ingest/indexing.test.ts` (update existing)

- [ ] **Step 1: Write failing tests for alias-based forceReindex**

```typescript
describe("IndexPipeline with aliases", () => {
  it("first index creates _v1 collection and alias", async () => {
    // snapshotMeta.aliasVersion = 0 (no previous)
    // Expects: createCollection("code_abc_v1"), createAlias("code_abc", "code_abc_v1")
  });

  it("forceReindex creates _v2 and switches alias", async () => {
    // snapshotMeta.aliasVersion = 1
    // Expects: createCollection("code_abc_v2"), index into it,
    //   switchAlias("code_abc", "code_abc_v1", "code_abc_v2"),
    //   deleteCollection("code_abc_v1")
  });

  it("runs orphan cleanup before forceReindex", async () => {
    // Expects cleanupOrphanedVersions called before indexing starts
  });

  it("cleans up incomplete collection on failure", async () => {
    // Indexing fails mid-way
    // Expects: deleteCollection("code_abc_v2"), alias stays on v1
  });

  it("migration: handles real collection (not alias)", async () => {
    // isAlias("code_abc") = false, collectionExists("code_abc") = true
    // Expects: create _v2, index, delete "code_abc", createAlias → _v2
  });
});
```

- [ ] **Step 2: Run tests — expect FAIL**

- [ ] **Step 3: Refactor `IndexPipeline.setupCollection()` for alias-aware
      flow**

Replace current `setupCollection()` with alias-aware logic:

```typescript
private async setupCollection(collectionName: string, options?: IndexOptions): Promise<{
  ready: boolean;
  targetCollection: string;
  previousCollection?: string;
  isFirstIndex: boolean;
  isMigration: boolean;
}> {
  if (!options?.forceReindex) {
    // Non-force: check if collection or alias exists
    const exists = await this.qdrant.collectionExists(collectionName);
    if (exists) return { ready: false, targetCollection: collectionName, isFirstIndex: false, isMigration: false };
  }

  // Load aliasVersion from snapshot via synchronizer
  const synchronizer = this.deps.createSynchronizer(/* path from context */, collectionName);
  const loadedSnapshot = await synchronizer.snapshotManager.load();
  const aliasVersion = loadedSnapshot?.aliasVersion ?? 0;

  // Detect migration (real collection exists but is not an alias)
  const isMigration = aliasVersion === 0 && await this.qdrant.collectionExists(collectionName)
    && !(await this.qdrant.aliases.isAlias(collectionName));

  // For migration: existing collection counts as v1, new one is v2
  const newVersion = isMigration ? 2 : aliasVersion + 1;
  const versionedName = `${collectionName}_v${newVersion}`;

  // Orphan cleanup
  await cleanupOrphanedVersions(this.qdrant, collectionName);

  // Create new versioned collection
  const vectorSize = this.embeddings.getDimensions();
  await this.qdrant.createCollection(versionedName, vectorSize, "Cosine",
    this.config.enableHybridSearch, this.config.quantizationScalar);

  const schemaManager = this.deps.createSchemaManager();
  await schemaManager.initializeSchema(versionedName);
  await storeIndexingMarker(this.qdrant, this.embeddings, versionedName, false);

  const previousCollection = aliasVersion > 0 ? `${collectionName}_v${aliasVersion}` : undefined;

  return {
    ready: true,
    targetCollection: versionedName,
    previousCollection,
    isFirstIndex: aliasVersion === 0 && !isMigration,
    isMigration,
  };
}
```

- [ ] **Step 4: Add `finalizeAlias()` method**

Called after successful indexing:

```typescript
private async finalizeAlias(
  collectionName: string,
  targetCollection: string,
  previousCollection: string | undefined,
  isFirstIndex: boolean,
  isMigration: boolean,
  aliasVersion: number,
): Promise<void> {
  if (isFirstIndex) {
    await this.qdrant.aliases.createAlias(collectionName, targetCollection);
  } else if (isMigration) {
    await this.qdrant.deleteCollection(collectionName);
    await this.qdrant.aliases.createAlias(collectionName, targetCollection);
  } else {
    await this.qdrant.aliases.switchAlias(collectionName, previousCollection!, targetCollection);
    await this.qdrant.deleteCollection(previousCollection!);
  }
}
```

- [ ] **Step 5: Add rollback on failure**

In the catch block of `indexCodebase()`:

```typescript
// Clean up incomplete versioned collection
if (targetCollection !== collectionName) {
  try {
    await this.qdrant.deleteCollection(targetCollection);
  } catch {}
}
```

- [ ] **Step 6: Update `indexCodebase()` to use new flow**

Wire `setupCollection` → index into `targetCollection` → `finalizeAlias` → save
snapshot with `aliasVersion`.

- [ ] **Step 7: Run tests — expect PASS**

- [ ] **Step 8: Run full test suite**

Run: `npx vitest run`

- [ ] **Step 9: Commit**

```bash
git commit -m "feat(ingest): alias-based zero-downtime forceReindex with orphan cleanup and migration"
```

---

### Task 5: Integration Verification & Documentation

**Files:**

- Modify: `website/docs/operations/troubleshooting-and-error-codes.md`

- [ ] **Step 1: Add `INFRA_ALIAS_OPERATION` to error codes table**

- [ ] **Step 2: Run full test suite**

Run: `npx vitest run`

- [ ] **Step 3: Commit**

```bash
git commit -m "docs(operations): add AliasOperationError to error codes reference"
```

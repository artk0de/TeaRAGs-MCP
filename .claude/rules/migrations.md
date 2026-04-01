---
description:
  When and how to add Qdrant schema migrations, snapshot format migrations, or
  sparse vector migrations. Triggers when changing payload structure, adding
  indexes, modifying persisted data format, or working with migration code.
paths:
  - "src/core/infra/migration/**/*.ts"
  - "src/core/domains/ingest/factory.ts"
  - "src/core/domains/ingest/pipeline/payload/**/*.ts"
  - "src/core/contracts/types/payload.ts"
  - "src/core/contracts/types/qdrant.ts"
---

# Migration Rules

## When to Add a Migration

Add a migration when changes affect **persisted state** that existing
collections or snapshots already contain:

| Change type                             | Pipeline   | Example                            |
| --------------------------------------- | ---------- | ---------------------------------- |
| New Qdrant payload index                | `schema`   | Add keyword index on `symbolId`    |
| Change index type (keyword → text)      | `schema`   | Enable full-text on `relativePath` |
| Enable/configure sparse vectors         | `schema`   | Activate BM25 for hybrid search    |
| Backfill payload fields                 | `schema`   | Set `enrichedAt` on old points     |
| Qdrant collection config change         | `schema`   | Modify vector params               |
| Sparse vector rebuild after BM25 change | `sparse`   | Regenerate BM25 vectors            |
| Snapshot format change                  | `snapshot` | Add new fields to snapshot entries |

**Do NOT add a migration when:**

- Adding new payload fields to newly indexed documents (new fields appear
  naturally at index time)
- Changing in-memory logic (reranking, derived signals, presets)
- Changing MCP tool schemas or DTOs
- Refactoring code without changing persisted data format

## Three Migration Pipelines

| Pipeline   | What it upgrades         | Version storage                           | Runner class       |
| ---------- | ------------------------ | ----------------------------------------- | ------------------ |
| `schema`   | Qdrant collection schema | `__schema_metadata__` point in collection | `SchemaMigrator`   |
| `snapshot` | On-disk snapshot format  | Implicit (derived from format on disk)    | `SnapshotMigrator` |
| `sparse`   | BM25 sparse vectors      | `__schema_metadata__.sparseVersion`       | `SparseMigrator`   |

## Migration Interface

Every migration implements `Migration` from `infra/migration/types.ts`:

```typescript
interface Migration {
  readonly name: string; // Unique identifier: "<pipeline>-v<N>-<description>"
  readonly version: number; // Integer ordering key, must be > all existing versions
  apply(): Promise<StepResult>; // Execution method, must be idempotent
}

interface StepResult {
  applied: string[]; // Human-readable list of what was done
}
```

## Naming Conventions

| Convention      | Format                                   | Example                          |
| --------------- | ---------------------------------------- | -------------------------------- |
| File name       | `<pipeline>-v<N>-<kebab-description>.ts` | `schema-v10-newfield-keyword.ts` |
| Class name      | `<Pipeline>V<N><PascalDescription>`      | `SchemaV10NewfieldKeyword`       |
| `name` property | Same as file name without `.ts`          | `"schema-v10-newfield-keyword"`  |
| `version`       | Next integer after highest existing      | `10` (if last was `9`)           |
| Directory       | `<pipeline>_migrations/`                 | `schema_migrations/`             |

## Store Adapters (DIP)

Migrations MUST NOT depend on concrete infrastructure classes. Use store
interfaces:

| Store interface   | Provides                          | Adapter                  |
| ----------------- | --------------------------------- | ------------------------ |
| `IndexStore`      | Qdrant index CRUD, schema version | `IndexStoreAdapter`      |
| `SnapshotStore`   | Filesystem snapshot read/write    | `SnapshotStoreAdapter`   |
| `SparseStore`     | Sparse vector rebuild, version    | `SparseStoreAdapter`     |
| `EnrichmentStore` | Payload backfill operations       | `EnrichmentStoreAdapter` |

If a new migration needs capabilities not in existing stores, extend the
interface + adapter first — do NOT inject `QdrantManager` directly.

## Forcing File Re-Indexation via Snapshot Invalidation

When a migration needs files to be re-processed (e.g., chunker strategy
changed), delete chunks from Qdrant AND invalidate snapshot entries:

1. **Delete chunks from Qdrant** —
   `store.deletePointsByFilter(collection, filter)`
2. **Invalidate snapshot** — `snapshotStore.invalidateByExtensions([".md"])`

**How snapshot invalidation works:** Sets `mtime = 0` on matching entries.
Synchronizer's fast path skips files with matching mtime+size — zeroing mtime
forces slow path → hash recomputed from disk → hash differs from snapshot → file
treated as "modified" → re-chunked.

**CRITICAL: Use `mtime = 0`, NOT `hash = ""`**. Zeroing hash has no effect
because the fast path uses the cached hash from snapshot for comparison
(`previousMeta.hash !== hash` where both are the same empty string).

**Migration order:** Schema migrations run BEFORE synchronizer in
`prepareReindexContext()`. This ensures snapshot is invalidated before change
detection.

**Shard count:** Use `readShardCount()` from meta.json, not the default.
Snapshots may have been created with a different shard count.

## Execution Guarantees

1. **Sequential** — migrations run sorted by `version` ascending
2. **Idempotent** — only `version > currentVersion` are applied
3. **Fail-fast** — first error stops pipeline, remaining migrations skipped
4. **Atomic versioning** — version persisted only after ALL steps succeed
5. **No rollback** — migrations must be safe to re-run after partial failure

## Conditional Migrations

Some migrations are optional (feature flags, optional dependencies):

```typescript
// In runner constructor — conditionally include:
...(enrichmentStore && options.providerKey
  ? [new SchemaV9EnrichedAtBackfill(collection, enrichmentStore, options.providerKey)]
  : []),

// In apply() — skip with explanation:
if (!this.enableHybrid) {
  return { applied: ["sparse config — skipped (hybrid disabled)"] };
}
```

## Registration Point

Migrations are hardcoded in runner constructors — no auto-discovery:

- Schema: `src/core/infra/migration/schema-migrator.ts`
- Snapshot: `src/core/infra/migration/snapshot-migrator.ts`
- Sparse: `src/core/infra/migration/sparse-migrator.ts`

Runner instantiation happens in `src/core/domains/ingest/factory.ts` →
`createIngestDependencies()`.

## Testing

Test file: `tests/core/infra/migration/<pipeline>-migrator.test.ts`

Required scenarios:

1. Migration applies correctly (happy path)
2. Migration skips when condition not met (conditional migrations)
3. Migration is idempotent (re-running produces same result)
4. Integration with runner: version filtering, ordering

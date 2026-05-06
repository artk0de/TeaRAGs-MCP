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

## Writing Nested Payload Keys (MANDATORY)

Qdrant's `setPayload` treats top-level keys verbatim. Passing
`{"git.file.X": v}` produces a flat top-level key literally named `"git.file.X"`
— NOT a nested write at `git → file → X`. Reranker reads nested paths, so the
data is invisible.

**Always build nested objects** when migrating dotted-path keys:

```typescript
// WRONG — creates flat key "git.file.recentDominantAuthor" at payload root
newPayload["git.file.recentDominantAuthor"] = oldVal;

// RIGHT — writes the nested leaf
newPayload.git = { file: { recentDominantAuthor: oldVal } };
```

For multiple leaves, use a `writeNested(target, path, value)` helper that splits
on `.` and creates intermediate objects (see V13 migration). Top-level keys
without dots (e.g. `parentSymbolId` in V11) can be written directly.

## Pre-Release Migrations: Edit, Don't Stack

If a migration ships in code that has **not been published to npm**, fix the
migration in place — do NOT add a follow-up migration to clean up its bugs.
Developer indexes can be rebuilt with `forceReindex: true` or by deleting the
collection. Stacking V14 to fix V13's bug pollutes history and makes the next
release noisier than necessary.

Add a follow-up migration only when buggy code has reached published users —
their data is real and irreversible without code changes.

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

## End-to-End Migration Verification (MANDATORY before claiming "migration works")

Unit tests prove the migration's logic, but they do **not** prove the migration
actually runs against a real Qdrant collection at index time. Before claiming a
migration is verified, you MUST execute the live path against an existing
indexed collection. Skipping this caused real failures — production indexes
silently kept stale schema versions because the MCP server was running pre-bump
code.

### Pre-flight (eliminates the most common failure)

1. `npm run build` — produce fresh `build/` from current source.
2. **Reconnect the MCP server AFTER the build completes** (per
   `.local/mcp-testing.md`). MCP server runs in a separate process; if you
   reconnect before the build, the server runs old code and the new migration
   class is not even registered in `SchemaMigrator`.
3. Verify the new migration class appears in compiled output:
   `grep -l <MigrationClassName> build/core/infra/migration/schema_migrations/`.

### Live verification protocol

4. **Roll back schema version** on an existing collection by writing
   `schemaVersion: <N-1>` to the `__schema_metadata__` point (UUID = sha256 of
   `__schema_metadata__`, formatted 8-4-4-4-12). Use Qdrant REST
   `/collections/<c>/points/payload?wait=true`.
5. **Inject pre-migration state** into a few real points — for rename/backfill
   migrations, write the OLD payload keys with sentinel values via the same
   `/points/payload` endpoint.
6. **Trigger an incremental reindex** (`index_codebase` without `forceReindex`).
   The schema migrator runs in `prepareReindexContext()` BEFORE the
   synchronizer/enrichment, so a no-change incremental still exercises it.
7. **Verify the migration ran** by reading `__schema_metadata__` directly:
   `schemaVersion` must equal `latestVersion` and `migratedAt` must be after
   step 6.
8. **Verify the data effect** by reading affected points:
   - For rename migrations: old keys absent, new keys present.
   - For backfill migrations: target keys populated.
   - **Caveat:** if the trajectory's enrichment refreshes the same fields on
     every reindex (file-level git enrichment does this), injected sentinel
     values will be overwritten. Use the `__schema_metadata__` audit
     (`migratedAt` timestamp) and the absence of legacy keys as proof of
     migration; trust the unit test for value-preservation correctness.
9. **Confirm idempotency** by running `index_codebase` again — `migratedAt`
   should not change (migration skipped because version already current).

### Anti-patterns observed in this project

- Running `forceReindex: true` to "test the migration" — this rewrites payloads
  from scratch and never exercises the migration's rename/backfill logic on real
  legacy data.
- Reading `get_index_metrics` to verify schema state — its `signals` map is
  derived from descriptors, NOT from current payload keys; stale values there do
  not indicate migration failure.
- Trusting `npm test` alone — unit tests use a `MockQdrantManager`; they cannot
  catch a missing registration in `schema-migrator.ts` or an MCP-server reload
  gap.

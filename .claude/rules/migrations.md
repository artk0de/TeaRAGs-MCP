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

Add migration when change affects **persisted state** existing
collections/snapshots already contain:

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

- Adding new payload fields to newly indexed docs (new fields appear naturally
  at index time)
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

Migrations MUST NOT depend on concrete infra classes. Use store interfaces:

| Store interface   | Provides                          | Adapter                  |
| ----------------- | --------------------------------- | ------------------------ |
| `IndexStore`      | Qdrant index CRUD, schema version | `IndexStoreAdapter`      |
| `SnapshotStore`   | Filesystem snapshot read/write    | `SnapshotStoreAdapter`   |
| `SparseStore`     | Sparse vector rebuild, version    | `SparseStoreAdapter`     |
| `EnrichmentStore` | Payload backfill operations       | `EnrichmentStoreAdapter` |

New migration needs capability not in existing stores → extend interface+adapter
first — do NOT inject `QdrantManager` directly.

## Forcing File Re-Indexation via Snapshot Invalidation

Migration needs files re-processed (e.g. chunker strategy changed) → delete
chunks from Qdrant AND invalidate snapshot entries:

1. **Delete chunks from Qdrant** —
   `store.deletePointsByFilter(collection, filter)`
2. **Invalidate snapshot** — `snapshotStore.invalidateByExtensions([".md"])`

**How snapshot invalidation works:** Sets `mtime = 0` on matching entries.
Synchronizer's fast path skips files with matching mtime+size — zeroing mtime
forces slow path → hash recomputed from disk → hash differs from snapshot → file
treated as "modified" → re-chunked.

**CRITICAL: Use `mtime = 0`, NOT `hash = ""`**. Zeroing hash has no effect —
fast path uses cached snapshot hash for comparison
(`previousMeta.hash !== hash`, both same empty string).

**Migration order:** Schema migrations run BEFORE synchronizer in
`prepareReindexContext()`. Ensures snapshot invalidated before change detection.

**Shard count:** Use `readShardCount()` from meta.json, not default. Snapshots
may have been created with different shard count.

## Writing Nested Payload Keys (MANDATORY)

Qdrant's `setPayload` treats top-level keys verbatim. Passing
`{"git.file.X": v}` produces flat top-level key literally named `"git.file.X"` —
NOT nested write at `git → file → X`. Reranker reads nested paths → data
invisible.

**Always build nested objects** when migrating dotted-path keys:

```typescript
// WRONG — creates flat key "git.file.recentDominantAuthor" at payload root
newPayload["git.file.recentDominantAuthor"] = oldVal;

// RIGHT — writes the nested leaf
newPayload.git = { file: { recentDominantAuthor: oldVal } };
```

Multiple leaves → use `writeNested(target, path, value)` helper splitting on `.`
creating intermediate objects (see V13 migration). Top-level keys without dots
(e.g. `parentSymbolId` in V11) written directly.

## Pre-Release Migrations: Edit, Don't Stack

Migration ships in code **not yet published to npm** → fix migration in place —
do NOT add follow-up migration to clean up its bugs. Dev indexes rebuilt with
`forceReindex: true` or by deleting collection. Stacking V14 to fix V13's bug
pollutes history, makes next release noisier.

Add follow-up migration only when buggy code reached published users — their
data real, irreversible without code changes.

## Execution Guarantees

1. **Sequential** — migrations run sorted by `version` ascending
2. **Idempotent** — only `version > currentVersion` are applied
3. **Fail-fast** — first error stops pipeline, remaining migrations skipped
4. **Atomic versioning** — version persisted only after ALL steps succeed
5. **No rollback** — migrations must be safe to re-run after partial failure

## Conditional Migrations

Some migrations optional (feature flags, optional dependencies):

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

Migrations hardcoded in runner constructors — no auto-discovery:

- Schema: `src/core/infra/migration/schema-migrator.ts`
- Snapshot: `src/core/infra/migration/snapshot-migrator.ts`
- Sparse: `src/core/infra/migration/sparse-migrator.ts`

Runner instantiation in `src/core/domains/ingest/factory.ts` →
`createIngestDependencies()`.

## Testing

Test file: `tests/core/infra/migration/<pipeline>-migrator.test.ts`

Required scenarios:

1. Migration applies correctly (happy path)
2. Migration skips when condition not met (conditional migrations)
3. Migration is idempotent (re-running produces same result)
4. Integration with runner: version filtering, ordering

## End-to-End Migration Verification (MANDATORY before claiming "migration works")

Unit tests prove migration logic but do **not** prove it actually runs against
real Qdrant collection at index time. Before claiming verified, MUST execute
live path against existing indexed collection. Skipping caused real failures —
production indexes silently kept stale schema versions because MCP server ran
pre-bump code.

### Pre-flight (eliminates the most common failure)

1. `npm run build` — produce fresh `build/` from current source.
2. **Reconnect the MCP server AFTER the build completes** (per
   `.local/mcp-testing.md`). MCP server = separate process; reconnect before
   build → server runs old code, new migration class not even registered in
   `SchemaMigrator`.
3. Verify new migration class in compiled output:
   `grep -l <MigrationClassName> build/core/infra/migration/schema_migrations/`.

### Live verification protocol

4. **Roll back schema version** on existing collection by writing
   `schemaVersion: <N-1>` to `__schema_metadata__` point (UUID = sha256 of
   `__schema_metadata__`, formatted 8-4-4-4-12). Use Qdrant REST
   `/collections/<c>/points/payload?wait=true`.
5. **Inject pre-migration state** into a few real points — for rename/backfill
   migrations, write OLD payload keys with sentinel values via same
   `/points/payload` endpoint.
6. **Trigger incremental reindex** (`index_codebase` without `forceReindex`).
   Schema migrator runs in `prepareReindexContext()` BEFORE
   synchronizer/enrichment, so no-change incremental still exercises it.
7. **Verify migration ran** by reading `__schema_metadata__` directly:
   `schemaVersion` must equal `latestVersion`, `migratedAt` must be after
   step 6.
8. **Verify data effect** by reading affected points:
   - For rename migrations: old keys absent, new keys present.
   - For backfill migrations: target keys populated.
   - **Caveat:** if trajectory's enrichment refreshes same fields on every
     reindex (file-level git enrichment does), injected sentinel values
     overwritten. Use `__schema_metadata__` audit (`migratedAt` timestamp) +
     absence of legacy keys as proof of migration; trust unit test for
     value-preservation correctness.
9. **Confirm idempotency** by running `index_codebase` again — `migratedAt`
   should not change (migration skipped, version already current).

### Anti-patterns observed in this project

- Running `forceReindex: true` to "test the migration" — rewrites payloads from
  scratch, never exercises migration's rename/backfill logic on real legacy
  data.
- Reading `get_index_metrics` to verify schema state — its `signals` map derived
  from descriptors, NOT current payload keys; stale values there don't indicate
  migration failure.
- Trusting `npm test` alone — unit tests use `MockQdrantManager`; can't catch
  missing registration in `schema-migrator.ts` or MCP-server reload gap.

---
description:
  When and how to add Qdrant schema migrations, snapshot format migrations,
  sparse vector migrations, or stats-cache backfills. Triggers when changing
  payload structure, adding indexes, changing the shape of ANY persisted store,
  or working with migration code.
paths:
  - "src/core/domains/maintenance/migration/**/*.ts"
  - "src/core/api/internal/ingest-dependencies.ts"
  - "src/core/contracts/types/migration.ts"
  - "src/core/domains/ingest/operations/reindexing.ts"
  - "src/core/domains/ingest/sync/snapshot/**/*.ts"
  - "src/core/domains/trajectory/*/payload-signals.ts"
  - "src/core/infra/stats-cache.ts"
  - "src/core/adapters/qdrant/types.ts"
  - "tests/core/domains/maintenance/migration/**/*.ts"
---

# Migration Rules

## The General Rule

**Change the shape of anything already written to disk or to Qdrant → ship a
migration in the same change.** Not a follow-up bead, not a note in the release
docs, not a drift warning telling the user to reindex. The store and its upgrade
path land together, or existing installs silently keep the old shape.

That covers every persisted store this project owns, not just the Qdrant
payload:

| Persisted store             | Lives in                              | Pipeline   |
| --------------------------- | ------------------------------------- | ---------- |
| Qdrant collection + payload | the collection itself                 | `schema`   |
| BM25 sparse vectors         | the collection's sparse config        | `sparse`   |
| File snapshot               | `<snapshots>/<collection>.snapshot*`  | `snapshot` |
| Collection stats cache      | `<snapshots>/<collection>.stats.json` | `stats`    |
| Codegraph tables            | the per-collection DuckDB file        | `database` |

**Reindex is not a migration.** Telling the user to reindex is acceptable ONLY
when the new state genuinely cannot be derived from what is already stored — new
embeddings, new chunk boundaries. If the value CAN be computed from data already
on disk, it is a partial-update path, and a partial-update path means a
migration. See `.claude/rules/.local/schema-drift-vs-migration.md` for the
distinction; `stats-v6-score-background` is the worked example — it measures the
similarity scale from vectors already stored, so demanding a full reindex for it
would have been the wrong price.

**Drift detection is not a substitute either, and often cannot even see the
change.** `SchemaDriftMonitor` compares Qdrant _payload_ keys. A field that
lives anywhere else — the stats cache, the snapshot, the DuckDB file — is
invisible to it, so "the user will be warned" is false by construction outside
the payload.

## When to Add a Migration

Add migration when change affects **persisted state** existing
collections/snapshots/caches already contain:

| Change type                             | Pipeline   | Example                             |
| --------------------------------------- | ---------- | ----------------------------------- |
| New Qdrant payload index                | `schema`   | Add keyword index on `symbolId`     |
| Change index type (keyword → text)      | `schema`   | Enable full-text on `relativePath`  |
| Enable/configure sparse vectors         | `schema`   | Activate BM25 for hybrid search     |
| Backfill payload fields                 | `schema`   | Set `enrichedAt` on old points      |
| Qdrant collection config change         | `schema`   | Modify vector params                |
| Sparse vector rebuild after BM25 change | `sparse`   | Regenerate BM25 vectors             |
| Snapshot format change                  | `snapshot` | Add new fields to snapshot entries  |
| Snapshot store gains/renames a field    | `snapshot` | mtime+size added alongside the hash |
| Stats-cache gains a computed field      | `stats`    | Backfill `scoreBackground` (v6)     |
| Codegraph table/column change           | `database` | New `cg_symbols` column or index    |

**Do NOT add a migration when:**

- Adding new payload fields to newly indexed docs (new fields appear naturally
  at index time)
- Changing in-memory logic (reranking, derived signals, presets)
- Changing MCP tool schemas or DTOs
- Refactoring code without changing persisted data format

## Migration Pipelines

Four run through `Migrator` on the reindex sweep; `database` runs separately,
against the DuckDB client, on graph open.

| Pipeline   | What it upgrades         | Version storage                           | Runner class       |
| ---------- | ------------------------ | ----------------------------------------- | ------------------ |
| `schema`   | Qdrant collection schema | `__schema_metadata__` point in collection | `SchemaMigrator`   |
| `snapshot` | On-disk snapshot format  | Implicit (derived from format on disk)    | `SnapshotMigrator` |
| `sparse`   | BM25 sparse vectors      | `__schema_metadata__.sparseVersion`       | `SparseMigrator`   |
| `stats`    | Collection stats cache   | Implicit (derived from the data present)  | `StatsMigrator`    |
| `database` | Codegraph DuckDB tables  | `schema_migrations` table in the DB       | `runMigrations`    |

### Deriving the version from data, not from a declaration

`snapshot` and `stats` both report their version by INSPECTING what is on disk
rather than reading a version field, and that is deliberate. A stats file can
carry `version: 6` and still lack `scoreBackground`, because the writer stores
that field only when the measurement succeeded. Trusting the declared number
would report 6, the runner would filter the migration out as already-applied,
and the gap would never close. When a field is written conditionally, derive the
version from the field's presence — `setVersion` then stays a no-op, because the
data itself is the record.

## Migration Interface

Every migration implements `Migration` from
`domains/maintenance/migration/types.ts`:

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
| `StatsStore`      | Stats-cache state + backfill      | `StatsStoreAdapter`      |

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

- Schema: `src/core/domains/maintenance/migration/schema-migrator.ts`
- Snapshot: `src/core/domains/maintenance/migration/snapshot-migrator.ts`
- Sparse: `src/core/domains/maintenance/migration/sparse-migrator.ts`
- Stats: `src/core/domains/maintenance/migration/stats-migrator.ts`
- Database:
  `src/core/domains/maintenance/migration/database/migrations/index.ts`

Runner instantiation in `src/core/api/internal/ingest-dependencies.ts` →
`createIngestDependencies()`. The pipelines live in the maintenance domain, so
composition happens at the api layer — ingest triggers them through
`MigratorPort` (`contracts/types/migration.ts`).

**Adding a pipeline is a four-point change**, and missing any one of them turns
into a runtime failure of every reindex rather than a type error:

1. `PipelineName` in `migration/migrator.ts`
2. `MigrationPipelineName` in `contracts/types/migration.ts` — the port the
   ingest domain calls through
3. registration in `createIngestDependencies()` — `Migrator` throws on a
   pipeline it does not know
4. the `migrator.run("<name>")` call in `reindexing.ts` → `runMigrations()`

`tests/core/api/internal/ingest-dependencies-migrations.test.ts` guards 3 and 4
without needing a collection or a build.

**Where the sweep runs matters.** `runMigrations()` is called from
`prepareReindexContext()`, ahead of every change-detection early return. That
placement is what lets a repository with no file changes at all still pick up a
migration — do not move it below the early returns.

## Testing

Test file:
`tests/core/domains/maintenance/migration/<pipeline>-migrator.test.ts`

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
   `grep -l <MigrationClassName> build/core/domains/maintenance/migration/schema_migrations/`.

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

# Migration Framework Design

**Date:** 2026-03-26 **Status:** Approved

## Problem

Migration logic is scattered across 4 files in 3 different layers:

| What                    | File                                  | Layer    |
| ----------------------- | ------------------------------------- | -------- |
| Snapshot v1→v2 in-place | `domains/ingest/sync/synchronizer.ts` | domains  |
| Snapshot → sharded      | `domains/ingest/sync/migration.ts`    | domains  |
| Schema indexes v4→v8    | `adapters/qdrant/schema-migration.ts` | adapters |
| Sparse vector rebuild   | `adapters/qdrant/schema-migration.ts` | adapters |

No shared interface, no unified logging, no discoverability. Adding a new
migration requires knowing which file in which layer to touch.

## Scope

**In scope:** reindex-time migrations (explicit data format upgrades):

- Snapshot format (v1 → v2 → sharded)
- Schema indexes (v4 → v8)
- Sparse vector rebuild (v0 → v1)

**Out of scope (stays where it is):**

- `StatsCache` version handling — cache is rebuilt every reindex, no migration
  needed
- Lazy index creation for scroll rerank (`ScrollRankStrategy.ensureIndexFn`)
- Schema drift detection (`SchemaDriftMonitor`)
- `SchemaManager.initializeSchema()` — creates indexes from scratch for new
  collections, not a migration

## Design

### File Structure

```
infra/migration/
  types.ts                                — Migration, MigrationSummary, StepResult
  migrator.ts                             — Migrator (single instance, named pipelines)
  errors.ts                               — MigrationStepError
  snapshot-migrator.ts                    — SnapshotMigrator (version-aware runner)
  schema-migrator.ts                      — SchemaMigrator (version-aware runner)

  snapshot_migrations/
    snapshot-v1-to-v2.ts                  — adds mtime/size via stat()
    snapshot-v2-to-sharded.ts             — single JSON → sharded format

  schema_migrations/
    schema-v4-relativepath-keyword.ts     — keyword index on relativePath
    schema-v5-relativepath-text.ts        — text index on relativePath
    schema-v6-filter-field-indexes.ts     — keyword on language, fileExtension, chunkType
    schema-v7-sparse-config.ts            — enable sparse vectors on collection
    schema-v8-symbolid-text.ts            — text index on symbolId
    sparse-vector-rebuild.ts              — rebuild BM25 sparse vectors
```

### Framework Types

```typescript
// types.ts

/** Single migration class. One migration = one class = one file. */
interface Migration {
  readonly name: string;
  readonly version: number;
  apply(): Promise<StepResult>;
}

interface StepResult {
  applied: string[]; // what was done
}

interface MigrationSummary {
  pipeline: string;
  fromVersion: number;
  toVersion: number;
  steps: Array<{
    name: string;
    status: "applied" | "skipped";
    applied?: string[];
  }>;
}
```

### Migrator (single instance, named pipelines)

```typescript
// migrator.ts
type PipelineName = "snapshot" | "schema";

class Migrator {
  constructor(
    private readonly pipelines: Record<
      PipelineName,
      SnapshotMigrator | SchemaMigrator
    >,
  ) {}

  async run(pipeline: PipelineName): Promise<MigrationSummary>;
}
```

Routes to the appropriate `*Migrator`. Single `deps.migrator` in pipelines.

### Version-Aware Migrators

Each migrator reads version once, runs only applicable migrations:

```typescript
// snapshot-migrator.ts
class SnapshotMigrator {
  // detectFormat() → "v1" | "v2" | "sharded" | "none"
  // runs migrations where migration.version > detected format
  // v1→v2→sharded in sequence
}

// schema-migrator.ts
class SchemaMigrator {
  // getSchemaVersion() → number (reads SCHEMA_METADATA_ID once)
  // runs migrations where migration.version > currentVersion
  // stores new version once at the end
  // then runs sparse-vector-rebuild (independent version)
}
```

### Entry Points

```
ReindexPipeline.runMigrations():
  await this.deps.migrator.run('snapshot');
  await this.deps.migrator.run('schema');
```

### DIP for Dependencies

Migrations do not import from `adapters/` or `domains/`. Dependencies injected
via interfaces in `types.ts`:

```typescript
/** Filesystem operations for snapshot migrations. */
interface SnapshotStore {
  getFormat(): Promise<"v1" | "v2" | "sharded" | "none">;
  readV1(): Promise<{
    fileHashes: Record<string, string>;
    codebasePath: string;
  } | null>;
  readV2(): Promise<{
    fileMetadata: Record<string, FileMetadata>;
    codebasePath: string;
  } | null>;
  writeSharded(
    codebasePath: string,
    files: Map<string, FileMetadata>,
  ): Promise<void>;
  backup(path: string): Promise<void>;
  deleteOld(path: string): Promise<void>;
  statFile(path: string): Promise<{ mtimeMs: number; size: number } | null>;
}

/** Qdrant operations for schema migrations. */
interface IndexStore {
  getSchemaVersion(collection: string): Promise<number>;
  ensureIndex(
    collection: string,
    field: string,
    type: string,
  ): Promise<boolean>;
  storeSchemaVersion(
    collection: string,
    version: number,
    indexes: string[],
  ): Promise<void>;
  hasPayloadIndex(collection: string, field: string): Promise<boolean>;
  getCollectionInfo(
    collection: string,
  ): Promise<{ hybridEnabled: boolean; vectorSize: number }>;
  updateSparseConfig(collection: string): Promise<void>;
}

/** Sparse vector operations. */
interface SparseStore {
  getSparseVersion(collection: string): Promise<number>;
  rebuildSparseVectors(collection: string): Promise<void>;
  storeSparseVersion(collection: string, version: number): Promise<void>;
}
```

### Migration Classes

Each migration has `version` for ordering and `apply()` for execution:

**Snapshot migrations:**

| Class                 | Version | Logic                                                                        |
| --------------------- | ------- | ---------------------------------------------------------------------------- |
| `SnapshotV1ToV2`      | 2       | For each file in fileHashes: stat() → add mtime/size. Write v2 format.       |
| `SnapshotV2ToSharded` | 3       | Read v2 JSON → backup → write sharded (meta.json + shard files) → delete old |

**Schema migrations:**

| Class                      | Version | Logic                                                                                    |
| -------------------------- | ------- | ---------------------------------------------------------------------------------------- |
| `RelativePathKeywordIndex` | 4       | `ensureIndex("relativePath", "keyword")`                                                 |
| `RelativePathTextIndex`    | 5       | `ensureIndex("relativePath", "text")`                                                    |
| `FilterFieldIndexes`       | 6       | `ensureIndex` for language, fileExtension, chunkType                                     |
| `SparseConfig`             | 7       | Enable sparse vectors if `enableHybrid` and not already enabled                          |
| `SymbolIdTextIndex`        | 8       | `ensureIndex("symbolId", "text")`                                                        |
| `SparseVectorRebuild`      | —       | Independent versioning via `sparseVersion`. Rebuild BM25 vectors when tokenizer changes. |

### Wiring (composition root)

```typescript
const migrator = new Migrator({
  snapshot: new SnapshotMigrator(snapshotStoreAdapter, [
    new SnapshotV1ToV2(snapshotStoreAdapter),
    new SnapshotV2ToSharded(snapshotStoreAdapter),
  ]),
  schema: new SchemaMigrator(
    indexStoreAdapter,
    sparseStoreAdapter,
    { enableHybrid },
    [
      new RelativePathKeywordIndex(indexStoreAdapter),
      new RelativePathTextIndex(indexStoreAdapter),
      new FilterFieldIndexes(indexStoreAdapter),
      new SparseConfig(indexStoreAdapter, { enableHybrid }),
      new SymbolIdTextIndex(indexStoreAdapter),
    ],
  ),
});
```

### Logging

```
[Migration] snapshot: detecting format... v1
[Migration] snapshot: SnapshotV1ToV2 → applied (150 files upgraded)
[Migration] snapshot: SnapshotV2ToSharded → applied (150 files, 4 shards)
[Migration] schema: version 6 → running v7, v8
[Migration] schema: SparseConfig → applied (enabled sparse vectors)
[Migration] schema: SymbolIdTextIndex → applied (text index on symbolId)
[Migration] schema: SparseVectorRebuild → skipped (already v1)
```

### Error Handling

- `MigrationStepError extends TeaRagsError` with step name, pipeline, cause
- Migrator stops on first failure, returns summary with error
- Callers (ReindexPipeline) handle as before

## What Gets Deleted

| File                                  | What's removed                                    |
| ------------------------------------- | ------------------------------------------------- |
| `domains/ingest/sync/migration.ts`    | Entire file (`SnapshotMigrator` class)            |
| `domains/ingest/sync/synchronizer.ts` | `ensureSnapshotV2()` method                       |
| `adapters/qdrant/schema-migration.ts` | `SchemaManager` class (migration methods)         |
| `domains/ingest/reindexing.ts`        | `runMigrations()` inline calls                    |
| `domains/ingest/factory.ts`           | `createMigrator`, `createSchemaManager` factories |

## What Stays

- `SchemaManager.initializeSchema()` — not a migration, creates indexes for new
  collections. Moves to a standalone `SchemaInitializer` or stays as utility.
- `SchemaDriftMonitor` — runtime detection
- `ScrollRankStrategy.ensureIndexFn` — lazy runtime provisioning
- `StatsCache` — version check stays inline (discard + rebuild, not worth
  migrating)

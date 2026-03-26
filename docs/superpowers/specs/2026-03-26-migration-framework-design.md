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
| Stats cache version     | `infra/stats-cache.ts`                | infra    |

No shared interface, no unified logging, no discoverability. Adding a new
migration requires knowing which file in which layer to touch.

## Scope

**In scope:** reindex-time + stats-load-time migrations (explicit data format
upgrades).

**Out of scope:** runtime mechanisms that stay where they are:

- Lazy index creation for scroll rerank (`ScrollRankStrategy.ensureIndexFn`)
- Schema drift detection (`SchemaDriftMonitor`)

## Design

### Framework: `core/infra/migration/`

```typescript
// types.ts
interface MigrationStep {
  /** Human-readable step name for logging. */
  name: string;
  /** Check if migration is needed. */
  check(): Promise<boolean>;
  /** Apply migration. Only called if check() returned true. */
  apply(): Promise<StepResult>;
}

interface StepResult {
  applied: string[];
  skipped?: string[];
}

interface MigrationSummary {
  pipeline: string;
  steps: Array<{
    name: string;
    status: "applied" | "skipped" | "failed";
    applied?: string[];
    error?: string;
  }>;
}
```

### Migrator (single instance, named pipelines)

```typescript
// migrator.ts
type PipelineName = "snapshot" | "schema" | "stats-cache";

class Migrator {
  private pipelines: Map<PipelineName, MigrationStep[]>;

  constructor(pipelines: Record<PipelineName, MigrationStep[]>) {
    this.pipelines = new Map(Object.entries(pipelines));
  }

  async run(pipeline: PipelineName): Promise<MigrationSummary>;
  async check(pipeline: PipelineName): Promise<PendingMigration[]>;
}
```

`run()` executes steps sequentially, logs each step, stops on first failure.

### Pipelines and Steps

| Pipeline      | Steps (ordered)                       | Replaces                                                                          |
| ------------- | ------------------------------------- | --------------------------------------------------------------------------------- |
| `snapshot`    | `SnapshotFormatStep`                  | `FileSynchronizer.ensureSnapshotV2()` + `SnapshotMigrator`                        |
| `schema`      | `SchemaIndexStep`, `SparseVectorStep` | `SchemaManager.ensureCurrentSchema()`, `SchemaManager.checkSparseVectorVersion()` |
| `stats-cache` | `StatsCacheStep`                      | `StatsCache.load()` version discard logic                                         |

### Entry Points

```
ReindexPipeline.runMigrations():
  await this.deps.migrator.run('snapshot');
  await this.deps.migrator.run('schema');

StatsCache.load():
  await this.deps.migrator.run('stats-cache');
```

### DIP for Dependencies

Steps do not import from `adapters/` or `domains/`. Dependencies are injected
via interfaces defined in `infra/migration/ports.ts`:

```typescript
// ports.ts — interfaces that steps depend on

/** Snapshot storage operations for SnapshotFormatStep. */
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

/** Qdrant index operations for SchemaIndexStep. */
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

/** Sparse vector operations for SparseVectorStep. */
interface SparseStore {
  getSparseVersion(collection: string): Promise<number>;
  rebuildSparseVectors(collection: string): Promise<void>;
  storeSparseVersion(collection: string, version: number): Promise<void>;
}

/** Stats cache operations for StatsCacheStep. */
interface StatsCacheStore {
  getVersion(collection: string): Promise<number | null>;
  migrate(collection: string, fromVersion: number): Promise<void>;
}
```

Adapters implement these interfaces. Composition root wires implementations into
steps.

### Step Implementations

Each step lives in `infra/migration/steps/`:

```
infra/migration/
  types.ts              — MigrationStep, StepResult, MigrationSummary
  ports.ts              — SnapshotStore, IndexStore, SparseStore, StatsCacheStore
  migrator.ts           — Migrator class (pipeline runner)
  steps/
    snapshot-format.ts  — SnapshotFormatStep (v1→v2→sharded)
    schema-index.ts     — SchemaIndexStep (v4→v8 payload indexes)
    sparse-vector.ts    — SparseVectorStep (BM25 rebuild)
    stats-cache.ts      — StatsCacheStep (stats file version upgrade)
```

### SnapshotFormatStep

Merges two existing migrators into one step with internal state machine:

```
check format:
  "none"    → skip (no snapshot exists)
  "v1"      → stat files → add mtime/size → write sharded
  "v2"      → convert to sharded
  "sharded" → skip (already current)
```

### SchemaIndexStep

Sequential index creation (same logic as current `ensureCurrentSchema`):

```
get version → apply v4..v8 migrations → store version
```

Each version adds specific payload indexes. Idempotent — already-existing
indexes are skipped.

### SparseVectorStep

```
get sparse version → if outdated: rebuild all sparse vectors → store version
```

### StatsCacheStep

```
get file version → if outdated: transform data structure → write new version
  null (no file) → skip
  current version → skip
  old version → migrate fields/structure → save
```

### Wiring (composition root)

```typescript
// bootstrap/factory.ts or api/internal/composition.ts
const migrator = new Migrator({
  snapshot: [new SnapshotFormatStep(snapshotStoreAdapter)],
  schema: [
    new SchemaIndexStep(indexStoreAdapter, { enableHybrid }),
    new SparseVectorStep(sparseStoreAdapter, { enableHybrid }),
  ],
  "stats-cache": [new StatsCacheStep(statsCacheStoreAdapter)],
});
```

### Logging

`Migrator.run()` logs via existing `pipelineLog` pattern:

```
[Migration] snapshot: SnapshotFormatStep → applied (v1→sharded, 150 files)
[Migration] schema: SchemaIndexStep → applied (v6→v8: symbolId text index)
[Migration] schema: SparseVectorStep → skipped (already v2)
```

### Error Handling

- Steps throw typed errors from `infra/migration/errors.ts`
- `MigrationStepError extends TeaRagsError` with step name, pipeline, cause
- `Migrator.run()` catches, wraps in summary, re-throws
- Callers (ReindexPipeline, StatsCache) handle as before

## What Gets Deleted

| File                                  | What's removed                                |
| ------------------------------------- | --------------------------------------------- |
| `domains/ingest/sync/migration.ts`    | Entire file (`SnapshotMigrator` class)        |
| `domains/ingest/sync/synchronizer.ts` | `ensureSnapshotV2()` method                   |
| `adapters/qdrant/schema-migration.ts` | `SchemaManager` class (replaced by two steps) |
| `infra/stats-cache.ts`                | Version discard logic in `load()`             |
| `domains/ingest/reindexing.ts`        | `runMigrations()` inline calls                |

## What We Do NOT Change

- `SchemaDriftMonitor` — runtime detection, not a migration
- `ScrollRankStrategy.ensureIndexFn` — lazy runtime provisioning
- `StatsCache.save()/load()` — data flow unchanged, just version handling moves
- `ReindexPipeline` orchestration order — same sequence, cleaner API

/**
 * Migration ports.
 *
 * The migration pipelines live in the maintenance domain. The ingest pipeline
 * triggers them during a reindex and the DuckDB pool applies graph DDL when it
 * opens a collection — neither may import a sibling domain, so both depend on
 * these interfaces and the composition root wires the concretes. Same pattern
 * `contracts/types/footprint.ts` already uses for footprint stores.
 */

/** Which versioned pipeline to run. */
export type MigrationPipelineName = "schema" | "snapshot" | "sparse";

/** One pipeline run's outcome. Mirrors MigrationSummary in the maintenance domain. */
export interface MigrationRunSummary {
  pipeline: string;
  fromVersion: number;
  toVersion: number;
  steps: {
    name: string;
    status: "applied" | "skipped";
    applied?: string[];
  }[];
}

/** What the ingest reindex path needs from the migrator. */
export interface MigratorPort {
  run: (pipeline: MigrationPipelineName) => Promise<MigrationRunSummary>;
}

/**
 * The sharded-snapshot operations the snapshot migration steps need.
 *
 * The concrete `ShardedSnapshotManager` lives in the ingest domain (it owns the
 * on-disk snapshot format); the maintenance snapshot migration receives this
 * narrow view through an injected factory.
 */
export interface ShardedSnapshotAccess {
  save: (codebasePath: string, files: Map<string, SnapshotFileMetadata>) => Promise<void>;
  load: () => Promise<{ codebasePath: string; files: Map<string, SnapshotFileMetadata> } | null>;
}

/** Per-file snapshot record. Structurally mirrors ingest's FileMetadata. */
export interface SnapshotFileMetadata {
  mtime: number;
  size: number;
  hash: string;
}

/** Builds a {@link ShardedSnapshotAccess} bound to (snapshotDir, collectionName, shardCount). */
export type ShardedSnapshotAccessFactory = (
  snapshotDir: string,
  collectionName: string,
  shardCount: number,
) => ShardedSnapshotAccess;

/** The client surface the graph DDL runner needs. Mirrors MigrationCapableClient. */
export interface MigrationCapableGraphClient {
  exec: (sql: string) => Promise<void>;
  run: (sql: string, params?: unknown[]) => Promise<void>;
  queryAll: <T = Record<string, unknown>>(sql: string, params?: unknown[]) => Promise<T[]>;
}

/**
 * Applies pending graph DDL to a freshly opened DuckDB collection.
 *
 * Required (not optional) on the pool options: a missed call site must be a type
 * error, not a collection that silently opens without its schema.
 */
export type DatabaseMigrationApplier = (client: MigrationCapableGraphClient) => Promise<void>;

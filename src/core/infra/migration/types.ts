/**
 * Migration framework types.
 *
 * Migration = single versioned upgrade step (one class, one file).
 * MigrationRunner = version-aware pipeline that owns a set of migrations.
 * Migrator = top-level router dispatching run() to the correct runner.
 */

/** Single migration. One class = one file. */
export interface Migration {
  readonly name: string;
  readonly version: number;
  apply: () => Promise<StepResult>;
}

export interface StepResult {
  applied: string[];
}

/** Version-aware pipeline that runs a set of migrations. */
export interface MigrationRunner {
  getVersion: () => Promise<number>;
  setVersion: (version: number) => Promise<void>;
  getMigrations: () => Migration[];
}

export interface MigrationSummary {
  pipeline: string;
  fromVersion: number;
  toVersion: number;
  steps: {
    name: string;
    status: "applied" | "skipped";
    applied?: string[];
  }[];
}

/** DIP: filesystem operations for snapshot migrations. */
export interface SnapshotStore {
  getFormat: () => Promise<"v1" | "v2" | "sharded" | "none">;
  readV1: () => Promise<{ fileHashes: Record<string, string>; codebasePath: string } | null>;
  readV2: () => Promise<{
    fileMetadata: Record<string, { mtime: number; size: number; hash: string }>;
    codebasePath: string;
  } | null>;
  writeSharded: (
    codebasePath: string,
    files: Map<string, { mtime: number; size: number; hash: string }>,
  ) => Promise<void>;
  backup: () => Promise<void>;
  deleteOld: () => Promise<void>;
  statFile: (absolutePath: string) => Promise<{ mtimeMs: number; size: number } | null>;
}

/** DIP: Qdrant index operations for schema migrations. */
export interface IndexStore {
  getSchemaVersion: (collection: string) => Promise<number>;
  ensureIndex: (collection: string, field: string, type: string) => Promise<boolean>;
  storeSchemaVersion: (collection: string, version: number, indexes: string[]) => Promise<void>;
  hasPayloadIndex: (collection: string, field: string) => Promise<boolean>;
  getCollectionInfo: (collection: string) => Promise<{ hybridEnabled: boolean; vectorSize: number }>;
  updateSparseConfig: (collection: string) => Promise<void>;
}

/** DIP: Sparse vector operations. */
export interface SparseStore {
  getSparseVersion: (collection: string) => Promise<number>;
  rebuildSparseVectors: (collection: string) => Promise<void>;
  storeSparseVersion: (collection: string, version: number) => Promise<void>;
}

/** DIP: enrichedAt backfill operations for enrichment recovery migration. */
export interface EnrichmentStore {
  /** Check if migration already applied. */
  isMigrated: (collection: string) => Promise<boolean>;
  /** Scroll all non-metadata chunks with full payload. */
  scrollAllChunks: (
    collection: string,
  ) => Promise<{ id: string | number; payload: Record<string, unknown> }[]>;
  /** Batch set payload on multiple points. */
  batchSetPayload: (
    collection: string,
    operations: { payload: Record<string, unknown>; points: (string | number)[] }[],
  ) => Promise<void>;
  /** Mark migration as complete. */
  markMigrated: (collection: string) => Promise<void>;
}

/**
 * Footprint artifact store contracts.
 *
 * The maintenance footprint clones / tears down per-collection on-disk state
 * (sharded snapshots, the quarantine file). The concrete stores live in the
 * ingest domain; these interfaces plus injected factories let the footprint
 * artifacts operate on that state WITHOUT importing ingest directly — domains
 * stay mutually isolated and the composition root wires the concretes (DIP).
 */

import type { PhysicalCollectionName } from "./collection-identity.js";

/** Per-collection sharded-snapshot store the snapshot artifact clones / removes. */
export interface SnapshotArtifactStore {
  cloneTo: (targetLogicalName: string, targetPath: string) => Promise<void>;
  delete: () => Promise<void>;
}

/** Per-collection quarantine store the quarantine artifact clones / clears. */
export interface QuarantineArtifactStore {
  cloneTo: (targetLogicalName: string) => Promise<void>;
  clearAll: () => Promise<void>;
}

/**
 * The codegraph DuckDB surface the footprint saga drives.
 *
 * `GraphDbClientPool` satisfies it in the live app. The purge path deliberately
 * does NOT construct a pool: construction sweeps the shared `.spill` directory
 * on behalf of every project, which is not a purge's business. It passes the
 * file-only `CodegraphDbFiles` instead — same path layout, no client cache, no
 * side effects at construction.
 */
export interface CodegraphFootprintStore {
  cloneDatabase: (sourceCollection: PhysicalCollectionName, targetCollection: PhysicalCollectionName) => Promise<void>;
  removeCollection: (collectionName: PhysicalCollectionName) => Promise<boolean>;
  /** Every `<base>.duckdb` / `<base>_v<N>.duckdb` on disk, as collection names. */
  listCollectionDbNames: (baseCollectionName: string) => PhysicalCollectionName[];
}

/** The run holding a live indexing lock — enough for a teardown to say why it left the lock in place. */
export interface IndexingLockHolder {
  pid: number;
  hostname: string;
  operation: string;
}

/**
 * Outcome of tearing down a collection's indexing lock: there was none, a dead
 * run's lock was removed, or a live run's lock was left in place. `holder` is
 * absent when the live lock could not be parsed (its claimant is mid-write).
 */
export type IndexingLockRemovalOutcome =
  | { status: "absent" }
  | { status: "removed-stale" }
  | { status: "held-live"; holder?: IndexingLockHolder };

/** Per-collection indexing lock the indexing-lock artifact tears down. Never cloned. */
export interface IndexingLockArtifactStore {
  removeIfStale: () => Promise<IndexingLockRemovalOutcome>;
}

/** Builds an {@link IndexingLockArtifactStore} bound to (baseDir, logicalName). */
export type IndexingLockArtifactStoreFactory = (baseDir: string, logicalName: string) => IndexingLockArtifactStore;

/** Builds a {@link SnapshotArtifactStore} bound to (baseDir, logicalName). */
export type SnapshotArtifactStoreFactory = (baseDir: string, logicalName: string) => SnapshotArtifactStore;

/** Builds a {@link QuarantineArtifactStore} bound to (baseDir, logicalName). */
export type QuarantineArtifactStoreFactory = (baseDir: string, logicalName: string) => QuarantineArtifactStore;

/**
 * Footprint artifact store contracts.
 *
 * The maintenance footprint clones / tears down per-collection on-disk state
 * (sharded snapshots, the quarantine file). The concrete stores live in the
 * ingest domain; these interfaces plus injected factories let the footprint
 * artifacts operate on that state WITHOUT importing ingest directly — domains
 * stay mutually isolated and the composition root wires the concretes (DIP).
 */

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

/** Builds a {@link SnapshotArtifactStore} bound to (baseDir, logicalName). */
export type SnapshotArtifactStoreFactory = (baseDir: string, logicalName: string) => SnapshotArtifactStore;

/** Builds a {@link QuarantineArtifactStore} bound to (baseDir, logicalName). */
export type QuarantineArtifactStoreFactory = (baseDir: string, logicalName: string) => QuarantineArtifactStore;

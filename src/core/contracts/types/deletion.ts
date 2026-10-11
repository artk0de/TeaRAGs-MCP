/**
 * Per-path outcome of a deletion pass.
 *
 * sync/deletion builds it (`createDeletionOutcome`) and the ingest root's
 * `PartialDeletionError` carries it. The root is the domain's stable sink, so it
 * may not import the type back from `sync/deletion`; the interface lives here.
 *
 * Callers populate `failed` via markFailed or markAllFailed when the
 * underlying Qdrant operation reports (or behaves as) a partial or total
 * failure. Consumers (e.g. ReindexCoordinator in Phase 3) use `failed`
 * to decide which files must be excluded from subsequent upsert.
 */
export interface DeletionOutcome {
  readonly succeeded: Set<string>;
  readonly failed: Set<string>;
  chunksDeleted: number;
  markFailed: (path: string) => void;
  markAllFailed: () => void;
  isFullSuccess: () => boolean;
}

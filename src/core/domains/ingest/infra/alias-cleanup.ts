import type { QdrantManager } from "../../../adapters/qdrant/client.js";
import { isDebug } from "../pipeline/infra/runtime.js";

/**
 * Drops the per-version codegraph DuckDB file (and its WAL sidecar) for a
 * deleted orphan collection. Injected by the composition root from the codegraph
 * pool's `removeCollection`; omitted when codegraph is disabled. Keeps the ingest
 * domain free of any DuckDB-path knowledge — the pool owns path resolution.
 */
export type CodegraphDbRemover = (collectionName: string) => Promise<void>;

/**
 * Deletes versioned collections that are no longer pointed to by an alias.
 * Handles cleanup after crashes between alias switch and old collection deletion.
 *
 * When a `removeCodegraphDb` remover is supplied, each deleted orphan Qdrant
 * collection also has its per-version codegraph DuckDB file removed synchronously
 * — otherwise those files (`<collection>_vN.duckdb` + `.wal`) leak forever. The
 * codegraph cleanup is best-effort: a missing file is a no-op and any remover
 * failure is logged and swallowed so one bad orphan never aborts the sweep.
 *
 * @returns Number of orphaned collections deleted.
 */
export async function cleanupOrphanedVersions(
  qdrant: QdrantManager,
  collectionName: string,
  removeCodegraphDb?: CodegraphDbRemover,
): Promise<number> {
  const aliases = await qdrant.aliases.listAliases();
  const activeCollection = aliases.find((a) => a.aliasName === collectionName)?.collectionName;
  if (!activeCollection) return 0;

  const allCollections = await qdrant.listCollections();
  const orphans = allCollections.filter((c) => c.startsWith(`${collectionName}_v`) && c !== activeCollection);

  for (const orphan of orphans) {
    await qdrant.deleteCollection(orphan);
    if (removeCodegraphDb) {
      await removeCodegraphDb(orphan).catch((err) => {
        if (isDebug()) {
          console.error(`[AliasCleanup] codegraph DB cleanup failed for orphan ${orphan} (non-fatal):`, err);
        }
      });
    }
  }

  return orphans.length;
}

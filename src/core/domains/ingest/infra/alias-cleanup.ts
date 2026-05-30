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
 * Enumerates the versioned codegraph DB collection names on disk for a base
 * collection (every `<base>_v<N>.duckdb` file). Injected by the composition
 * root from the codegraph pool's `listCollectionDbNames`; omitted when
 * codegraph is disabled. Keeps the ingest domain free of any DuckDB-path
 * knowledge — the pool owns directory enumeration.
 */
export type CodegraphDbLister = (baseCollectionName: string) => string[];

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

/**
 * Sweeps ancient codegraph DuckDB files whose Qdrant collection no longer
 * exists. `cleanupOrphanedVersions` only sees codegraph DBs whose Qdrant
 * collection is a live orphan (it iterates `qdrant.listCollections()` and
 * deletes the matching codegraph DB alongside); a `<base>_v<N>.duckdb` left
 * behind after its Qdrant collection was already gone (e.g. an interrupted
 * earlier cleanup, or a pre-fix leak) is invisible to it and leaks forever.
 *
 * This sweep closes that gap: it enumerates the on-disk codegraph DBs for the
 * base via the injected `listCodegraphDbs`, then removes each one whose Qdrant
 * collection is absent AND which is not the active alias target. The active
 * target is never removed even if it is somehow missing from
 * `listCollections()` — deleting the live DB would break search. Best-effort,
 * non-fatal: a remover failure is logged and swallowed so one bad file never
 * aborts the sweep.
 *
 * @returns Number of codegraph DBs successfully removed.
 */
export async function sweepCodegraphOrphans(
  qdrant: QdrantManager,
  collectionName: string,
  listCodegraphDbs: CodegraphDbLister,
  removeCodegraphDb: CodegraphDbRemover,
): Promise<number> {
  const codegraphDbs = listCodegraphDbs(collectionName);
  if (codegraphDbs.length === 0) return 0;

  const aliases = await qdrant.aliases.listAliases();
  const activeCollection = aliases.find((a) => a.aliasName === collectionName)?.collectionName;
  const liveCollections = new Set(await qdrant.listCollections());

  let removed = 0;
  for (const db of codegraphDbs) {
    // Never delete the active alias target's DB, nor one still backed by a live
    // Qdrant collection.
    if (db === activeCollection || liveCollections.has(db)) continue;
    try {
      await removeCodegraphDb(db);
      removed++;
    } catch (err) {
      if (isDebug()) {
        console.error(`[AliasCleanup] codegraph orphan sweep failed for ${db} (non-fatal):`, err);
      }
    }
  }

  return removed;
}

import type { QdrantManager } from "../../../adapters/qdrant/client.js";
import { INDEXING_METADATA_ID } from "../../../contracts/constants.js";
import { isDebug } from "../../../infra/runtime.js";
import { isIndexingRunStale, parseMarkerPayload } from "../pipeline/index.js";

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
  const candidates = allCollections.filter((c) => c.startsWith(`${collectionName}_v`) && c !== activeCollection);

  // Not pointed at by the alias is NOT the same as abandoned. A force reindex
  // builds its next version off to the side and only switches the alias at the
  // end, so between those two moments its target looks exactly like an orphan.
  // Deleting it kills the run that owns it — the foreground reindex fails on its
  // next upload with "Collection … doesn't exist" while the run that deleted it
  // reports success (bd tea-rags-mcp-nrylk).
  const orphans: string[] = [];
  for (const candidate of candidates) {
    if (await isBuildInFlight(qdrant, candidate)) {
      if (isDebug()) {
        console.error(`[AliasCleanup] ${candidate} is being built by a live run — leaving it alone`);
      }
      continue;
    }
    orphans.push(candidate);
  }

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
 * Is a live indexing run building this collection right now?
 *
 * The in-progress marker and its heartbeat ARE the lease — `setupCollection`
 * writes the marker the moment it creates the versioned collection, and the run
 * refreshes the heartbeat throughout. So no new coordination mechanism is
 * needed; cleanup only has to read what indexing already publishes.
 *
 * A read failure answers "no". Cleanup is best-effort and its job is to reclaim
 * space — it must not start hoarding collections because one marker read
 * flaked. The cost of that choice is the pre-fix behaviour for that one
 * collection, which is strictly no worse than before.
 */
async function isBuildInFlight(qdrant: QdrantManager, collection: string): Promise<boolean> {
  try {
    const point = await qdrant.getPoint(collection, INDEXING_METADATA_ID);
    if (!point?.payload) return false;
    const marker = parseMarkerPayload(point.payload);
    return !marker.indexingComplete && !isIndexingRunStale(marker);
  } catch (err) {
    if (isDebug()) {
      console.error(`[AliasCleanup] could not read the indexing marker of ${collection} (treating as orphan):`, err);
    }
    return false;
  }
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

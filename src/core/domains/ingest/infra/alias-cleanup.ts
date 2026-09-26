import type { QdrantManager } from "../../../adapters/qdrant/client.js";
import type { PhysicalCollectionName } from "../../../contracts/types/collection-identity.js";
import { isDebug } from "../../../infra/runtime.js";
import { isCollectionBuildInFlight } from "./collection-build-lease.js";

/**
 * Drops the per-version codegraph DuckDB file (and its WAL sidecar) for a
 * deleted orphan collection. Injected by the composition root from the codegraph
 * pool's `removeCollection`; omitted when codegraph is disabled. Keeps the ingest
 * domain free of any DuckDB-path knowledge — the pool owns path resolution.
 */
export type CodegraphDbRemover = (physicalCollectionName: PhysicalCollectionName) => Promise<void>;

/**
 * Enumerates the versioned codegraph DB collection names on disk for a base
 * collection (every `<base>_v<N>.duckdb` file). Injected by the composition
 * root from the codegraph pool's `listCollectionGenerationNames` (databases AND
 * cross-pass input spills); omitted when
 * codegraph is disabled. Keeps the ingest domain free of any DuckDB-path
 * knowledge — the pool owns directory enumeration.
 */
export type CodegraphDbLister = (baseCollectionName: string) => PhysicalCollectionName[];

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
  const activePhysicalCollectionName = aliases.find((a) => a.aliasName === collectionName)?.collectionName;
  if (!activePhysicalCollectionName) return 0;

  const allPhysicalCollectionNames = await qdrant.listCollections();
  const candidatePhysicalCollectionNames = allPhysicalCollectionNames.filter(
    (physicalCollectionName) =>
      physicalCollectionName.startsWith(`${collectionName}_v`) &&
      physicalCollectionName !== activePhysicalCollectionName,
  );

  // Not pointed at by the alias is NOT the same as abandoned. A force reindex
  // builds its next version off to the side and only switches the alias at the
  // end, so between those two moments its target looks exactly like an orphan.
  // Deleting it kills the run that owns it — the foreground reindex fails on its
  // next upload with "Collection … doesn't exist" while the run that deleted it
  // reports success (bd tea-rags-mcp-nrylk).
  const orphanPhysicalCollectionNames: PhysicalCollectionName[] = [];
  for (const candidatePhysicalCollectionName of candidatePhysicalCollectionNames) {
    if (await isCollectionBuildInFlight(qdrant, candidatePhysicalCollectionName)) {
      if (isDebug()) {
        console.error(
          `[AliasCleanup] ${candidatePhysicalCollectionName} is being built by a live run — leaving it alone`,
        );
      }
      continue;
    }
    orphanPhysicalCollectionNames.push(candidatePhysicalCollectionName);
  }

  for (const orphanPhysicalCollectionName of orphanPhysicalCollectionNames) {
    await qdrant.deleteCollection(orphanPhysicalCollectionName);
    if (removeCodegraphDb) {
      await removeCodegraphDb(orphanPhysicalCollectionName).catch((err) => {
        if (isDebug()) {
          console.error(
            `[AliasCleanup] codegraph DB cleanup failed for orphan ${orphanPhysicalCollectionName} (non-fatal):`,
            err,
          );
        }
      });
    }
  }

  return orphanPhysicalCollectionNames.length;
}

/**
 * Drops the versioned collection a failed run was building — the eager
 * counterpart to `cleanupOrphanedVersions`.
 *
 * The sweep above is lazy: it reclaims leftovers at the START of the next run.
 * That is enough when another run actually comes, and nothing at all when it
 * does not. Two interrupted force reindexes on taxdome left `code_27622aef_v12`
 * (12830 points) sitting beside a healthy v11 with no automatic remediation —
 * `doctor` and `projects orphans` could name it, but only a manual
 * `delete_collection` removed it (bd tea-rags-mcp-8pymz). Discarding the build
 * when the run fails closes that window instead of deferring it.
 *
 * **It discards only what the base name is not currently serving.** One live
 * lookup decides that, and every case falls out of it:
 *
 * - alias → previous version, target is the new one: the rebuild never
 *   promoted, the old version still answers queries → discard.
 * - alias → the target itself: the swap already happened and this IS the live
 *   index. A later step failing (marker, snapshot, registry) must never cost
 *   the collection the swap just promoted → keep.
 * - no alias, but the base exists as a real unversioned collection: a migration
 *   that has not yet cut over, prior data intact → discard.
 * - neither: a FIRST-EVER index. Its half-built `_v1` holds every point the
 *   project has, and a user may want to inspect, resume, or diagnose it rather
 *   than find it silently gone → keep.
 *
 * Liveness is read from Qdrant at failure time rather than from a flag captured
 * at setup, because only the live state knows whether the alias swap got far
 * enough to matter — a setup-time `isFirstIndex` cannot. One source of truth,
 * so the two can never disagree about which collection is safe to delete.
 *
 * Never throws, and answers `false` whenever it cannot PROVE a fallback exists:
 * Qdrant being unreachable is a plausible reason the run failed at all, and a
 * leftover collection costs disk while a wrong delete costs the index. The next
 * run's sweep re-checks once Qdrant answers again.
 *
 * @returns true when the collection was discarded.
 */
export async function discardFailedCollectionBuild(
  qdrant: QdrantManager,
  collectionName: string,
  targetPhysicalCollectionName: PhysicalCollectionName,
  removeCodegraphDb?: CodegraphDbRemover,
): Promise<boolean> {
  try {
    // Not a versioned build off to the side — nothing safe to discard.
    if (targetPhysicalCollectionName === collectionName) return false;

    const aliases = await qdrant.aliases.listAliases();
    const activePhysicalCollectionName = aliases.find((a) => a.aliasName === collectionName)?.collectionName;

    if (activePhysicalCollectionName) {
      if (activePhysicalCollectionName === targetPhysicalCollectionName) return false;
    } else if (!(await qdrant.collectionExists(collectionName))) {
      return false;
    }

    await qdrant.deleteCollection(targetPhysicalCollectionName);
    if (removeCodegraphDb) {
      await removeCodegraphDb(targetPhysicalCollectionName).catch((err) => {
        if (isDebug()) {
          console.error(
            `[AliasCleanup] codegraph DB cleanup failed for discarded ${targetPhysicalCollectionName}:`,
            err,
          );
        }
      });
    }
    return true;
  } catch (err) {
    if (isDebug()) {
      console.error(
        `[AliasCleanup] could not discard the failed build ${targetPhysicalCollectionName} (non-fatal):`,
        err,
      );
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
  const codegraphPhysicalCollectionNames = listCodegraphDbs(collectionName);
  if (codegraphPhysicalCollectionNames.length === 0) return 0;

  const aliases = await qdrant.aliases.listAliases();
  const activePhysicalCollectionName = aliases.find((a) => a.aliasName === collectionName)?.collectionName;
  const livePhysicalCollectionNames = new Set(await qdrant.listCollections());

  let removed = 0;
  for (const physicalCollectionName of codegraphPhysicalCollectionNames) {
    // Never delete the active alias target's DB, nor one still backed by a live
    // Qdrant collection.
    if (
      physicalCollectionName === activePhysicalCollectionName ||
      livePhysicalCollectionNames.has(physicalCollectionName)
    ) {
      continue;
    }
    try {
      await removeCodegraphDb(physicalCollectionName);
      removed++;
    } catch (err) {
      if (isDebug()) {
        console.error(`[AliasCleanup] codegraph orphan sweep failed for ${physicalCollectionName} (non-fatal):`, err);
      }
    }
  }

  return removed;
}

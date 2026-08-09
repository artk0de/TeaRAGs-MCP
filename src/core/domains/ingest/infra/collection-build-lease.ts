/**
 * The lease a run holds on the versioned collection it is building.
 *
 * A force reindex builds `<base>_v<N>` off to the side and only switches the
 * alias at the very end, so for the whole run its target is indistinguishable
 * from an abandoned leftover by name alone. The in-progress indexing marker and
 * its heartbeat ARE the lease that tells them apart: the run publishes the
 * marker the instant it creates the collection and refreshes the heartbeat
 * throughout.
 *
 * Two readers need that answer and must agree on it — `alias-cleanup` before it
 * reaps orphans, and the indexing pipeline before it takes a version number —
 * so the predicate lives here rather than in either caller.
 */

import type { QdrantManager } from "../../../adapters/qdrant/client.js";
import { CollectionAlreadyExistsError } from "../../../adapters/qdrant/errors.js";
import { INDEXING_METADATA_ID } from "../../../contracts/constants.js";
import { isDebug } from "../../../infra/runtime.js";
import { VersionedCollectionClaimError } from "../errors.js";
import { isIndexingRunStale, parseMarkerPayload } from "../pipeline/index.js";

/**
 * Is a live indexing run building this collection right now?
 *
 * No new coordination mechanism is involved: the lease already exists and this
 * only reads what indexing already publishes.
 *
 * A read failure answers "no". Callers use this to decide whether they may
 * reclaim a collection, and hoarding collections because one marker read flaked
 * is worse than the behaviour that preceded the lease being read at all.
 */
export async function isCollectionBuildInFlight(qdrant: QdrantManager, collection: string): Promise<boolean> {
  try {
    const point = await qdrant.getPoint(collection, INDEXING_METADATA_ID);
    if (!point?.payload) return false;
    const marker = parseMarkerPayload(point.payload);
    return !marker.indexingComplete && !isIndexingRunStale(marker);
  } catch (err) {
    if (isDebug()) {
      console.error(
        `[CollectionBuildLease] could not read the indexing marker of ${collection} (treating as dead):`,
        err,
      );
    }
    return false;
  }
}

/**
 * How many consecutive version numbers a run will try before giving up.
 *
 * Each step past the computed version means another live build on the same
 * project. More than a handful of those is not contention, it is a bug or a
 * pathological pile-up of background runs, and walking Qdrant forever hides it.
 */
export const VERSION_CLAIM_ATTEMPT_LIMIT = 16;

/** The versioned collection a run took, and the number it ended up with. */
export interface ClaimedCollectionVersion {
  collectionName: string;
  version: number;
}

/**
 * Take a versioned collection for this run, starting at the computed version
 * and advancing until one is actually free.
 *
 * `computeNewVersion` derives the next version from the alias target plus the
 * collections Qdrant reported a moment ago, so two force runs that start close
 * together compute the SAME number. Whoever gets there second must not treat
 * the first one's freshly created, actively filling collection as a leftover to
 * be cleared out of the way — that kills the run that owns it, which is the
 * defect `cleanupOrphanedVersions` was already taught to avoid on its own
 * branch (bd tea-rags-mcp-nrylk).
 *
 * So a candidate is skipped when the lease says a live run holds it, and
 * reclaimed only when the same lease says nobody does — one notion of liveness,
 * shared with cleanup, never a second one. Genuine crash leftovers are still
 * deleted and their number reused.
 *
 * The version check cannot be atomic — Qdrant offers no compare-and-set over
 * "does this collection exist" — so `createLeasedCollection` is the arbiter of
 * last resort: a `CollectionAlreadyExistsError` from it means another run won
 * this number in the gap, and this one advances instead of failing.
 *
 * @param createLeasedCollection creates the collection AND publishes its
 *   in-progress marker, in that order and with nothing in between. Publishing
 *   the lease late leaves a window in which no other run can see this build is
 *   alive.
 */
export async function claimVersionedCollection(args: {
  qdrant: QdrantManager;
  baseCollectionName: string;
  firstVersion: number;
  createLeasedCollection: (versionedName: string) => Promise<void>;
}): Promise<ClaimedCollectionVersion> {
  const { qdrant, baseCollectionName, firstVersion, createLeasedCollection } = args;

  for (let version = firstVersion; version < firstVersion + VERSION_CLAIM_ATTEMPT_LIMIT; version++) {
    const versionedName = `${baseCollectionName}_v${version}`;

    if (await qdrant.collectionExists(versionedName)) {
      if (await isCollectionBuildInFlight(qdrant, versionedName)) {
        if (isDebug()) {
          console.error(
            `[CollectionBuildLease] ${versionedName} is being built by a live run — trying the next version`,
          );
        }
        continue;
      }
      // Nobody holds the lease: a crashed run's leftover, or a completed build
      // the alias has moved off. Reclaim the number rather than climb past it.
      if (isDebug()) {
        console.error(`[CollectionBuildLease] ${versionedName} is dead (no live lease) — reclaiming it`);
      }
      await qdrant.deleteCollection(versionedName);
    }

    try {
      await createLeasedCollection(versionedName);
      return { collectionName: versionedName, version };
    } catch (err) {
      if (!(err instanceof CollectionAlreadyExistsError)) throw err;
      if (isDebug()) {
        console.error(`[CollectionBuildLease] lost the create race for ${versionedName} — trying the next version`);
      }
    }
  }

  throw new VersionedCollectionClaimError(baseCollectionName, firstVersion, VERSION_CLAIM_ATTEMPT_LIMIT);
}

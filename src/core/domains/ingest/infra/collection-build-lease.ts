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
import {
  indexingRunHeartbeatAt,
  isEnrichmentRunLive,
  isIndexingRunStale,
  parseMarkerPayload,
  type IndexingMarkerPayload,
} from "../pipeline/index.js";

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
  const marker = await readIndexingMarker(qdrant, collection);
  return marker !== undefined && isBuildLive(marker, Date.now(), Number.NEGATIVE_INFINITY);
}

/**
 * Is ANY indexing of this collection in flight — a build publishing a fresh
 * indexing marker, or a background enrichment run the `_run` pointer names that
 * has not reached its terminal markers (bd tea-rags-mcp-62pgi)?
 *
 * The same lease as `isCollectionBuildInFlight`, widened by the two places a run
 * can be invisible from the served collection alone: a force build fills a
 * `<collection>_v<N>` off to the side until it switches the alias, and an
 * incremental run's enrichment writes no indexing marker at all, only `_run`.
 * Staleness is each marker's own: a crashed run stops being "in flight" when its
 * evidence ages out, so it never locks the project.
 *
 * `ownRunsSettledAt` (epoch ms) discounts evidence stamped at or before it — the
 * caller's own operation on this collection wrote that and has since ended, so a
 * retry after a failed run is not refused on its dead heartbeat. Read failures
 * answer "no", for the same reason as above.
 */
export async function isCollectionIndexingInFlight(
  qdrant: QdrantManager,
  collection: string,
  options: { ownRunsSettledAt?: number; now?: number } = {},
): Promise<boolean> {
  const now = options.now ?? Date.now();
  const evidenceAfter = options.ownRunsSettledAt ?? Number.NEGATIVE_INFINITY;

  const served = await readIndexingMarker(qdrant, collection);
  if (served && isBuildLive(served, now, evidenceAfter)) return true;
  if (served?.enrichment && isEnrichmentRunLive(served.enrichment, { now, progressAfter: evidenceAfter })) {
    return true;
  }

  for (const version of await listVersionsOf(qdrant, collection)) {
    const marker = await readIndexingMarker(qdrant, version);
    if (marker && isBuildLive(marker, now, evidenceAfter)) return true;
  }
  return false;
}

function isBuildLive(marker: IndexingMarkerPayload, now: number, evidenceAfter: number): boolean {
  if (marker.indexingComplete || isIndexingRunStale(marker, now)) return false;
  return (indexingRunHeartbeatAt(marker) ?? Number.NEGATIVE_INFINITY) > evidenceAfter;
}

async function readIndexingMarker(
  qdrant: QdrantManager,
  collection: string,
): Promise<IndexingMarkerPayload | undefined> {
  try {
    const point = await qdrant.getPoint(collection, INDEXING_METADATA_ID);
    return point?.payload ? parseMarkerPayload(point.payload) : undefined;
  } catch (err) {
    if (isDebug()) {
      console.error(
        `[CollectionBuildLease] could not read the indexing marker of ${collection} (treating as dead):`,
        err,
      );
    }
    return undefined;
  }
}

/** Every `<collection>_v<N>` Qdrant reports — the builds a force reindex fills off to the side. */
async function listVersionsOf(qdrant: QdrantManager, collection: string): Promise<string[]> {
  try {
    const prefix = `${collection}_v`;
    return (await qdrant.listCollections()).filter(
      (name) => name.startsWith(prefix) && /^\d+$/.test(name.slice(prefix.length)),
    );
  } catch {
    return [];
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

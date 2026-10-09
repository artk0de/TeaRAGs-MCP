/**
 * The ONE owner of "give every point that has a `relativePath` its
 * keyword-indexed twin `relativePathExact`" (bd tea-rags-mcp-ejio7; contract
 * `contracts/relative-path-exact.ts`) — and of COUNTING the points that still
 * lack it. Two callers share it: the v20 schema migration
 * (`schema-v20-relative-path-exact-keyword`), which backfills a collection
 * once, and `RelativePathExactCapability`, which heals the points a build
 * OLDER than the twin wrote into a collection already stamped v20 before it
 * lets a membership filter name the key.
 *
 * Why counting and walking are split: the missing-twin filter is an ABSENCE
 * condition, and absence conditions over-admit right after a `set_payload`
 * sweep (the Qdrant behaviour is stated once, in the `adapters/qdrant`
 * navigator). So the filter only nominates CANDIDATES; the count that decides
 * whether any point is missing uses presence conditions alone
 * ({@link probeRelativePathExactPresence}), and the walk re-checks every
 * candidate's live payload before it writes ({@link backfillRelativePathExact}).
 *
 * - **Never reads `content`.** The scroll asks for `relativePath` and the twin.
 * - **Paginated, never one capped read** — a capped read would leave a large
 *   collection half-done.
 * - **Idempotent and resumable.** A candidate whose live payload already
 *   carries the right twin is skipped, so a re-run writes exactly what an
 *   interrupted run left, and a run over a healed collection writes nothing —
 *   even while dead versions still make the filter nominate every point.
 * - **Skips points without a path** (schema metadata, indexing marker,
 *   documents) and empty paths — the twin of nothing matches no membership
 *   filter anyway.
 */

import { RELATIVE_PATH_EXACT_KEY } from "../../contracts/relative-path-exact.js";

/**
 * CANDIDATES for the backfill: points that have a `relativePath` and (per the
 * index) lack its keyword twin. A superset of the truly missing points while
 * unvacuumed dead versions exist — never use it to COUNT missing points.
 */
export const RELATIVE_PATH_EXACT_MISSING_FILTER: Record<string, unknown> = {
  must: [{ is_empty: { key: RELATIVE_PATH_EXACT_KEY } }],
  must_not: [{ is_empty: { key: "relativePath" } }],
};

/** Points that carry a `relativePath` — a presence condition. */
const HAS_RELATIVE_PATH_FILTER: Record<string, unknown> = {
  must_not: [{ is_empty: { key: "relativePath" } }],
};

/** Points that carry both a `relativePath` and its twin — presence conditions only. */
const HAS_RELATIVE_PATH_AND_TWIN_FILTER: Record<string, unknown> = {
  must_not: [{ is_empty: { key: "relativePath" } }, { is_empty: { key: RELATIVE_PATH_EXACT_KEY } }],
};

/**
 * Points per backfill page. Each page is one scroll carrying only
 * `relativePath` and its twin, and its writes are one `batchSetPayload` — one
 * operation per distinct path — so a page bounds both the read and the write
 * side.
 */
const BACKFILL_PAGE_SIZE = 1_000;

/** The two store operations the backfill needs; the migration's `IndexStore` and `QdrantManager` both provide them. */
export interface RelativePathExactBackfillStore {
  scrollPayloadPages: (
    collection: string,
    request: { payloadInclude: string[]; filter?: Record<string, unknown>; pageSize?: number },
  ) => AsyncIterable<{ id: string | number; payload: Record<string, unknown> }[]>;
  batchSetPayload: (
    collection: string,
    operations: { payload: Record<string, unknown>; points: (string | number)[] }[],
  ) => Promise<void>;
}

/** The backfill store plus the exact count the missing-twin probe needs. */
export interface RelativePathExactProbeStore extends RelativePathExactBackfillStore {
  /** EXACT number of points `filter` admits (every point without one). */
  countPoints: (collection: string, filter?: Record<string, unknown>) => Promise<number>;
}

/** The exact LIVE presence counts of `relativePath` and its twin on one collection. */
export interface RelativePathExactPresence {
  /** Points that carry a `relativePath`. */
  withPath: number;
  /** Points that carry both a `relativePath` and its twin — the live twin count the keyword index is judged against. */
  withBoth: number;
  /** `withPath − withBoth`, clamped at 0: points that still lack the twin. */
  missing: number;
}

/**
 * The live presence counts of `relativePath` and its twin, from two exact
 * PRESENCE counts; `missing` is `|has path| − |has path ∧ has twin|`.
 *
 * Neither count names an absence condition, so dead versions cannot inflate
 * the answer: `must_not is_empty` admits a point only by what its live payload
 * CARRIES. Measured on `code_8b243ffe_v71` (46 097 live points, 29 104
 * unvacuumed dead versions — all of which carry `relativePath`): `has path`
 * counted 46 095 in 4 ms and `has path ∧ has twin` 46 095 in ~415 ms, where
 * the `is_empty`-twin form counted 29 104 "missing". The cheaper of the
 * measured correct formulations — `total − |twin MatchExcept| − |is_empty path|`
 * cost ~635 ms and leans on an absence condition (`is_empty relativePath`) that
 * a re-upserted path-less point (schema metadata, marker) could inflate,
 * understating what is missing.
 *
 * The two counts run concurrently; a writer landing between them can skew the
 * difference either way by what it wrote, and the answer is clamped at 0. An
 * empty-string path counts as having a path but is never twinned (see the
 * module docblock), so such a point reads as missing on every probe — none
 * exist in practice (0 on the self-index).
 */
export async function probeRelativePathExactPresence(
  store: RelativePathExactProbeStore,
  collection: string,
): Promise<RelativePathExactPresence> {
  const [withPath, withBoth] = await Promise.all([
    store.countPoints(collection, HAS_RELATIVE_PATH_FILTER),
    store.countPoints(collection, HAS_RELATIVE_PATH_AND_TWIN_FILTER),
  ]);
  return { withPath, withBoth, missing: Math.max(0, withPath - withBoth) };
}

/**
 * Write the twin onto every point whose LIVE payload lacks it (or carries a
 * different value), grouped by path; returns how many points were written.
 *
 * Candidates come from {@link RELATIVE_PATH_EXACT_MISSING_FILTER}; each one's
 * live payload is checked before it is written, so a false candidate (a point
 * nominated by its unvacuumed dead version) costs a read and never a write —
 * a rewrite would only leave another dead version behind. With `missing`
 * known (the probe's count), the walk stops once that many points are written
 * instead of reading every remaining false candidate.
 */
export async function backfillRelativePathExact(
  store: RelativePathExactBackfillStore,
  collection: string,
  options: { missing?: number } = {},
): Promise<number> {
  let backfilled = 0;
  const pages = store.scrollPayloadPages(collection, {
    payloadInclude: ["relativePath", RELATIVE_PATH_EXACT_KEY],
    filter: RELATIVE_PATH_EXACT_MISSING_FILTER,
    pageSize: BACKFILL_PAGE_SIZE,
  });
  for await (const page of pages) {
    const idsByPath = new Map<string, (string | number)[]>();
    for (const { id, payload } of page) {
      const path = payload.relativePath;
      if (typeof path !== "string" || path.length === 0) continue;
      if (payload[RELATIVE_PATH_EXACT_KEY] === path) continue;
      const ids = idsByPath.get(path);
      if (ids) ids.push(id);
      else idsByPath.set(path, [id]);
    }
    if (idsByPath.size > 0) {
      await store.batchSetPayload(
        collection,
        [...idsByPath].map(([path, points]) => ({ payload: { [RELATIVE_PATH_EXACT_KEY]: path }, points })),
      );
      for (const ids of idsByPath.values()) backfilled += ids.length;
    }
    if (options.missing !== undefined && backfilled >= options.missing) break;
  }
  return backfilled;
}

/** The two index operations the completeness check needs; `QdrantManager` and the migration's `IndexStore` both provide them. */
export interface RelativePathExactIndexStore {
  /** Every payload field index with its indexed-point count; a read failure propagates. */
  listPayloadIndexes: (collection: string) => Promise<{ field: string; points: number }[]>;
  /** Issue the keyword index creation for `field` even when an index already exists (idempotent on Qdrant), waited. */
  recreateKeywordIndex: (collection: string, field: string) => Promise<void>;
}

/**
 * Whether the keyword index on `relativePathExact` covers every point — the
 * ONE predicate of that, from a `payload_schema` listing: the index exists and
 * its `points` is not below `liveTwinCount`, the EXACT number of live points
 * that carry the twin (`RelativePathExactPresence#withBoth`, plus any point
 * the caller just healed).
 *
 * Why `payload_schema`'s `relativePath.points` is NOT a valid reference: it
 * counts unvacuumed dead record versions, and the dead versions written before
 * the backfill carry `relativePath` but never the twin, so it stays above the
 * twin's count on a fully indexed collection until a vacuum. Measured on
 * `code_8b243ffe` (Qdrant 1.18.2): `relativePathExact.points` 46 107 against
 * `relativePath.points` 75 211 (29 104 dead pre-backfill versions) with exactly
 * 46 107 live twins — complete, yet judged incomplete, so the index was
 * re-created on every refresh. The live presence count has no such inflation.
 * A genuinely short index (an index created while the optimizer rebuilt
 * segments missed two of four; `relativePathExact.points` 35 135, every keyword
 * filter then full-scanned, ~400 ms for one path) reads below it.
 */
export function isRelativePathExactIndexComplete(
  indexes: { field: string; points: number }[],
  liveTwinCount: number,
): boolean {
  const twin = indexes.find((index) => index.field === RELATIVE_PATH_EXACT_KEY);
  return twin !== undefined && twin.points >= liveTwinCount;
}

/**
 * Make the `relativePathExact` keyword index cover every point; true when it
 * does. An incomplete or absent index is re-created once (a forced
 * `PUT /index`, which Qdrant treats as idempotent — measured 0.6 s — and which
 * indexes every segment, where the first creation raced the optimizer) and
 * re-read; still incomplete answers false. `liveTwinCount` is the live number
 * of points carrying the twin, as {@link isRelativePathExactIndexComplete}
 * takes it. Store failures propagate: the gate turns them into a no, the
 * migration into a retry.
 */
export async function ensureRelativePathExactIndexComplete(
  store: RelativePathExactIndexStore,
  collection: string,
  liveTwinCount: number,
): Promise<boolean> {
  if (isRelativePathExactIndexComplete(await store.listPayloadIndexes(collection), liveTwinCount)) return true;
  await store.recreateKeywordIndex(collection, RELATIVE_PATH_EXACT_KEY);
  return isRelativePathExactIndexComplete(await store.listPayloadIndexes(collection), liveTwinCount);
}

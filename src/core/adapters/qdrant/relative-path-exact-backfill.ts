/**
 * The ONE owner of "give every point that has a `relativePath` its
 * keyword-indexed twin `relativePathExact`" (bd tea-rags-mcp-ejio7; contract
 * `contracts/relative-path-exact.ts`). Two callers share it: the v20 schema
 * migration (`schema-v20-relative-path-exact-keyword`), which backfills a
 * collection once, and `RelativePathExactCapability`, which heals the points a
 * build OLDER than the twin wrote into a collection already stamped v20 before
 * it lets a membership filter name the key.
 *
 * - **Never reads `content`.** The scroll asks for `relativePath` alone.
 * - **Paginated, never one capped read** — a capped read would leave a large
 *   collection half-done.
 * - **Idempotent and resumable.** The filter admits only points still lacking
 *   the twin, so a re-run writes exactly what an interrupted run left, and a
 *   run over a healed collection writes nothing.
 * - **Skips points without a path** (schema metadata, indexing marker,
 *   documents) and empty paths — the twin of nothing matches no membership
 *   filter anyway.
 */

import { RELATIVE_PATH_EXACT_KEY } from "../../contracts/relative-path-exact.js";

/** Points that have a `relativePath` and still lack its keyword twin. */
export const RELATIVE_PATH_EXACT_MISSING_FILTER: Record<string, unknown> = {
  must: [{ is_empty: { key: RELATIVE_PATH_EXACT_KEY } }],
  must_not: [{ is_empty: { key: "relativePath" } }],
};

/**
 * Points per backfill page. Each page is one scroll carrying only
 * `relativePath`, and its writes are one `batchSetPayload` — one operation per
 * distinct path — so a page bounds both the read and the write side.
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

/**
 * Whether any point has a path but lacks the twin — one scroll of limit 1
 * with {@link RELATIVE_PATH_EXACT_MISSING_FILTER}, stopped after its first page.
 */
export async function hasPointsMissingRelativePathExact(
  store: RelativePathExactBackfillStore,
  collection: string,
): Promise<boolean> {
  const pages = store.scrollPayloadPages(collection, {
    // One short key rather than none: the scroller drops a point whose
    // payload comes back null.
    payloadInclude: ["relativePath"],
    filter: RELATIVE_PATH_EXACT_MISSING_FILTER,
    pageSize: 1,
  });
  for await (const page of pages) {
    if (page.length > 0) return true;
  }
  return false;
}

/** Write the twin onto every point lacking it, grouped by path; returns how many points were written. */
export async function backfillRelativePathExact(
  store: RelativePathExactBackfillStore,
  collection: string,
): Promise<number> {
  let backfilled = 0;
  const pages = store.scrollPayloadPages(collection, {
    payloadInclude: ["relativePath"],
    filter: RELATIVE_PATH_EXACT_MISSING_FILTER,
    pageSize: BACKFILL_PAGE_SIZE,
  });
  for await (const page of pages) {
    const idsByPath = new Map<string, (string | number)[]>();
    for (const { id, payload } of page) {
      const path = payload.relativePath;
      if (typeof path !== "string" || path.length === 0) continue;
      const ids = idsByPath.get(path);
      if (ids) ids.push(id);
      else idsByPath.set(path, [id]);
    }
    if (idsByPath.size === 0) continue;
    await store.batchSetPayload(
      collection,
      [...idsByPath].map(([path, points]) => ({ payload: { [RELATIVE_PATH_EXACT_KEY]: path }, points })),
    );
    for (const ids of idsByPath.values()) backfilled += ids.length;
  }
  return backfilled;
}

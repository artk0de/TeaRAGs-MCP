import {
  RELATIVE_PATH_EXACT_KEY,
  RELATIVE_PATH_EXACT_SCHEMA_VERSION,
} from "../../../../contracts/relative-path-exact.js";
import type { IndexStore, Migration, StepResult } from "../types.js";

type V20Store = IndexStore & Required<Pick<IndexStore, "scrollPayloadPages" | "batchSetPayload">>;

/**
 * Points per backfill page. Each page is one scroll carrying only
 * `relativePath`, and its writes are one `batchSetPayload` — one operation per
 * distinct path, which the adapter sends in requests of 100 operations — so a
 * page bounds both the read and the write side of a step.
 */
const BACKFILL_PAGE_SIZE = 1_000;

/** Points that have a `relativePath` and still lack its keyword twin. */
const MISSING_TWIN_FILTER = {
  must: [{ is_empty: { key: RELATIVE_PATH_EXACT_KEY } }],
  must_not: [{ is_empty: { key: "relativePath" } }],
};

/**
 * Give every existing point the keyword-indexed twin of `relativePath` (bd
 * tea-rags-mcp-ejio7; contract `contracts/relative-path-exact.ts`), then index
 * it.
 *
 * Path-membership consumers switch to one keyword MatchAny only once the
 * collection is stamped at this version (the gate,
 * `adapters/qdrant/relative-path-exact-capability.ts`), and the pipeline stamps
 * only after `apply()` returned — so the stamp is the claim "every point that
 * has a path carries the twin". The stamp is a waited upsert, and Qdrant
 * applies updates in submission order, so it also lands after every queued
 * `set_payload` below is visible.
 *
 * - **Never reads `content`.** The scroll asks for `relativePath` alone; a
 *   150k-point collection is read at a few dozen bytes per point.
 * - **Paginated, never one capped read.** `scrollAllPayload` stops at 10,000
 *   points; a large collection would be left half-done and still stamped.
 * - **Idempotent and resumable.** The scroll admits only points that still lack
 *   the twin, so a re-run after a crash writes exactly what the first run left,
 *   and a run over a finished collection writes nothing. `ensureIndex` checks
 *   for the index first.
 * - **Skips points without a path** — the schema metadata point, the indexing
 *   marker, documents; an empty path is skipped too, since the twin of nothing
 *   matches no membership filter anyway.
 *
 * Backfill first, index second: the index is built once over the backfilled
 * values rather than updated per write. The order is not load-bearing for
 * correctness — the gate reads the stamp, not the index.
 */
export class SchemaV20RelativePathExactKeyword implements Migration {
  readonly name = "schema-v20-relative-path-exact-keyword";
  readonly version = RELATIVE_PATH_EXACT_SCHEMA_VERSION;

  constructor(
    private readonly collection: string,
    private readonly store: V20Store,
  ) {}

  async apply(): Promise<StepResult> {
    let backfilled = 0;
    const pages = this.store.scrollPayloadPages(this.collection, {
      payloadInclude: ["relativePath"],
      filter: MISSING_TWIN_FILTER,
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
      await this.store.batchSetPayload(
        this.collection,
        [...idsByPath].map(([path, points]) => ({ payload: { [RELATIVE_PATH_EXACT_KEY]: path }, points })),
      );
      for (const ids of idsByPath.values()) backfilled += ids.length;
    }

    await this.store.ensureIndex(this.collection, RELATIVE_PATH_EXACT_KEY, "keyword");
    return {
      applied: [`${RELATIVE_PATH_EXACT_KEY} backfilled on ${backfilled} points`, `${RELATIVE_PATH_EXACT_KEY}:keyword`],
    };
  }
}

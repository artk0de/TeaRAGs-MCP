/**
 * The sparse floor (bd tea-rags-mcp-xi2r9.4): hybrid_search answers for the
 * working tree. The Qdrant request leaves out the base rows of every file the
 * tree changed or deleted; the tree's rows of those files are scored here, on
 * the legs that need no dense vector, and fused into the base page with the
 * arithmetic Qdrant's server-side RRF applies to the base rows.
 *
 *   - sparse leg: dot product of the query's BM25 vector with the row's, the
 *     vector ingest stores for the chunk (`generateSparseVector(content)` in
 *     `ChunkPipeline`). Qdrant's `modifier: "idf"` has no collection statistics
 *     here, so the local leg ranks by TF overlap alone — it only ORDERS rows
 *     within this leg, and RRF reads nothing but the order.
 *   - identity leg: rows the identity filter admits — the very filter
 *     `buildSymbolIdentityFilter` hands Qdrant — ordered by the sparse score,
 *     since the dense ordering that leg uses server-side is not available
 *     until the dense floor.
 *
 * Rows ranking on neither leg are not candidates, as a point no prefetch
 * returned is not one for Qdrant. The dense leg is skipped (WTO-5).
 *
 * Per-query cost must not grow with the delta (bd tea-rags-mcp-xi2r9, live
 * probe P2-6 — 159 touched files: hybrid 365 ms against semantic 40 ms):
 *
 *   - a row's BM25 vector is computed once per row, not once per query
 *     (`rowSparseVectors`);
 *   - the base rows of touched files leave the Qdrant request as ONE `has_id`
 *     condition over their point ids ({@link WorkingTreeTouchedBaseIds},
 *     {@link excludeWorkingTreeBaseIds}). An exclusion by path is checked per
 *     candidate against `relativePath`, whose index is `text`: measured on the
 *     live self-index, the `should` of text+value pairs cost 131 ms at 60
 *     touched paths and 280 ms at 159, a bare `match.any` 311 / 207 ms (and it
 *     is banned on that key, `text-indexed-exact.ts`). `has_id` is answered by
 *     Qdrant's id tracker: 5 / 8 ms. The ids come from POSITIVE per-path
 *     scrolls, which the text index does serve (12 / 160 ms), once per touched
 *     set and index revision.
 */

import type { QdrantManager } from "../../../adapters/qdrant/client.js";
import { payloadMatchesFilter } from "../../../adapters/qdrant/filters/payload-match.js";
import { exactMatchOnTextIndexed } from "../../../adapters/qdrant/filters/text-indexed-exact.js";
import { generateSparseVector } from "../../../adapters/qdrant/sparse.js";
import type { SparseVector } from "../../../adapters/qdrant/types.js";
import type { ScrollChunk } from "../chunk-grouping/types.js";
import type { ExploreResult } from "../strategies/types.js";

/**
 * The `k` of Qdrant's Reciprocal Rank Fusion. `QdrantSearchExecutor#hybridSearch`
 * sends plain `{ fusion: "rrf" }` (no `rrf.k`), so the server default applies:
 * `pub const DEFAULT_RRF_K: usize = 2;` in qdrant/qdrant
 * `lib/segment/src/common/reciprocal_rank_fusion.rs`, where a point at
 * 0-based `position` contributes `1 / ((position + 1) / weight + k - 1)` —
 * `1 / (position + k)` at the default weight 1.
 */
export const QDRANT_DEFAULT_RRF_K = 2;

/** One leg's contribution for a point at 0-based `position` (unweighted RRF). */
function rrfContribution(position: number): number {
  return 1 / (position + QDRANT_DEFAULT_RRF_K);
}

/**
 * `filter` with the given base points excluded by ONE `has_id` condition — the
 * same filter otherwise, so `fetchPathPatternMatches` and the identity prefetch
 * see the request they always did. No ids (every touched file is new to the
 * index) → the filter itself, untouched: there is nothing to exclude.
 */
export function excludeWorkingTreeBaseIds(
  filter: Record<string, unknown> | undefined,
  baseIds: readonly (string | number)[],
): Record<string, unknown> | undefined {
  if (baseIds.length === 0) return filter;
  const exclusion = { has_id: [...baseIds] };
  if (!filter || Object.keys(filter).length === 0) return { must_not: [exclusion] };
  if (filter.must || filter.should || filter.must_not) {
    const own = filter.must_not;
    const mustNot: unknown[] = Array.isArray(own) ? (own as unknown[]) : own ? [own] : [];
    return { ...filter, must_not: [...mustNot, exclusion] };
  }
  // Flat `{ key: value }` form: expand it as the search executor would.
  return {
    must: Object.entries(filter).map(([key, value]) => ({ key, match: { value } })),
    must_not: [exclusion],
  };
}

/** Touched sets kept per process; a tree under edit reuses one set across many queries. */
const TOUCHED_BASE_IDS_CACHE_ENTRIES = 32;
/**
 * How long a resolved id set is trusted. The revision key catches an index run
 * that changes the point count; this bounds the one that does not. A stale set
 * costs only RRF positions — the strategy also drops any base row of a touched
 * file the request still returned — so a minute is enough.
 */
const TOUCHED_BASE_IDS_TTL_MS = 60_000;
/** Per-path scrolls in flight at once. */
const TOUCHED_BASE_IDS_SCROLL_CONCURRENCY = 16;
/** No single file holds more points than this; a scroll cap, not a page size. */
const MAX_POINTS_PER_PATH = 100_000;

/**
 * The base point ids of a touched-file set, resolved once per (collection,
 * index revision, touched set) and reused while the tree sits in that state.
 * One scroll per path, each served by the `relativePath` text index (a
 * `should` over many paths makes the planner scan instead: 1.5 s at 159 paths
 * against 160 ms for the per-path scrolls, measured live). A failed resolution
 * is not kept, so the next query retries.
 */
export class WorkingTreeTouchedBaseIds {
  private readonly resolved = new Map<string, { at: number; ids: Promise<readonly (string | number)[]> }>();

  constructor(
    private readonly qdrant: Pick<QdrantManager, "scrollFiltered">,
    private readonly now: () => number = Date.now,
  ) {}

  async idsOf(
    collectionName: string,
    touchedPaths: ReadonlySet<string>,
    revision: string,
  ): Promise<readonly (string | number)[]> {
    if (touchedPaths.size === 0) return [];
    const paths = [...touchedPaths].sort();
    const key = JSON.stringify([collectionName, revision, paths]);
    const at = this.now();
    const hit = this.resolved.get(key);
    if (hit && at - hit.at < TOUCHED_BASE_IDS_TTL_MS) return hit.ids;

    const ids = this.scrollIds(collectionName, paths);
    this.resolved.delete(key);
    if (this.resolved.size >= TOUCHED_BASE_IDS_CACHE_ENTRIES) {
      const oldest = this.resolved.keys().next().value;
      if (oldest !== undefined) this.resolved.delete(oldest);
    }
    this.resolved.set(key, { at, ids });
    ids.catch(() => {
      if (this.resolved.get(key)?.ids === ids) this.resolved.delete(key);
    });
    return ids;
  }

  private async scrollIds(collectionName: string, paths: readonly string[]): Promise<(string | number)[]> {
    const ids: (string | number)[] = [];
    for (let start = 0; start < paths.length; start += TOUCHED_BASE_IDS_SCROLL_CONCURRENCY) {
      const batch = paths.slice(start, start + TOUCHED_BASE_IDS_SCROLL_CONCURRENCY);
      const pages = await Promise.all(
        batch.map(async (path) =>
          this.qdrant.scrollFiltered(
            collectionName,
            { must: exactMatchOnTextIndexed("relativePath", path) },
            MAX_POINTS_PER_PATH,
            1_000,
            ["relativePath"],
          ),
        ),
      );
      for (const page of pages) for (const point of page) ids.push(point.id);
    }
    return ids;
  }
}

export interface WorkingTreeSparseScoring {
  /** The query's BM25 vector — the one the sparse prefetch was sent. */
  querySparse: SparseVector;
  /** The request filter the base rows were held to; undefined = none. */
  requestFilter?: Record<string, unknown>;
  /** The identity prefetch's restriction, when the query is one identifier. */
  identityFilter?: Record<string, unknown>;
  /** Exact pathPattern, applied to tree rows as to base rows. */
  pathMatcher?: (relativePath: string) => boolean;
  /** Each prefetch's limit: a row past it on a leg contributes nothing there. */
  legLimit: number;
}

/** The tree's rows the request admits, each scored by RRF over the legs it ranks in; best first. */
export function scoreWorkingTreeRows(rows: readonly ScrollChunk[], scoring: WorkingTreeSparseScoring): ExploreResult[] {
  const admitted = rows.filter((row) => admits(row, scoring));
  const sparseScore = new Map(admitted.map((row) => [row, sparseDot(scoring.querySparse, row)]));
  const bySparse = [...admitted].sort((a, b) => (sparseScore.get(b) ?? 0) - (sparseScore.get(a) ?? 0));

  const legs: ScrollChunk[][] = [bySparse.filter((row) => (sparseScore.get(row) ?? 0) > 0)];
  const { identityFilter } = scoring;
  if (identityFilter) legs.push(bySparse.filter((row) => payloadMatchesFilter(row.payload, identityFilter)));

  const fused = new Map<ScrollChunk, number>();
  for (const leg of legs) {
    leg.slice(0, scoring.legLimit).forEach((row, position) => {
      fused.set(row, (fused.get(row) ?? 0) + rrfContribution(position));
    });
  }
  return [...fused].sort(([, a], [, b]) => b - a).map(([row, score]) => ({ id: row.id, score, payload: row.payload }));
}

/**
 * Base page and scored tree rows in one score order, cut to `limit`. Stable:
 * base rows keep their relative order and win a tie, as they came first.
 */
export function fuseWorkingTreeRows(
  base: readonly ExploreResult[],
  tree: readonly ExploreResult[],
  limit: number,
): ExploreResult[] {
  return [...base, ...tree].sort((a, b) => b.score - a.score).slice(0, limit);
}

function admits(row: ScrollChunk, { requestFilter, pathMatcher }: WorkingTreeSparseScoring): boolean {
  if (requestFilter && Object.keys(requestFilter).length > 0 && !payloadMatchesFilter(row.payload, requestFilter)) {
    return false;
  }
  const { relativePath } = row.payload;
  return !pathMatcher || (typeof relativePath === "string" && pathMatcher(relativePath));
}

/**
 * Each delta row's BM25 vector, keyed by the row OBJECT. The chunk layer hands
 * every query the same row objects out of its content cache, so identity is a
 * free key — no hashing of content per query, which would cost about what the
 * vectorizing did — and an entry is collected with its row when the layer's
 * cache evicts it, so the map is bounded by the rows alive anyway. The stored
 * content is compared on read: a row whose payload changed is re-vectorized.
 * Persisting the vectors beside the rows in the chunk store was the other
 * option; it changes the store's entry format to save a cost this map already
 * removes for every query after a tree's first.
 */
const rowSparseVectors = new WeakMap<ScrollChunk, { content: string; weights: Map<number, number> }>();

function sparseWeightsOf(row: ScrollChunk): Map<number, number> {
  const content = typeof row.payload.content === "string" ? row.payload.content : "";
  const cached = rowSparseVectors.get(row);
  if (cached?.content === content) return cached.weights;
  const doc = generateSparseVector(content);
  const weights = new Map(doc.indices.map((index, i) => [index, doc.values[i]]));
  rowSparseVectors.set(row, { content, weights });
  return weights;
}

function sparseDot(query: SparseVector, row: ScrollChunk): number {
  const weights = sparseWeightsOf(row);
  return query.indices.reduce((sum, index, i) => sum + query.values[i] * (weights.get(index) ?? 0), 0);
}

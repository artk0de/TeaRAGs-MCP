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
 */

import { payloadMatchesFilter } from "../../../adapters/qdrant/filters/payload-match.js";
import { anyOfOnTextIndexed } from "../../../adapters/qdrant/filters/text-indexed-exact.js";
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
 * `filter` with every row of `touchedPaths` excluded — the same filter
 * otherwise, so `fetchPathPatternMatches` and the identity prefetch see the
 * request they always did. Membership goes through the text-indexed pair
 * (`anyOfOnTextIndexed`), never a bare `match.any` on `relativePath`.
 */
export function excludeWorkingTreeTouched(
  filter: Record<string, unknown> | undefined,
  touchedPaths: ReadonlySet<string>,
): Record<string, unknown> {
  const exclusion = anyOfOnTextIndexed("relativePath", [...touchedPaths].sort());
  if (!filter || Object.keys(filter).length === 0) return { must_not: [exclusion] };
  if (filter.must || filter.should || filter.must_not) {
    const mustNot: unknown[] = Array.isArray(filter.must_not) ? (filter.must_not as unknown[]) : [];
    return { ...filter, must_not: [...mustNot, exclusion] };
  }
  // Flat `{ key: value }` form: expand it as the search executor would.
  return {
    must: Object.entries(filter).map(([key, value]) => ({ key, match: { value } })),
    must_not: [exclusion],
  };
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

function sparseDot(query: SparseVector, row: ScrollChunk): number {
  const content = typeof row.payload.content === "string" ? row.payload.content : "";
  const doc = generateSparseVector(content);
  const weights = new Map(doc.indices.map((index, i) => [index, doc.values[i]]));
  return query.indices.reduce((sum, index, i) => sum + query.values[i] * (weights.get(index) ?? 0), 0);
}

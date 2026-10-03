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
 *   - dense leg (WTO-5): rows with a vector, ordered by exact cosine against
 *     the query vector (`denseRanking`, computed by the dense floor). Absent
 *     when the view has no dense source; a row still without a vector is not
 *     on it;
 *   - identity leg: rows the identity filter admits — the very filter
 *     `buildSymbolIdentityFilter` hands Qdrant — ordered by the dense score as
 *     the server's identity prefetch is, rows without a vector after them by
 *     the sparse score.
 *
 * Rows ranking on no leg are not candidates, as a point no prefetch returned
 * is not one for Qdrant.
 *
 * Per-query cost must not grow with the delta (bd tea-rags-mcp-xi2r9, live
 * probe P2-6 — 159 touched files: hybrid 365 ms against semantic 40 ms):
 *
 *   - a row's BM25 vector is computed once per content, not once per query,
 *     and stored with the rows, so a new process reads it (`rowSparseVectors`,
 *     `contentSparseVectors`);
 *   - the base rows of touched files leave the Qdrant request as ONE `has_id`
 *     condition over their point ids (`WorkingTreeTouchedBasePoints`,
 *     {@link excludeWorkingTreeBaseIds}). An exclusion by path is checked per
 *     candidate against `relativePath`, whose index is `text`: measured on the
 *     live self-index, the `should` of text+value pairs cost 131 ms at 60
 *     touched paths and 280 ms at 159, a bare `match.any` 311 / 207 ms (and it
 *     is banned on that key, `text-indexed-exact.ts`). `has_id` is answered by
 *     Qdrant's id tracker: 5 / 8 ms. The ids come from POSITIVE per-path
 *     scrolls, which the text index does serve (12 / 160 ms), once per touched
 *     set and index revision — the read the delta signals share.
 */

import { createHash } from "node:crypto";

import { payloadMatchesFilter } from "../../../adapters/qdrant/filters/payload-match.js";
import { generateSparseVector } from "../../../adapters/qdrant/sparse.js";
import type { SparseVector } from "../../../adapters/qdrant/types.js";
import type { ScrollChunk } from "../chunk-grouping/types.js";
import type { ExploreResult } from "../strategies/types.js";
import type { WorkingTreeChunkSparseVectors } from "./chunk-store.js";

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
  /**
   * The dense leg (WTO-5): ids of the admitted rows that have a vector, best
   * cosine first. Absent → no dense leg (no dense source wired).
   */
  denseRanking?: readonly (string | number)[];
}

/** The tree's rows the request admits, each scored by RRF over the legs it ranks in; best first. */
export function scoreWorkingTreeRows(rows: readonly ScrollChunk[], scoring: WorkingTreeSparseScoring): ExploreResult[] {
  const admitted = rows.filter((row) => workingTreeRowAdmitted(row, scoring));
  const sparseScore = new Map(admitted.map((row) => [row, sparseDot(scoring.querySparse, row)]));
  const bySparse = [...admitted].sort((a, b) => (sparseScore.get(b) ?? 0) - (sparseScore.get(a) ?? 0));

  const legs: ScrollChunk[][] = [bySparse.filter((row) => (sparseScore.get(row) ?? 0) > 0)];
  const denseRank = new Map((scoring.denseRanking ?? []).map((id, position) => [String(id), position]));
  const byDense = [...admitted]
    .filter((row) => denseRank.has(String(row.id)))
    .sort((a, b) => (denseRank.get(String(a.id)) ?? 0) - (denseRank.get(String(b.id)) ?? 0));
  if (scoring.denseRanking) legs.push(byDense);
  const { identityFilter } = scoring;
  if (identityFilter) {
    const identityOrder = [...byDense, ...bySparse.filter((row) => !denseRank.has(String(row.id)))];
    legs.push(identityOrder.filter((row) => payloadMatchesFilter(row.payload, identityFilter)));
  }

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

/**
 * Whether the request admits a tree row: the filter the base rows were held to
 * and the exact pathPattern — so a tree row reaches the candidates exactly when
 * its indexed twin could have. Shared by the sparse and dense floors.
 */
export function workingTreeRowAdmitted(
  row: ScrollChunk,
  { requestFilter, pathMatcher }: Pick<WorkingTreeSparseScoring, "requestFilter" | "pathMatcher">,
): boolean {
  if (requestFilter && Object.keys(requestFilter).length > 0 && !payloadMatchesFilter(row.payload, requestFilter)) {
    return false;
  }
  const { relativePath } = row.payload;
  return !pathMatcher || (typeof relativePath === "string" && pathMatcher(relativePath));
}

/**
 * Each delta row's BM25 vector, in two tiers.
 *
 * By row OBJECT (`rowSparseVectors`): the chunk layer hands every query the
 * same row objects out of its content cache, so identity is a free key — no
 * hashing of content per query — and an entry is collected with its row when
 * the layer's cache evicts it. The stored content is compared on read: a row
 * whose payload changed is looked up again.
 *
 * By content sha256 (`contentSparseVectors`), process-wide: a row object the
 * first tier has not seen — a re-chunk after an edit keeps most of a file's
 * chunk contents, a store read hands out new objects — costs one hash, not a
 * vectorizing. The chunk layer seeds it with the vectors the chunk store keeps
 * beside the rows ({@link rememberWorkingTreeSparseVectors}) and stores the
 * ones a fresh chunk needs ({@link computeWorkingTreeSparseVectors}), so a
 * one-shot process that reads its delta from the store vectorizes nothing.
 * Bounded by {@link WORKING_TREE_SPARSE_MEMO_MAX_CONTENTS}, oldest out first.
 */
const rowSparseVectors = new WeakMap<ScrollChunk, { content: string; weights: Map<number, number> }>();

/**
 * Contents whose BM25 vector the process keeps. Measured over this repo's
 * `src/core/domains` cut into 1.5 KB rows: ~80 distinct tokens per row, ~2 KB
 * of JSON, so the memo stays near 40 MB at the cap — the rows of several
 * thousand delta files. Vectorizing a row cost ~53 µs there, its sha256 ~2.4 µs.
 */
export const WORKING_TREE_SPARSE_MEMO_MAX_CONTENTS = 20_000;
const contentSparseVectors = new Map<string, SparseVector>();

const contentSha256Of = (content: string): string => createHash("sha256").update(content).digest("hex");

function memoizeSparseVector(contentSha256: string, vector: SparseVector): void {
  if (contentSparseVectors.has(contentSha256)) contentSparseVectors.delete(contentSha256);
  else if (contentSparseVectors.size >= WORKING_TREE_SPARSE_MEMO_MAX_CONTENTS) {
    const oldest = contentSparseVectors.keys().next().value;
    if (oldest !== undefined) contentSparseVectors.delete(oldest);
  }
  contentSparseVectors.set(contentSha256, vector);
}

function sparseVectorOfContent(content: string, contentSha256: string): SparseVector {
  const memoized = contentSparseVectors.get(contentSha256);
  if (memoized) return memoized;
  const vector = generateSparseVector(content);
  memoizeSparseVector(contentSha256, vector);
  return vector;
}

const contentOf = (row: ScrollChunk): string => (typeof row.payload.content === "string" ? row.payload.content : "");

/** Make vectors a chunk store kept beside its rows known to this process's scoring. */
export function rememberWorkingTreeSparseVectors(vectors: WorkingTreeChunkSparseVectors): void {
  for (const [contentSha256, vector] of vectors) memoizeSparseVector(contentSha256, vector);
}

/** The BM25 vector of every row's content, by content sha256 — what the chunk store keeps beside the rows. */
export function computeWorkingTreeSparseVectors(rows: readonly ScrollChunk[]): WorkingTreeChunkSparseVectors {
  const vectors = new Map<string, SparseVector>();
  for (const row of rows) {
    const content = contentOf(row);
    const contentSha256 = contentSha256Of(content);
    vectors.set(contentSha256, sparseVectorOfContent(content, contentSha256));
  }
  return vectors;
}

function sparseWeightsOf(row: ScrollChunk): Map<number, number> {
  const content = contentOf(row);
  const cached = rowSparseVectors.get(row);
  if (cached?.content === content) return cached.weights;
  const doc = sparseVectorOfContent(content, contentSha256Of(content));
  const weights = new Map(doc.indices.map((index, i) => [index, doc.values[i]]));
  rowSparseVectors.set(row, { content, weights });
  return weights;
}

function sparseDot(query: SparseVector, row: ScrollChunk): number {
  const weights = sparseWeightsOf(row);
  return query.indices.reduce((sum, index, i) => sum + query.values[i] * (weights.get(index) ?? 0), 0);
}

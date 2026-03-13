/**
 * Qdrant filter merge utilities.
 *
 * Pure functions for combining Qdrant filter objects.
 * Used by TrajectoryRegistry.buildMergedFilter() to merge
 * typed filter output with raw user-provided filters.
 */

import type { QdrantFilter, QdrantFilterCondition } from "./types.js";

/**
 * Merge two Qdrant filters by concatenating must/must_not arrays.
 * Preserves should from raw filter (b) only — typed filters never produce should.
 *
 * Returns undefined if both inputs are undefined or empty.
 */
export function mergeQdrantFilters(a: QdrantFilter | undefined, b: QdrantFilter | undefined): QdrantFilter | undefined {
  if (!a && !b) return undefined;
  if (!a) return b;
  if (!b) return a;

  const must = concatArrays(a.must, b.must);
  const mustNot = concatArrays(a.must_not, b.must_not);
  // Preserve should from raw filter (b) only — typed filters never produce should
  const { should } = b;

  if (!must.length && !mustNot.length && !should?.length) return undefined;

  const result: QdrantFilter = {};
  if (must.length > 0) result.must = must;
  if (mustNot.length > 0) result.must_not = mustNot;
  if (should && should.length > 0) result.should = should;
  return result;
}

function concatArrays(a?: QdrantFilterCondition[], b?: QdrantFilterCondition[]): QdrantFilterCondition[] {
  return [...(a ?? []), ...(b ?? [])];
}

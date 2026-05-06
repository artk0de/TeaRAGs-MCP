/**
 * Qdrant filter primitives.
 *
 * These are infrastructure-level types describing the shape of
 * Qdrant filter conditions. Domain code (trajectory, search, etc.)
 * imports from here rather than defining its own duplicates.
 */

export interface QdrantMatchCondition {
  key: string;
  match: { value: unknown } | { any: unknown[] } | { text: string };
}

export interface QdrantRangeCondition {
  key: string;
  range: { gt?: number; gte?: number; lt?: number; lte?: number };
}

export interface QdrantIsEmptyCondition {
  is_empty: { key: string };
}

/**
 * Nested filter condition — Qdrant supports recursive filter composition
 * (e.g. `must: [{ should: [a, b] }]` means "AND with (a OR b)").
 * Using a nested filter wherever a leaf condition is accepted lets a
 * single FilterDescriptor express "match X OR match Y" without forcing
 * `should` into `FilterConditionResult` (which would lose AND-semantics
 * across multiple registered filters).
 */
export type QdrantFilterCondition = QdrantMatchCondition | QdrantRangeCondition | QdrantIsEmptyCondition | QdrantFilter;

export interface QdrantFilter {
  must?: QdrantFilterCondition[];
  should?: QdrantFilterCondition[];
  must_not?: QdrantFilterCondition[];
}

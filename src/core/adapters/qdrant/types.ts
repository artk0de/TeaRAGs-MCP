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

export type QdrantFilterCondition = QdrantMatchCondition | QdrantRangeCondition | QdrantIsEmptyCondition;

export interface QdrantFilter {
  must?: QdrantFilterCondition[];
  should?: QdrantFilterCondition[];
  must_not?: QdrantFilterCondition[];
}

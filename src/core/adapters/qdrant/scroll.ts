import type { QdrantManager } from "./client.js";

const PAGE_SIZE = 1000;

interface ScrollResult {
  points: { payload?: Record<string, unknown> | null; vector?: unknown }[];
  next_page_offset?: string | number | null;
}

interface ScrollClient {
  client: {
    scroll: (
      collectionName: string,
      options: {
        limit: number;
        offset: string | number | undefined;
        with_payload: boolean;
        with_vector: boolean;
      },
    ) => Promise<ScrollResult>;
  };
}

/** Scroll all points from a collection, payload only (no vectors). */
export async function scrollAllPoints(
  qdrant: QdrantManager,
  collectionName: string,
): Promise<{ payload: Record<string, unknown> }[]> {
  const points: { payload: Record<string, unknown> }[] = [];
  let offset: string | number | null = null;

  do {
    const result = await (qdrant as unknown as ScrollClient).client.scroll(collectionName, {
      limit: PAGE_SIZE,
      offset: offset ?? undefined,
      with_payload: true,
      with_vector: false,
    });
    for (const point of result.points) {
      if (point.payload) {
        points.push({ payload: point.payload });
      }
    }
    offset = result.next_page_offset ?? null;
  } while (offset !== null);

  return points;
}

/**
 * Bounded vector sample for the collection score background.
 *
 * Deliberately capped rather than exhaustive: the background is a distribution
 * estimate, and a full scroll with vectors would pull the whole index through
 * memory (17k × 768 floats ≈ 52 MB on a small project, far worse on a large
 * one) to compute six numbers.
 */
export async function sampleVectors(
  qdrant: QdrantManager,
  collectionName: string,
  maxVectors: number,
): Promise<number[][]> {
  const vectors: number[][] = [];
  let offset: string | number | null = null;

  do {
    const result = await (qdrant as unknown as ScrollClient).client.scroll(collectionName, {
      limit: PAGE_SIZE,
      offset: offset ?? undefined,
      with_payload: false,
      with_vector: true,
    });
    for (const point of result.points) {
      const dense = denseVectorOf(point.vector);
      if (dense) vectors.push(dense);
    }
    offset = result.next_page_offset ?? null;
  } while (offset !== null && vectors.length < maxVectors);

  return vectors;
}

/** Points carry a bare array, or `{ dense, sparse }` once hybrid is enabled. */
function denseVectorOf(vector: unknown): number[] | undefined {
  if (Array.isArray(vector) && typeof vector[0] === "number") return vector as number[];
  if (vector && typeof vector === "object") {
    for (const value of Object.values(vector as Record<string, unknown>)) {
      if (Array.isArray(value) && typeof value[0] === "number") return value as number[];
    }
  }
  return undefined;
}

/** Scroll points ordered by a payload field. Delegates to QdrantManager.scrollOrdered. */
export async function scrollOrderedBy(
  qdrant: QdrantManager,
  collectionName: string,
  orderBy: { key: string; direction: "asc" | "desc" },
  limit: number,
  filter?: Record<string, unknown>,
): Promise<{ id: string | number; payload: Record<string, unknown> }[]> {
  return qdrant.scrollOrdered(collectionName, orderBy, limit, filter);
}

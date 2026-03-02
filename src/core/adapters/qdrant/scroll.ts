import type { QdrantManager } from "./client.js";

const PAGE_SIZE = 1000;

interface ScrollResult {
  points: { payload?: Record<string, unknown> | null }[];
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

/**
 * Indexing Marker - Manages the metadata marker point in Qdrant collections.
 *
 * Stores a zero-vector marker that tracks indexing state (started/completed).
 * Handles both dense-only and hybrid (dense+sparse) collections.
 */

import type { EmbeddingProvider } from "../adapters/embeddings/base.js";
import type { QdrantManager } from "../adapters/qdrant/client.js";
import { INDEXING_METADATA_ID } from "./constants.js";

/**
 * Store or update the indexing metadata marker in a collection.
 *
 * When `complete=false`: creates a new marker point (start of indexing).
 * When `complete=true`: updates the existing marker to mark completion.
 */
export async function storeIndexingMarker(
  qdrant: QdrantManager,
  embeddings: EmbeddingProvider,
  collectionName: string,
  complete: boolean,
): Promise<void> {
  try {
    if (complete) {
      try {
        await qdrant.setPayload(
          collectionName,
          { indexingComplete: true, completedAt: new Date().toISOString() },
          { points: [INDEXING_METADATA_ID], wait: true },
        );
      } catch (error) {
        console.error("[IndexingMarker] Failed to set completion marker via setPayload:", error);
        const vectorSize = embeddings.getDimensions();
        const zeroVector: number[] = new Array<number>(vectorSize).fill(0);
        await qdrant.addPoints(collectionName, [
          {
            id: INDEXING_METADATA_ID,
            vector: zeroVector,
            payload: {
              _type: "indexing_metadata",
              indexingComplete: true,
              completedAt: new Date().toISOString(),
            },
          },
        ]);
      }
      return;
    }

    const vectorSize = embeddings.getDimensions();
    const zeroVector: number[] = new Array<number>(vectorSize).fill(0);
    const collectionInfo = await qdrant.getCollectionInfo(collectionName);

    const payload = {
      _type: "indexing_metadata",
      indexingComplete: false,
      startedAt: new Date().toISOString(),
    };

    if (collectionInfo.hybridEnabled) {
      await qdrant.addPointsWithSparse(collectionName, [
        {
          id: INDEXING_METADATA_ID,
          vector: zeroVector,
          sparseVector: { indices: [], values: [] },
          payload,
        },
      ]);
    } else {
      await qdrant.addPoints(collectionName, [
        {
          id: INDEXING_METADATA_ID,
          vector: zeroVector,
          payload,
        },
      ]);
    }
  } catch (error) {
    console.error("Failed to store indexing marker:", error);
  }
}

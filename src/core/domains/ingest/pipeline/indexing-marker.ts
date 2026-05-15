/**
 * Indexing Marker - Manages the metadata marker point in Qdrant collections.
 *
 * Stores a zero-vector marker that tracks indexing state (started/completed).
 * Handles both dense-only and hybrid (dense+sparse) collections.
 */

import type { EmbeddingProvider } from "../../../adapters/embeddings/base.js";
import type { QdrantManager } from "../../../adapters/qdrant/client.js";
import { INDEXING_METADATA_ID } from "../constants.js";

/**
 * Store or update the indexing metadata marker in a collection.
 *
 * When `complete=false`: creates a new marker point (start of indexing).
 * When `complete=true`: updates the existing marker to mark completion.
 *
 * `teaRagsVersion` (when provided) is written into the initial marker payload
 * so that `register_project` on an already-indexed collection can recover it
 * via `tryEnrichFromQdrant` — the registry stores it but the registry file
 * may be missing or stale when registering an out-of-band collection.
 */
export async function storeIndexingMarker(
  qdrant: QdrantManager,
  embeddings: EmbeddingProvider,
  collectionName: string,
  complete: boolean,
  modelInfo?: { model: string; contextLength: number; dimensions: number },
  teaRagsVersion?: string,
): Promise<void> {
  try {
    if (complete) {
      const completedAt = new Date().toISOString();
      try {
        await qdrant.setPayload(
          collectionName,
          // `indexedAt` mirrors `completedAt` for registry-enrichment readers
          // that want a single source-of-truth field name.
          { indexingComplete: true, completedAt, indexedAt: completedAt },
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
              completedAt,
              indexedAt: completedAt,
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
      embeddingModel: embeddings.getModel(),
      ...(teaRagsVersion && teaRagsVersion.length > 0 && { teaRagsVersion }),
      ...(modelInfo && { modelInfo }),
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

/**
 * Update the heartbeat timestamp on an in-progress indexing marker.
 * Called periodically during indexing to signal the process is still alive.
 * Stale detection uses lastHeartbeat (or startedAt as fallback) to decide
 * whether an "in progress" marker belongs to a live or crashed process.
 */
export async function updateHeartbeat(qdrant: QdrantManager, collectionName: string): Promise<void> {
  try {
    await qdrant.setPayload(
      collectionName,
      { lastHeartbeat: new Date().toISOString() },
      { points: [INDEXING_METADATA_ID], wait: true },
    );
  } catch {
    // Non-fatal: heartbeat failure should not abort indexing
  }
}

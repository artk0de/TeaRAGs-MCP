/**
 * EmbeddingModelGuard — prevents mixing vectors from different embedding models
 * in the same Qdrant collection.
 *
 * Caches collection→model mapping in memory (one Qdrant read per collection per
 * MCP server lifetime). Backfills legacy collections that lack the marker field.
 */

import { EmbeddingModelMismatchError } from "../adapters/embeddings/errors.js";
import type { QdrantManager } from "../adapters/qdrant/client.js";
import { INDEXING_METADATA_ID } from "../domains/ingest/constants.js";
import { isDebug } from "../domains/ingest/pipeline/infra/runtime.js";

export class EmbeddingModelGuard {
  private readonly cache = new Map<string, string | null>();

  constructor(
    private readonly qdrant: QdrantManager,
    private readonly currentModel: string,
    private readonly dimensions: number,
  ) {}

  /**
   * Ensure current embedding model matches the one stored in the collection.
   * Throws EmbeddingModelMismatchError on mismatch.
   * Backfills model name if missing (legacy collections).
   */
  async ensureMatch(collectionName: string): Promise<void> {
    // 1. Cache hit
    if (this.cache.has(collectionName)) {
      const stored = this.cache.get(collectionName);
      if (stored && stored !== this.currentModel) {
        throw new EmbeddingModelMismatchError(stored, this.currentModel);
      }
      return;
    }

    // 2. Cache miss — read marker from Qdrant
    let storedModel: string | null = null;

    try {
      const point = await this.qdrant.getPoint(collectionName, INDEXING_METADATA_ID);

      if (point?.payload) {
        const model = point.payload.embeddingModel;
        if (typeof model === "string") {
          storedModel = model;
        } else {
          // Marker exists but no embeddingModel — backfill via setPayload
          await this.qdrant.setPayload(
            collectionName,
            { embeddingModel: this.currentModel },
            { points: [INDEXING_METADATA_ID] },
          );
          storedModel = this.currentModel;

          if (isDebug()) {
            console.error(`[ModelGuard] Backfilled embeddingModel="${this.currentModel}" for ${collectionName}`);
          }
        }
      } else {
        // No marker point at all — create one with zero vector
        const zeroVector = new Array<number>(this.dimensions).fill(0);
        const collectionInfo = await this.qdrant.getCollectionInfo(collectionName);

        if (collectionInfo.hybridEnabled) {
          await this.qdrant.addPointsWithSparse(collectionName, [
            {
              id: INDEXING_METADATA_ID,
              vector: zeroVector,
              sparseVector: { indices: [], values: [] },
              payload: {
                _type: "indexing_metadata",
                indexingComplete: true,
                embeddingModel: this.currentModel,
              },
            },
          ]);
        } else {
          await this.qdrant.addPoints(collectionName, [
            {
              id: INDEXING_METADATA_ID,
              vector: zeroVector,
              payload: {
                _type: "indexing_metadata",
                indexingComplete: true,
                embeddingModel: this.currentModel,
              },
            },
          ]);
        }
        storedModel = this.currentModel;

        if (isDebug()) {
          console.error(`[ModelGuard] Created marker with embeddingModel="${this.currentModel}" for ${collectionName}`);
        }
      }
    } catch (error) {
      if (error instanceof EmbeddingModelMismatchError) throw error;
      // Qdrant read failed — skip guard silently (don't block operations)
      if (isDebug()) {
        console.error(`[ModelGuard] Failed to read/write marker for ${collectionName}:`, error);
      }
      this.cache.set(collectionName, null);
      return;
    }

    // 3. Compare and cache
    this.cache.set(collectionName, storedModel);
    if (storedModel && storedModel !== this.currentModel) {
      throw new EmbeddingModelMismatchError(storedModel, this.currentModel);
    }
  }

  /** Record model for a newly created collection (cache only — marker written by storeIndexingMarker). */
  recordModel(collectionName: string): void {
    this.cache.set(collectionName, this.currentModel);
  }

  /** Invalidate cache entry (force reindex, clear index). */
  invalidate(collectionName: string): void {
    this.cache.delete(collectionName);
  }
}

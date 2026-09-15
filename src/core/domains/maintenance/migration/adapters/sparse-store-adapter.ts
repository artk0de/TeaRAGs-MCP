/**
 * SparseStoreAdapter — adapts QdrantManager to the SparseStore interface.
 *
 * Handles sparse version tracking (stored in schema metadata point)
 * and BM25 vector rebuild for hybrid search collections.
 */

import type { QdrantManager } from "../../../../adapters/qdrant/client.js";
import { SchemaMetadataPointStore } from "../../../../adapters/qdrant/schema-metadata-point.js";
import { isServicePointPayload } from "../../../../adapters/qdrant/service-points.js";
import type { SparseStore } from "../types.js";

export class SparseStoreAdapter implements SparseStore {
  private readonly metadataPoint: SchemaMetadataPointStore;

  constructor(private readonly qdrant: QdrantManager) {
    this.metadataPoint = new SchemaMetadataPointStore(qdrant);
  }

  async getSparseVersion(collection: string): Promise<number> {
    try {
      return (await this.metadataPoint.read(collection))?.sparseVersion ?? 0;
    } catch {
      return 0;
    }
  }

  async rebuildSparseVectors(collection: string): Promise<void> {
    const { generateSparseVector } = await import("../../../../adapters/qdrant/sparse.js");
    let totalRebuilt = 0;

    for await (const batch of this.qdrant.scrollWithVectors(collection)) {
      const updates: {
        id: string | number;
        vector: number[];
        sparseVector: { indices: number[]; values: number[] };
        payload: Record<string, unknown>;
      }[] = [];

      for (const point of batch) {
        const { payload } = point;
        if (isServicePointPayload(payload)) continue;

        const { content } = payload;
        if (typeof content !== "string") continue;

        const denseVector = this.extractDenseVector(point.vector);
        if (!denseVector) continue;

        const sparseVector = generateSparseVector(content);
        updates.push({ id: point.id, vector: denseVector, sparseVector, payload });
      }

      if (updates.length > 0) {
        await this.qdrant.addPointsWithSparse(collection, updates);
        totalRebuilt += updates.length;
      }

      if (totalRebuilt > 0 && totalRebuilt % 500 === 0) {
        console.error(`[SparseRebuild] Progress: ${totalRebuilt} points rebuilt`);
      }
    }

    if (totalRebuilt > 0) {
      console.error(`[SparseRebuild] Complete: ${totalRebuilt} points rebuilt`);
    }
  }

  async storeSparseVersion(collection: string, version: number): Promise<void> {
    try {
      await this.metadataPoint.setSparseVersion(collection, version);
    } catch (error) {
      console.error("Failed to store sparse version:", error);
    }
  }

  private extractDenseVector(vector: unknown): number[] | null {
    if (vector && typeof vector === "object" && "dense" in vector) {
      const { dense } = vector as Record<string, unknown>;
      if (Array.isArray(dense)) return dense as number[];
    }
    if (Array.isArray(vector)) return vector as number[];
    return null;
  }
}

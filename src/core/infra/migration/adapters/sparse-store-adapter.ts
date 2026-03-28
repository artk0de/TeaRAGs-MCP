/**
 * SparseStoreAdapter — adapts QdrantManager to the SparseStore interface.
 *
 * Handles sparse version tracking (stored in schema metadata point)
 * and BM25 vector rebuild for hybrid search collections.
 */

import type { QdrantManager } from "../../../adapters/qdrant/client.js";
import type { SparseStore } from "../types.js";

/** Reserved point ID for schema metadata storage (shared with IndexStoreAdapter). */
const SCHEMA_METADATA_ID = "__schema_metadata__";

interface SchemaMetadata {
  _type: "schema_metadata";
  schemaVersion: number;
  migratedAt: string;
  indexes: string[];
  sparseVersion?: number;
}

export class SparseStoreAdapter implements SparseStore {
  constructor(private readonly qdrant: QdrantManager) {}

  async getSparseVersion(collection: string): Promise<number> {
    try {
      const point = await this.qdrant.getPoint(collection, SCHEMA_METADATA_ID);
      if (point?.payload?._type === "schema_metadata") {
        return (point.payload as unknown as SchemaMetadata).sparseVersion ?? 0;
      }
      return 0;
    } catch {
      return 0;
    }
  }

  async rebuildSparseVectors(collection: string): Promise<void> {
    const { generateSparseVector } = await import("../../../adapters/qdrant/sparse.js");
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
        if (payload._type === "schema_metadata" || payload._type === "indexing_metadata") continue;

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
      const existing = await this.getSchemaMetadata(collection);
      const metadata: SchemaMetadata = existing ?? {
        _type: "schema_metadata",
        schemaVersion: 0,
        migratedAt: new Date().toISOString(),
        indexes: [],
      };
      metadata.sparseVersion = version;
      metadata.migratedAt = new Date().toISOString();

      const info = await this.qdrant.getCollectionInfo(collection);
      const zeroVector = new Array<number>(info.vectorSize).fill(0);

      if (info.hybridEnabled) {
        await this.qdrant.addPointsWithSparse(collection, [
          {
            id: SCHEMA_METADATA_ID,
            vector: zeroVector,
            sparseVector: { indices: [], values: [] },
            payload: metadata as unknown as Record<string, unknown>,
          },
        ]);
      } else {
        await this.qdrant.addPoints(collection, [
          {
            id: SCHEMA_METADATA_ID,
            vector: zeroVector,
            payload: metadata as unknown as Record<string, unknown>,
          },
        ]);
      }
    } catch (error) {
      console.error("Failed to store sparse version:", error);
    }
  }

  private async getSchemaMetadata(collection: string): Promise<SchemaMetadata | null> {
    try {
      const point = await this.qdrant.getPoint(collection, SCHEMA_METADATA_ID);
      if (point?.payload?._type === "schema_metadata") {
        return point.payload as unknown as SchemaMetadata;
      }
      return null;
    } catch {
      return null;
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

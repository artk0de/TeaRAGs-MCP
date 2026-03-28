/**
 * IndexStoreAdapter — adapts QdrantManager to the IndexStore interface.
 *
 * Bridges schema migration steps to the underlying Qdrant operations
 * (payload indexes, schema version point, collection info).
 */

import type { QdrantManager } from "../../../adapters/qdrant/client.js";
import type { IndexStore } from "../types.js";

/** Reserved point ID for schema metadata storage. */
const SCHEMA_METADATA_ID = "__schema_metadata__";

interface SchemaMetadata {
  _type: "schema_metadata";
  schemaVersion: number;
  migratedAt: string;
  indexes: string[];
  sparseVersion?: number;
}

export class IndexStoreAdapter implements IndexStore {
  constructor(private readonly qdrant: QdrantManager) {}

  async getSchemaVersion(collection: string): Promise<number> {
    try {
      const point = await this.qdrant.getPoint(collection, SCHEMA_METADATA_ID);

      if (point?.payload?._type === "schema_metadata") {
        return (point.payload as unknown as SchemaMetadata).schemaVersion ?? 0;
      }

      // No metadata point — check if relativePath index exists (manually migrated collection)
      const hasIndex = await this.qdrant.hasPayloadIndex(collection, "relativePath");
      if (hasIndex) {
        return 6;
      }

      return 0;
    } catch {
      return 0;
    }
  }

  async ensureIndex(collection: string, field: string, type: string): Promise<boolean> {
    return this.qdrant.ensurePayloadIndex(
      collection,
      field,
      type as "keyword" | "integer" | "float" | "bool" | "geo" | "datetime" | "text" | "uuid",
    );
  }

  async storeSchemaVersion(collection: string, version: number, indexes: string[]): Promise<void> {
    try {
      const info = await this.qdrant.getCollectionInfo(collection);
      const zeroVector = new Array<number>(info.vectorSize).fill(0);

      const payload: SchemaMetadata = {
        _type: "schema_metadata",
        schemaVersion: version,
        migratedAt: new Date().toISOString(),
        indexes,
      };

      if (info.hybridEnabled) {
        await this.qdrant.addPointsWithSparse(collection, [
          {
            id: SCHEMA_METADATA_ID,
            vector: zeroVector,
            sparseVector: { indices: [], values: [] },
            payload: payload as unknown as Record<string, unknown>,
          },
        ]);
      } else {
        await this.qdrant.addPoints(collection, [
          {
            id: SCHEMA_METADATA_ID,
            vector: zeroVector,
            payload: payload as unknown as Record<string, unknown>,
          },
        ]);
      }
    } catch (error) {
      // Non-fatal: schema metadata write failure should not abort migration
      console.error("Failed to store schema metadata:", error);
    }
  }

  async hasPayloadIndex(collection: string, field: string): Promise<boolean> {
    return this.qdrant.hasPayloadIndex(collection, field);
  }

  async getCollectionInfo(collection: string): Promise<{ hybridEnabled: boolean; vectorSize: number }> {
    const info = await this.qdrant.getCollectionInfo(collection);
    return { hybridEnabled: info.hybridEnabled ?? false, vectorSize: info.vectorSize };
  }

  async updateSparseConfig(collection: string): Promise<void> {
    await this.qdrant.updateCollectionSparseConfig(collection);
  }
}

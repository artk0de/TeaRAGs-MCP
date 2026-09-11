/**
 * IndexStoreAdapter — adapts QdrantManager to the IndexStore interface.
 *
 * Bridges schema migration steps to the underlying Qdrant operations
 * (payload indexes, schema version point, collection info).
 */

import type { QdrantManager } from "../../../../adapters/qdrant/client.js";
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

      // Merge onto what is stored — a Qdrant upsert REPLACES the point's payload,
      // and this point is shared with two other writers: `SchemaManager` stamps
      // `sparseVersion` onto it when the collection is created, `SparseStoreAdapter`
      // updates that field afterwards. Writing only the schema fields dropped the
      // sibling stamp, so the next sync read `sparseVersion: 0` and paid for a full
      // BM25 rebuild over an index whose sparse vectors were already correct
      // (bd tea-rags-mcp-vy26b).
      const existing = await this.getSchemaMetadata(collection);
      const payload: SchemaMetadata = {
        ...existing,
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

  /**
   * The stored metadata point, or null when the collection has none yet.
   *
   * Read-before-write for {@link storeSchemaVersion}; the version *lookup* keeps
   * its own read because it falls back to index probing when the point is absent,
   * and must not treat an unreachable Qdrant as an absent point.
   */
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

  async deletePointsByFilter(collection: string, filter: Record<string, unknown>): Promise<void> {
    await this.qdrant.deletePointsByFilter(collection, filter);
  }

  async scrollAllPayload(collection: string): Promise<{ id: string | number; payload: Record<string, unknown> }[]> {
    return this.qdrant.scrollFiltered(collection, {}, 10000);
  }

  async batchSetPayload(
    collection: string,
    operations: { payload: Record<string, unknown>; points: (string | number)[] }[],
  ): Promise<void> {
    await this.qdrant.batchSetPayload(collection, operations);
  }

  async deletePayloadKeys(collection: string, keys: string[]): Promise<void> {
    await this.qdrant.deletePayloadKeys(collection, keys);
  }
}

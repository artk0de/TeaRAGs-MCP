/**
 * IndexStoreAdapter — adapts QdrantManager to the IndexStore interface.
 *
 * Bridges schema migration steps to the underlying Qdrant operations
 * (payload indexes, schema version point, collection info).
 */

import type { QdrantManager } from "../../../../adapters/qdrant/client.js";
import { SchemaMetadataPointStore } from "../../../../adapters/qdrant/schema-metadata-point.js";
import type { IndexStore } from "../types.js";

export class IndexStoreAdapter implements IndexStore {
  private readonly metadataPoint: SchemaMetadataPointStore;

  constructor(private readonly qdrant: QdrantManager) {
    this.metadataPoint = new SchemaMetadataPointStore(qdrant);
  }

  async getSchemaVersion(collection: string): Promise<number> {
    try {
      const metadata = await this.metadataPoint.read(collection);

      if (metadata) {
        return metadata.schemaVersion ?? 0;
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
      // The point is shared with the sparse pipeline's stamp; the store merges
      // onto what is stored so this write cannot erase it (bd tea-rags-mcp-vy26b,
      // tea-rags-mcp-906df).
      await this.metadataPoint.setSchemaVersion(collection, version, indexes);
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

/**
 * Schema Migration for Qdrant Collections
 *
 * Handles automatic migration of collection schema (payload indexes, etc.)
 * when new versions are deployed.
 *
 * Schema versions:
 * - v1-v3: No payload indexes (implicit)
 * - v4: Added keyword index on `relativePath` for faster filter-based deletes
 * - v5: Added text index on `relativePath` for glob pre-filter
 * - v6: Added keyword indexes on `language`, `fileExtension`, `chunkType`
 * - v7: Enable sparse vectors on non-hybrid collections (when enableHybrid=true)
 * - v8: Added text index on `symbolId` for partial match filtering
 */

import type { QdrantManager } from "../qdrant/client.js";

/** Current schema version */
export const CURRENT_SCHEMA_VERSION = 8;

/** Reserved ID for storing schema metadata in the collection */
const SCHEMA_METADATA_ID = "__schema_metadata__";

/**
 * Schema metadata stored in collection
 */
interface SchemaMetadata {
  _type: "schema_metadata";
  schemaVersion: number;
  migratedAt: string;
  indexes: string[];
  sparseVersion?: number;
}

/**
 * SchemaManager - Handles collection schema versioning and migrations
 */
export class SchemaManager {
  constructor(private readonly qdrant: QdrantManager) {}

  /**
   * Store schema metadata in collection
   */
  private async storeSchemaMetadata(collectionName: string, version: number, indexes: string[]): Promise<void> {
    try {
      // Get collection info to create appropriate zero vector
      const info = await this.qdrant.getCollectionInfo(collectionName);
      const zeroVector: number[] = new Array<number>(info.vectorSize).fill(0);

      const payload: SchemaMetadata = {
        _type: "schema_metadata",
        schemaVersion: version,
        migratedAt: new Date().toISOString(),
        indexes,
      };

      if (info.hybridEnabled) {
        await this.qdrant.addPointsWithSparse(collectionName, [
          {
            id: SCHEMA_METADATA_ID,
            vector: zeroVector,
            sparseVector: { indices: [], values: [] },
            payload: payload as unknown as Record<string, unknown>,
          },
        ]);
      } else {
        await this.qdrant.addPoints(collectionName, [
          {
            id: SCHEMA_METADATA_ID,
            vector: zeroVector,
            payload: payload as unknown as Record<string, unknown>,
          },
        ]);
      }
    } catch (error) {
      // Non-fatal: log but don't fail
      console.error("Failed to store schema metadata:", error);
    }
  }

  /**
   * Initialize schema for a new collection
   * Creates all required indexes upfront
   */
  async initializeSchema(collectionName: string): Promise<void> {
    const indexes: string[] = [];

    // Create relativePath keyword index for fast filter-based operations
    await this.qdrant.createPayloadIndex(collectionName, "relativePath", "keyword");
    indexes.push("relativePath");

    // Create relativePath text index for glob pre-filter (was missing for new collections)
    await this.qdrant.createPayloadIndex(collectionName, "relativePath", "text");

    // Create keyword indexes on frequently filtered fields
    for (const field of ["language", "fileExtension", "chunkType"] as const) {
      await this.qdrant.createPayloadIndex(collectionName, field, "keyword");
      indexes.push(field);
    }

    // Create text index on symbolId for partial match filtering
    await this.qdrant.createPayloadIndex(collectionName, "symbolId", "text");

    // Store schema metadata
    await this.storeSchemaMetadata(collectionName, CURRENT_SCHEMA_VERSION, indexes);
  }
}

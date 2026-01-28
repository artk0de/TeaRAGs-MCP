/**
 * Schema Migration for Qdrant Collections
 *
 * Handles automatic migration of collection schema (payload indexes, etc.)
 * when new versions are deployed.
 *
 * Schema versions:
 * - v1-v3: No payload indexes (implicit)
 * - v4: Added keyword index on `relativePath` for faster filter-based deletes
 */

import type { QdrantManager } from "../qdrant/client.js";

/** Current schema version */
export const CURRENT_SCHEMA_VERSION = 4;

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
}

/**
 * Migration result
 */
export interface SchemaMigrationResult {
  success: boolean;
  fromVersion: number;
  toVersion: number;
  migrationsApplied: string[];
  error?: string;
}

/**
 * SchemaManager - Handles collection schema versioning and migrations
 */
export class SchemaManager {
  constructor(private qdrant: QdrantManager) {}

  /**
   * Get current schema version from collection metadata
   * Returns 0 if no schema metadata exists (pre-v4 collections)
   */
  async getSchemaVersion(collectionName: string): Promise<number> {
    try {
      const point = await this.qdrant.getPoint(
        collectionName,
        SCHEMA_METADATA_ID,
      );

      if (point?.payload?._type === "schema_metadata") {
        return (point.payload as unknown as SchemaMetadata).schemaVersion || 0;
      }

      // No metadata point - check if collection has relativePath index
      // If yes, it was manually migrated; treat as current version
      const hasIndex = await this.qdrant.hasPayloadIndex(
        collectionName,
        "relativePath",
      );
      if (hasIndex) {
        return CURRENT_SCHEMA_VERSION;
      }

      return 0; // Pre-v4 collection
    } catch {
      return 0;
    }
  }

  /**
   * Store schema metadata in collection
   */
  private async storeSchemaMetadata(
    collectionName: string,
    version: number,
    indexes: string[],
  ): Promise<void> {
    try {
      // Get collection info to create appropriate zero vector
      const info = await this.qdrant.getCollectionInfo(collectionName);
      const zeroVector = new Array(info.vectorSize).fill(0);

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
   * Ensure collection schema is at current version
   * Applies migrations if needed
   */
  async ensureCurrentSchema(
    collectionName: string,
  ): Promise<SchemaMigrationResult> {
    const currentVersion = await this.getSchemaVersion(collectionName);
    const migrationsApplied: string[] = [];

    if (currentVersion >= CURRENT_SCHEMA_VERSION) {
      return {
        success: true,
        fromVersion: currentVersion,
        toVersion: currentVersion,
        migrationsApplied: [],
      };
    }

    try {
      // Apply migrations sequentially
      const indexes: string[] = [];

      // v4: Add relativePath keyword index
      if (currentVersion < 4) {
        const created = await this.qdrant.ensurePayloadIndex(
          collectionName,
          "relativePath",
          "keyword",
        );
        if (created) {
          migrationsApplied.push("v4: Created keyword index on relativePath");
          indexes.push("relativePath");
        } else {
          migrationsApplied.push("v4: relativePath index already exists");
          indexes.push("relativePath");
        }
      }

      // Future migrations can be added here:
      // if (currentVersion < 5) { ... }

      // Store updated schema metadata
      await this.storeSchemaMetadata(
        collectionName,
        CURRENT_SCHEMA_VERSION,
        indexes,
      );

      return {
        success: true,
        fromVersion: currentVersion,
        toVersion: CURRENT_SCHEMA_VERSION,
        migrationsApplied,
      };
    } catch (error) {
      return {
        success: false,
        fromVersion: currentVersion,
        toVersion: CURRENT_SCHEMA_VERSION,
        migrationsApplied,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  /**
   * Initialize schema for a new collection
   * Creates all required indexes upfront
   */
  async initializeSchema(collectionName: string): Promise<void> {
    const indexes: string[] = [];

    // Create relativePath keyword index for fast filter-based operations
    await this.qdrant.createPayloadIndex(
      collectionName,
      "relativePath",
      "keyword",
    );
    indexes.push("relativePath");

    // Store schema metadata
    await this.storeSchemaMetadata(
      collectionName,
      CURRENT_SCHEMA_VERSION,
      indexes,
    );
  }
}

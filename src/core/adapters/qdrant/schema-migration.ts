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
 */

import type { QdrantManager } from "../qdrant/client.js";

/** Current schema version */
export const CURRENT_SCHEMA_VERSION = 7;

/** Current sparse vector version — bump when BM25 tokenizer or weighting changes */
export const CURRENT_SPARSE_VERSION = 1;

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
  constructor(
    private readonly qdrant: QdrantManager,
    private readonly enableHybrid = false,
  ) {}

  /**
   * Get current schema version from collection metadata
   * Returns 0 if no schema metadata exists (pre-v4 collections)
   */
  async getSchemaVersion(collectionName: string): Promise<number> {
    try {
      const point = await this.qdrant.getPoint(collectionName, SCHEMA_METADATA_ID);

      if (point?.payload?._type === "schema_metadata") {
        return (point.payload as unknown as SchemaMetadata).schemaVersion || 0;
      }

      // No metadata point - check if collection has relativePath index
      // If yes, it was manually migrated; return 6 (not CURRENT_SCHEMA_VERSION)
      // so that v7+ migrations still run for these collections
      const hasIndex = await this.qdrant.hasPayloadIndex(collectionName, "relativePath");
      if (hasIndex) {
        return 6;
      }

      return 0; // Pre-v4 collection
    } catch {
      return 0;
    }
  }

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
   * Ensure collection schema is at current version
   * Applies migrations if needed
   */
  async ensureCurrentSchema(collectionName: string): Promise<SchemaMigrationResult> {
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
        const created = await this.qdrant.ensurePayloadIndex(collectionName, "relativePath", "keyword");
        if (created) {
          migrationsApplied.push("v4: Created keyword index on relativePath");
          indexes.push("relativePath");
        } else {
          migrationsApplied.push("v4: relativePath index already exists");
          indexes.push("relativePath");
        }
      }

      // v5: Add relativePath full-text index for glob pre-filter
      if (currentVersion < 5) {
        const created = await this.qdrant.ensurePayloadIndex(collectionName, "relativePath", "text");
        if (created) {
          migrationsApplied.push("v5: Created text index on relativePath for glob filtering");
        } else {
          migrationsApplied.push("v5: relativePath text index already exists");
        }
      }

      // v6: Add keyword indexes on frequently filtered fields
      if (currentVersion < 6) {
        for (const field of ["language", "fileExtension", "chunkType"] as const) {
          const created = await this.qdrant.ensurePayloadIndex(collectionName, field, "keyword");
          if (created) {
            migrationsApplied.push(`v6: Created keyword index on ${field}`);
          } else {
            migrationsApplied.push(`v6: ${field} keyword index already exists`);
          }
        }
      }

      // v7: Enable sparse vectors on non-hybrid collections when enableHybrid is true
      if (currentVersion < 7) {
        const info = await this.qdrant.getCollectionInfo(collectionName);
        if (!info.hybridEnabled && this.enableHybrid) {
          await this.qdrant.updateCollectionSparseConfig(collectionName);
          migrationsApplied.push("v7: Enabled sparse vectors on collection");
        } else {
          migrationsApplied.push("v7: Sparse config already present or not requested");
        }
      }

      // Store updated schema metadata
      await this.storeSchemaMetadata(collectionName, CURRENT_SCHEMA_VERSION, indexes);

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
    await this.qdrant.createPayloadIndex(collectionName, "relativePath", "keyword");
    indexes.push("relativePath");

    // Create relativePath text index for glob pre-filter (was missing for new collections)
    await this.qdrant.createPayloadIndex(collectionName, "relativePath", "text");

    // Create keyword indexes on frequently filtered fields
    for (const field of ["language", "fileExtension", "chunkType"] as const) {
      await this.qdrant.createPayloadIndex(collectionName, field, "keyword");
      indexes.push(field);
    }

    // Store schema metadata
    await this.storeSchemaMetadata(collectionName, CURRENT_SCHEMA_VERSION, indexes);
  }

  /**
   * Check if sparse vectors need rebuilding and rebuild if needed.
   * Called after ensureCurrentSchema to handle sparse version upgrades.
   */
  async checkSparseVectorVersion(collectionName: string): Promise<{ rebuilt: boolean; message?: string }> {
    if (!this.enableHybrid) return { rebuilt: false };

    // Safety net: ensure sparse config exists (handles false→true toggle after v7)
    const info = await this.qdrant.getCollectionInfo(collectionName);
    if (!info.hybridEnabled) {
      await this.qdrant.updateCollectionSparseConfig(collectionName);
    }

    const metadata = await this.getSchemaMetadata(collectionName);
    const currentSparseVersion = metadata?.sparseVersion ?? 0;
    if (currentSparseVersion >= CURRENT_SPARSE_VERSION) return { rebuilt: false };

    await this.rebuildSparseVectors(collectionName);
    await this.updateSparseVersion(collectionName, CURRENT_SPARSE_VERSION);
    return {
      rebuilt: true,
      message: `Rebuilt sparse vectors (v${currentSparseVersion} → v${CURRENT_SPARSE_VERSION})`,
    };
  }

  /**
   * Rebuild sparse vectors for all content points in the collection.
   */
  private async rebuildSparseVectors(collectionName: string): Promise<void> {
    const { generateSparseVector } = await import("../qdrant/sparse.js");
    let totalRebuilt = 0;

    for await (const batch of this.qdrant.scrollWithVectors(collectionName)) {
      const updates: {
        id: string | number;
        vector: number[];
        sparseVector: { indices: number[]; values: number[] };
        payload: Record<string, unknown>;
      }[] = [];

      for (const point of batch) {
        // Skip metadata points
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
        await this.qdrant.addPointsWithSparse(collectionName, updates);
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

  /**
   * Extract dense vector from either named or unnamed format.
   */
  private extractDenseVector(vector: unknown): number[] | null {
    // Named vector format: { dense: number[] }
    if (vector && typeof vector === "object" && "dense" in vector) {
      const { dense } = vector as Record<string, unknown>;
      if (Array.isArray(dense)) return dense as number[];
    }
    // Unnamed vector format: number[]
    if (Array.isArray(vector)) return vector as number[];
    return null;
  }

  /**
   * Get schema metadata from collection.
   */
  private async getSchemaMetadata(collectionName: string): Promise<SchemaMetadata | null> {
    try {
      const point = await this.qdrant.getPoint(collectionName, SCHEMA_METADATA_ID);
      if (point?.payload?._type === "schema_metadata") {
        return point.payload as unknown as SchemaMetadata;
      }
      return null;
    } catch {
      return null;
    }
  }

  /**
   * Update sparse version in schema metadata.
   */
  private async updateSparseVersion(collectionName: string, sparseVersion: number): Promise<void> {
    const existing = await this.getSchemaMetadata(collectionName);
    const metadata: SchemaMetadata = existing ?? {
      _type: "schema_metadata",
      schemaVersion: CURRENT_SCHEMA_VERSION,
      migratedAt: new Date().toISOString(),
      indexes: [],
    };
    metadata.sparseVersion = sparseVersion;
    metadata.migratedAt = new Date().toISOString();

    const info = await this.qdrant.getCollectionInfo(collectionName);
    const zeroVector = new Array<number>(info.vectorSize).fill(0);

    if (info.hybridEnabled) {
      await this.qdrant.addPointsWithSparse(collectionName, [
        {
          id: SCHEMA_METADATA_ID,
          vector: zeroVector,
          sparseVector: { indices: [], values: [] },
          payload: metadata as unknown as Record<string, unknown>,
        },
      ]);
    } else {
      await this.qdrant.addPoints(collectionName, [
        {
          id: SCHEMA_METADATA_ID,
          vector: zeroVector,
          payload: metadata as unknown as Record<string, unknown>,
        },
      ]);
    }
  }
}

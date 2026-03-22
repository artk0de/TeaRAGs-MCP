/**
 * StatusModule - Index status and cleanup operations.
 *
 * Extracted from CodeIndexer to isolate status queries and index clearing.
 */

import { homedir } from "node:os";
import { join } from "node:path";

import type { QdrantManager } from "../../../adapters/qdrant/client.js";
import { resolveCollectionName, validatePath } from "../../../infra/collection-name.js";
import type { ChunkEnrichmentInfo, EnrichmentInfo, IndexStatus } from "../../../types.js";
import { INDEXING_METADATA_ID } from "../constants.js";
import { ParallelFileSynchronizer } from "../sync/parallel-synchronizer.js";

export class StatusModule {
  constructor(
    private readonly qdrant: QdrantManager,
    private readonly snapshotDir?: string,
  ) {}

  /**
   * Get indexing status for a codebase
   */
  async getIndexStatus(path: string): Promise<IndexStatus> {
    const absolutePath = await validatePath(path);
    const collectionName = resolveCollectionName(absolutePath);
    const exists = await this.qdrant.collectionExists(collectionName);

    if (!exists) {
      return { isIndexed: false, status: "not_indexed" };
    }

    // Check for indexing marker in Qdrant (persisted across instances)
    const indexingMarker = await this.qdrant.getPoint(collectionName, INDEXING_METADATA_ID);
    const info = await this.qdrant.getCollectionInfo(collectionName);

    // Check marker status
    const isComplete = indexingMarker?.payload?.indexingComplete === true;
    const isInProgress = indexingMarker?.payload?.indexingComplete === false;

    // Subtract 1 from points count if marker exists (metadata point doesn't count as a chunk)
    const actualChunksCount = indexingMarker ? Math.max(0, info.pointsCount - 1) : info.pointsCount;

    // Read enrichment info from marker (if present)
    const enrichmentPayload = indexingMarker?.payload?.enrichment as EnrichmentInfo | undefined;
    const enrichment: EnrichmentInfo | undefined = enrichmentPayload?.status ? enrichmentPayload : undefined;

    // Read chunk-level enrichment info (separate key, written by chunk churn)
    const chunkEnrichmentPayload = indexingMarker?.payload?.chunkEnrichment as ChunkEnrichmentInfo | undefined;
    const chunkEnrichment: ChunkEnrichmentInfo | undefined = chunkEnrichmentPayload?.status
      ? chunkEnrichmentPayload
      : undefined;

    // Read embedding model from marker (if present)
    const embeddingModel =
      typeof indexingMarker?.payload?.embeddingModel === "string" ? indexingMarker.payload.embeddingModel : undefined;

    if (isInProgress) {
      return {
        isIndexed: false,
        status: "indexing",
        collectionName,
        chunksCount: actualChunksCount,
        embeddingModel,
        qdrantUrl: this.qdrant.url,
        enrichment,
        chunkEnrichment,
      };
    }

    if (isComplete) {
      return {
        isIndexed: true,
        status: "indexed",
        collectionName,
        chunksCount: actualChunksCount,
        embeddingModel,
        qdrantUrl: this.qdrant.url,
        lastUpdated: indexingMarker.payload?.completedAt
          ? new Date(
              typeof indexingMarker.payload.completedAt === "string" ||
                typeof indexingMarker.payload.completedAt === "number"
                ? indexingMarker.payload.completedAt
                : new Date(indexingMarker.payload.completedAt as Date).toISOString(),
            )
          : undefined,
        enrichment,
        chunkEnrichment,
      };
    }

    // Legacy collection (no marker) - check if it has content
    if (actualChunksCount > 0) {
      return {
        isIndexed: true,
        status: "indexed",
        collectionName,
        chunksCount: actualChunksCount,
        qdrantUrl: this.qdrant.url,
      };
    }

    return {
      isIndexed: false,
      status: "not_indexed",
      collectionName,
      chunksCount: 0,
      qdrantUrl: this.qdrant.url,
    };
  }

  /**
   * Clear all indexed data for a codebase.
   * Handles both legacy (real collection) and alias-based setups.
   */
  async clearIndex(path: string): Promise<void> {
    const absolutePath = await validatePath(path);
    const collectionName = resolveCollectionName(absolutePath);
    const exists = await this.qdrant.collectionExists(collectionName);

    if (exists) {
      const isAlias = await this.qdrant.aliases.isAlias(collectionName);
      if (isAlias) {
        // Alias-based: find underlying collection, delete alias + collection + orphans
        const aliases = await this.qdrant.aliases.listAliases();
        const activeCollection = aliases.find((a) => a.aliasName === collectionName)?.collectionName;
        await this.qdrant.aliases.deleteAlias(collectionName);
        if (activeCollection) {
          await this.qdrant.deleteCollection(activeCollection);
        }
        // Clean up any orphaned versioned collections
        const allCollections = await this.qdrant.listCollections();
        for (const c of allCollections) {
          if (c.startsWith(`${collectionName}_v`)) {
            await this.qdrant.deleteCollection(c);
          }
        }
      } else {
        // Legacy: real collection, just delete it
        await this.qdrant.deleteCollection(collectionName);
      }
    }

    // Also delete snapshot
    try {
      /* v8 ignore next -- fallback for backward compat */
      const dir = this.snapshotDir ?? join(process.env.TEA_RAGS_DATA_DIR ?? join(homedir(), ".tea-rags"), "snapshots");
      const synchronizer = new ParallelFileSynchronizer(absolutePath, collectionName, dir);
      await synchronizer.deleteSnapshot();
    } catch (_error) {
      // Ignore snapshot deletion errors
    }
  }
}

/**
 * StatusModule - Index status and cleanup operations.
 *
 * Extracted from CodeIndexer to isolate status queries and index clearing.
 */

import { homedir } from "node:os";
import { join } from "node:path";
import type { QdrantManager } from "../../qdrant/client.js";
import { ParallelFileSynchronizer } from "../sync/parallel-synchronizer.js";
import type { ChunkEnrichmentInfo, EnrichmentInfo, IndexStatus } from "../types.js";
import { INDEXING_METADATA_ID, validatePath, resolveCollectionName } from "./shared.js";

export class StatusModule {
  constructor(private qdrant: QdrantManager) {}

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
    const indexingMarker = await this.qdrant.getPoint(
      collectionName,
      INDEXING_METADATA_ID,
    );
    const info = await this.qdrant.getCollectionInfo(collectionName);

    // Check marker status
    const isComplete = indexingMarker?.payload?.indexingComplete === true;
    const isInProgress = indexingMarker?.payload?.indexingComplete === false;

    // Subtract 1 from points count if marker exists (metadata point doesn't count as a chunk)
    const actualChunksCount = indexingMarker
      ? Math.max(0, info.pointsCount - 1)
      : info.pointsCount;

    // Read enrichment info from marker (if present)
    const enrichmentPayload = indexingMarker?.payload?.enrichment as EnrichmentInfo | undefined;
    const enrichment: EnrichmentInfo | undefined = enrichmentPayload?.status
      ? enrichmentPayload
      : undefined;

    // Read chunk-level enrichment info (separate key, written by chunk churn)
    const chunkEnrichmentPayload = indexingMarker?.payload?.chunkEnrichment as ChunkEnrichmentInfo | undefined;
    const chunkEnrichment: ChunkEnrichmentInfo | undefined = chunkEnrichmentPayload?.status
      ? chunkEnrichmentPayload
      : undefined;

    if (isInProgress) {
      return {
        isIndexed: false,
        status: "indexing",
        collectionName,
        chunksCount: actualChunksCount,
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
        lastUpdated: indexingMarker.payload?.completedAt
          ? new Date(indexingMarker.payload.completedAt)
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
      };
    }

    return {
      isIndexed: false,
      status: "not_indexed",
      collectionName,
      chunksCount: 0,
    };
  }

  /**
   * Clear all indexed data for a codebase
   */
  async clearIndex(path: string): Promise<void> {
    const absolutePath = await validatePath(path);
    const collectionName = resolveCollectionName(absolutePath);
    const exists = await this.qdrant.collectionExists(collectionName);

    if (exists) {
      await this.qdrant.deleteCollection(collectionName);
    }

    // Also delete snapshot
    try {
      const snapshotDir = join(homedir(), ".tea-rags-mcp", "snapshots");
      const synchronizer = new ParallelFileSynchronizer(absolutePath, collectionName, snapshotDir);
      await synchronizer.deleteSnapshot();
    } catch (_error) {
      // Ignore snapshot deletion errors
    }
  }
}

/**
 * StatusModule - Index status and cleanup operations.
 *
 * Extracted from CodeIndexer to isolate status queries and index clearing.
 *
 * Always reports the latest versioned collection status:
 * - If a newer _v(N+1) is being indexed while alias points to _vN, reports "indexing"
 * - If alias doesn't exist yet (first index in progress), finds _v1 and reports from it
 */

import { homedir } from "node:os";
import { join } from "node:path";

import type { QdrantManager } from "../../../adapters/qdrant/client.js";
import { resolveCollectionName, validatePath } from "../../../infra/collection-name.js";
import type { ChunkEnrichmentInfo, EnrichmentInfo, IndexStatus } from "../../../types.js";
import { INDEXING_METADATA_ID } from "../constants.js";
import { ParallelFileSynchronizer } from "../sync/parallel-synchronizer.js";

/** If indexing marker says "in progress" for longer than this, report as stale */
const STALE_INDEXING_THRESHOLD_MS = 10 * 60 * 1000; // 10 minutes

export class StatusModule {
  constructor(
    private readonly qdrant: QdrantManager,
    private readonly snapshotDir?: string,
  ) {}

  /**
   * Get indexing status for a codebase.
   *
   * Always shows the latest version — if a newer versioned collection
   * is being indexed (no alias yet, or alias still on old version),
   * reports that indexing is in progress.
   */
  async getIndexStatus(path: string): Promise<IndexStatus> {
    const absolutePath = await validatePath(path);
    const collectionName = resolveCollectionName(absolutePath);

    // Find the latest versioned collection (highest _vN)
    const latestVersioned = await this.findLatestVersionedCollection(collectionName);

    // Check if alias/real collection exists
    const exists = await this.qdrant.collectionExists(collectionName);

    if (!exists && !latestVersioned) {
      return { isIndexed: false, status: "not_indexed" };
    }

    // If a versioned collection exists that is newer than what alias points to,
    // report status from it (covers first index + forceReindex in progress)
    if (latestVersioned) {
      const aliasTarget = exists ? await this.getAliasTarget(collectionName) : undefined;
      if (aliasTarget !== latestVersioned) {
        // Latest version is not yet aliased — it's being indexed or crashed mid-index
        return this.getStatusFromCollection(latestVersioned, collectionName);
      }
    }

    // Alias points to latest version (or legacy real collection) — read from alias
    return this.getStatusFromCollection(collectionName, collectionName);
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

  // ── Private helpers ──────────────────────────────────────

  /**
   * Find the latest versioned collection (highest _vN suffix).
   * Returns undefined if no versioned collections exist.
   */
  private async findLatestVersionedCollection(collectionName: string): Promise<string | undefined> {
    const allCollections = await this.qdrant.listCollections();
    const versionedPattern = new RegExp(`^${collectionName}_v(\\d+)$`);
    let maxVersion = 0;
    let latest: string | undefined;

    for (const c of allCollections) {
      const match = c.match(versionedPattern);
      if (match) {
        const version = parseInt(match[1], 10);
        if (version > maxVersion) {
          maxVersion = version;
          latest = c;
        }
      }
    }

    return latest;
  }

  /**
   * Get the collection name that an alias points to.
   * Returns undefined if the name is not an alias (real collection or not found).
   */
  private async getAliasTarget(aliasName: string): Promise<string | undefined> {
    const aliases = await this.qdrant.aliases.listAliases();
    return aliases.find((a) => a.aliasName === aliasName)?.collectionName;
  }

  /**
   * Read full index status from a specific collection.
   * @param sourceCollection - collection to read markers from (e.g. "code_abc_v1")
   * @param reportedName - collection name to report in the response (always the base alias name)
   */
  private async getStatusFromCollection(sourceCollection: string, reportedName: string): Promise<IndexStatus> {
    const indexingMarker = await this.qdrant.getPoint(sourceCollection, INDEXING_METADATA_ID);
    const info = await this.qdrant.getCollectionInfo(sourceCollection);

    const isComplete = indexingMarker?.payload?.indexingComplete === true;
    const isInProgress = indexingMarker?.payload?.indexingComplete === false;

    const actualChunksCount = indexingMarker ? Math.max(0, info.pointsCount - 1) : info.pointsCount;

    const enrichmentPayload = indexingMarker?.payload?.enrichment as EnrichmentInfo | undefined;
    const enrichment: EnrichmentInfo | undefined = enrichmentPayload?.status ? enrichmentPayload : undefined;

    const chunkEnrichmentPayload = indexingMarker?.payload?.chunkEnrichment as ChunkEnrichmentInfo | undefined;
    const chunkEnrichment: ChunkEnrichmentInfo | undefined = chunkEnrichmentPayload?.status
      ? chunkEnrichmentPayload
      : undefined;

    const embeddingModel =
      typeof indexingMarker?.payload?.embeddingModel === "string" ? indexingMarker.payload.embeddingModel : undefined;

    const schemaMetadata = await this.qdrant.getPoint(sourceCollection, "__schema_metadata__").catch(() => null);
    const sparseVersion =
      typeof schemaMetadata?.payload?.sparseVersion === "number" ? schemaMetadata.payload.sparseVersion : undefined;

    if (isInProgress) {
      // Detect stale indexing: marker says "in progress" but process likely crashed
      const startedAt = indexingMarker?.payload?.startedAt;
      const isStale =
        typeof startedAt === "string" && Date.now() - new Date(startedAt).getTime() > STALE_INDEXING_THRESHOLD_MS;

      return {
        isIndexed: false,
        status: isStale ? "stale_indexing" : "indexing",
        collectionName: reportedName,
        chunksCount: actualChunksCount,
        embeddingModel,
        qdrantUrl: this.qdrant.url,
        sparseVersion,
        enrichment,
        chunkEnrichment,
      };
    }

    if (isComplete) {
      return {
        isIndexed: true,
        status: "indexed",
        collectionName: reportedName,
        chunksCount: actualChunksCount,
        embeddingModel,
        qdrantUrl: this.qdrant.url,
        sparseVersion,
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
        collectionName: reportedName,
        chunksCount: actualChunksCount,
        qdrantUrl: this.qdrant.url,
        sparseVersion,
      };
    }

    return {
      isIndexed: false,
      status: "not_indexed",
      collectionName: reportedName,
      chunksCount: 0,
      qdrantUrl: this.qdrant.url,
      sparseVersion,
    };
  }
}

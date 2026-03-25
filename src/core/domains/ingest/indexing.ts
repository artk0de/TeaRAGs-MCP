/**
 * IndexPipeline - Full codebase indexing from scratch.
 *
 * Orchestrates: scan → collection setup → file processing → snapshot → marker.
 * File processing logic is delegated to FileProcessor.
 *
 * Uses versioned collections with aliases for zero-downtime reindexing:
 * - First index: creates `_v1` collection + alias
 * - forceReindex: creates `_v(N+1)`, switches alias atomically, deletes old
 * - Migration: converts real collection to alias scheme
 */

import { TeaRagsError } from "../../infra/errors.js";
import type { IndexOptions, IndexStats, ProgressCallback } from "../../types.js";
import { cleanupOrphanedVersions } from "./alias-cleanup.js";
import { BaseIndexingPipeline, type ProcessingContext } from "./pipeline/base.js";
import { processFiles } from "./pipeline/file-processor.js";
import { storeIndexingMarker } from "./pipeline/indexing-marker.js";
import { isDebug } from "./pipeline/infra/runtime.js";
import type { FileScanner } from "./pipeline/scanner.js";
import { ShardedSnapshotManager } from "./sync/sharded-snapshot.js";
import { SnapshotCleaner } from "./sync/snapshot-cleaner.js";

/**
 * Result of collection setup phase.
 * Carries alias context needed for finalization.
 */
export interface SetupResult {
  /** Whether indexing should proceed */
  ready: boolean;
  /** Versioned collection name to index into (e.g. "code_abc_v2") */
  targetCollection: string;
  /** Previous versioned collection (e.g. "code_abc_v1"), undefined on first index */
  previousCollection?: string;
  /** New alias version number */
  aliasVersion: number;
  /** True if no previous version exists */
  isFirstIndex: boolean;
  /** True if migrating from a real collection to alias scheme */
  isMigration: boolean;
}

export class IndexPipeline extends BaseIndexingPipeline {
  async indexCodebase(path: string, options?: IndexOptions, progressCallback?: ProgressCallback): Promise<IndexStats> {
    const startTime = Date.now();
    const stats: IndexStats = {
      filesScanned: 0,
      filesIndexed: 0,
      chunksCreated: 0,
      durationMs: 0,
      status: "completed",
      errors: [],
    };

    const { absolutePath, collectionName } = await this.resolveContext(path);

    try {
      const { files, scanner } = await this.scanAndReport(absolutePath, options, progressCallback);
      stats.filesScanned = files.length;

      if (files.length === 0) {
        stats.durationMs = Date.now() - startTime;
        return stats;
      }

      const setup = await this.setupCollection(collectionName, absolutePath, options);
      /* v8 ignore next 7 -- defensive guard: facade handles exists-without-force via reindexChanges */
      if (!setup.ready) {
        stats.status = "failed";
        stats.durationMs = Date.now() - startTime;
        stats.errors?.push(
          `Collection already exists. Use forceReindex=true to re-index from scratch, or use reindexChanges for incremental updates.`,
        );
        return stats;
      }

      const ctx = this.initProcessing(setup.targetCollection, absolutePath, scanner);
      this.startHeartbeat(setup.targetCollection);

      const result = await this.processAndTrack(files, absolutePath, ctx, progressCallback);
      stats.filesIndexed = result.filesProcessed;
      stats.chunksCreated = result.chunksCreated;
      if (result.errors.length > 0) {
        stats.errors?.push(...result.errors);
      }

      progressCallback?.({
        phase: "storing",
        current: result.chunksCreated,
        total: result.chunksCreated,
        percentage: 90,
        message: "Finalizing embeddings and storage...",
      });

      const getEnrichmentStatus = await this.finalizeProcessing(
        ctx,
        result.chunkMap,
        setup.targetCollection,
        absolutePath,
      );
      this.logPipelineCompletion(ctx);

      this.stopHeartbeat();
      await storeIndexingMarker(this.qdrant, this.embeddings, setup.targetCollection, true);
      await this.finalizeAlias(collectionName, setup);
      await this.saveSnapshot(absolutePath, collectionName, files, stats, setup.aliasVersion);

      const enrichmentResult = getEnrichmentStatus();
      stats.enrichmentStatus = enrichmentResult.status;
      stats.enrichmentMetrics = enrichmentResult.metrics;
      stats.durationMs = Date.now() - startTime;
      return stats;
    } catch (error) {
      // Typed errors (infra, domain) must propagate to MCP error handler
      if (error instanceof TeaRagsError) {
        throw error;
      }
      const errorMessage = error instanceof Error ? error.message : String(error);
      stats.status = "failed";
      stats.errors?.push(`Indexing failed: ${errorMessage}`);
      stats.durationMs = Date.now() - startTime;
      return stats;
    } finally {
      this.stopHeartbeat();
      const cleaner = new SnapshotCleaner(this.snapshotDir, collectionName);
      await cleaner.cleanupAfterIndexing();
    }
  }

  // ── Scanning ───────────────────────────────────────────

  private async scanAndReport(
    absolutePath: string,
    options?: IndexOptions,
    progressCallback?: ProgressCallback,
  ): Promise<{ files: string[]; scanner: FileScanner }> {
    progressCallback?.({
      phase: "scanning",
      current: 0,
      total: 100,
      percentage: 0,
      message: "Scanning files...",
    });

    const scanner = this.createScanner({
      extensions: options?.extensions,
      customIgnorePatterns: options?.ignorePatterns,
    });
    const files = await this.scanFiles(absolutePath, scanner);
    return { files, scanner };
  }

  // ── Collection setup ───────────────────────────────────

  private async setupCollection(
    collectionName: string,
    absolutePath: string,
    options?: IndexOptions,
  ): Promise<SetupResult> {
    const exists = await this.qdrant.collectionExists(collectionName);

    /* v8 ignore next 8 -- defensive guard: facade handles exists-without-force via reindexChanges */
    if (exists && !options?.forceReindex) {
      return {
        ready: false,
        targetCollection: collectionName,
        aliasVersion: 0,
        isFirstIndex: false,
        isMigration: false,
      };
    }

    // Load aliasVersion from snapshot
    const snapshotManager = new ShardedSnapshotManager(this.snapshotDir, collectionName);
    const loaded = await snapshotManager.load().catch(() => null);
    const currentAliasVersion = loaded?.aliasVersion ?? 0;

    // Detect migration: real collection exists but is not an alias
    const isAlias = exists ? await this.qdrant.aliases.isAlias(collectionName) : false;
    const isMigration = currentAliasVersion === 0 && exists && !isAlias;

    // Compute new version
    const newVersion = isMigration ? 2 : currentAliasVersion + 1;
    const versionedName = `${collectionName}_v${newVersion}`;
    const previousCollection = currentAliasVersion > 0 ? `${collectionName}_v${currentAliasVersion}` : undefined;

    // Orphan cleanup before creating new version
    await cleanupOrphanedVersions(this.qdrant, collectionName);

    // Clean up stale target from a previously failed attempt (e.g. crashed mid-index)
    const targetAlreadyExists = await this.qdrant.collectionExists(versionedName);
    /* v8 ignore next 6 -- defensive cleanup: hard to simulate in unit tests (requires mid-index crash) */
    if (targetAlreadyExists) {
      if (isDebug()) {
        console.error(`[Index] Stale collection ${versionedName} found from failed attempt, deleting`);
      }
      await this.qdrant.deleteCollection(versionedName);
    }

    if (isDebug()) {
      console.error(
        `[Index] Setup: version=${newVersion}, target=${versionedName}, ` +
          `previous=${previousCollection ?? "none"}, migration=${isMigration}`,
      );
    }

    // Create new versioned collection
    const vectorSize = this.embeddings.getDimensions();
    await this.qdrant.createCollection(
      versionedName,
      vectorSize,
      "Cosine",
      this.config.enableHybridSearch,
      this.config.quantizationScalar,
    );

    const schemaManager = this.deps.createSchemaManager();
    await schemaManager.initializeSchema(versionedName);
    await storeIndexingMarker(this.qdrant, this.embeddings, versionedName, false);

    return {
      ready: true,
      targetCollection: versionedName,
      previousCollection,
      aliasVersion: newVersion,
      isFirstIndex: currentAliasVersion === 0 && !isMigration,
      isMigration,
    };
  }

  // ── Alias finalization ─────────────────────────────────

  private async finalizeAlias(collectionName: string, setup: SetupResult): Promise<void> {
    if (setup.isFirstIndex) {
      // First time: create alias pointing to _v1
      await this.qdrant.aliases.createAlias(collectionName, setup.targetCollection);
    } else if (setup.isMigration) {
      // Migration: delete real collection, create alias to new versioned one
      // Brief ~100ms downtime (one-time migration cost)
      await this.qdrant.deleteCollection(collectionName);
      await this.qdrant.aliases.createAlias(collectionName, setup.targetCollection);
    } else if (setup.previousCollection) {
      // Atomic switch — zero downtime
      await this.qdrant.aliases.switchAlias(collectionName, setup.previousCollection, setup.targetCollection);
      await this.qdrant.deleteCollection(setup.previousCollection);
    }
  }

  // ── File processing ────────────────────────────────────

  private async processAndTrack(
    files: string[],
    absolutePath: string,
    ctx: ProcessingContext,
    progressCallback?: ProgressCallback,
  ) {
    let filesProcessed = 0;
    let chunksQueued = 0;

    return processFiles(
      files,
      absolutePath,
      ctx.chunkerPool,
      ctx.chunkPipeline,
      {
        enableGitMetadata: this.config.enableGitMetadata === true,
        maxChunksPerFile: this.config.maxChunksPerFile,
        maxTotalChunks: this.config.maxTotalChunks,
        concurrency: this.tuning.fileConcurrency,
      },
      {
        onFileProcessed: (_filePath, chunksCount) => {
          filesProcessed++;
          chunksQueued += chunksCount;
          if (filesProcessed === 1 || filesProcessed % 10 === 0) {
            const pipelineStats = ctx.chunkPipeline.getStats();
            progressCallback?.({
              phase: "chunking",
              current: filesProcessed,
              total: files.length,
              percentage: 10 + Math.round((filesProcessed / files.length) * 40),
              message: `Processing: ${filesProcessed}/${files.length} files, ${pipelineStats.itemsProcessed}/${chunksQueued} chunks embedded`,
            });
          }
        },
      },
    );
  }

  // ── Finalization helpers ───────────────────────────────

  private logPipelineCompletion(ctx: ProcessingContext): void {
    if (isDebug()) {
      const finalPipelineStats = ctx.chunkPipeline.getStats();
      console.error(
        `[Index] Pipeline completed: ${finalPipelineStats.itemsProcessed} chunks in ${finalPipelineStats.batchesProcessed} batches, ` +
          `${finalPipelineStats.throughput.toFixed(1)} chunks/s`,
      );
    }
  }

  private async saveSnapshot(
    absolutePath: string,
    collectionName: string,
    files: string[],
    stats: IndexStats,
    aliasVersion?: number,
  ): Promise<void> {
    try {
      const synchronizer = this.deps.createSynchronizer(absolutePath, collectionName);
      await synchronizer.updateSnapshot(files, undefined, aliasVersion ? { aliasVersion } : undefined);
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      console.error("Failed to save snapshot:", errorMessage);
      stats.errors?.push(`Snapshot save failed: ${errorMessage}`);
    }
  }
}

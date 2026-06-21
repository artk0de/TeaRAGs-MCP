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

import type { IndexOptions, IndexStats, ProgressCallback } from "../../../types.js";
import { IndexingFailedError } from "../errors.js";
import { cleanupOrphanedVersions, sweepCodegraphOrphans } from "../infra/alias-cleanup.js";
import { HeartbeatGuard } from "../infra/heartbeat-guard.js";
import { OptimizerLifecycle } from "../infra/optimizer-lifecycle.js";
import { BaseIndexingPipeline, type ProcessingContext } from "../pipeline/base.js";
import { processFiles } from "../pipeline/file-processor.js";
import { storeIndexingMarker } from "../pipeline/indexing-marker.js";
import { isDebug } from "../pipeline/infra/runtime.js";
import type { FileScanner } from "../pipeline/scanner.js";
import { QuarantineStore } from "../sync/index.js";
import { SnapshotCleaner } from "../sync/snapshot/snapshot-cleaner.js";
import { computeNewVersion } from "./version-resolver.js";

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
  async indexCodebase(
    path: string,
    options?: IndexOptions,
    progressCallback?: ProgressCallback,
    overrides?: { chunkSize?: number; modelInfo?: { model: string; contextLength: number; dimensions: number } },
  ): Promise<IndexStats> {
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

      const setup = await this.setupCollection(collectionName, absolutePath, options, overrides?.modelInfo?.dimensions);
      /* v8 ignore next 7 -- defensive guard: facade handles exists-without-force via reindexChanges */
      if (!setup.ready) {
        stats.status = "failed";
        stats.durationMs = Date.now() - startTime;
        stats.errors?.push(
          `Collection already exists. Use forceReindex=true to re-index from scratch, or use reindexChanges for incremental updates.`,
        );
        return stats;
      }

      // Poison-pill quarantine is bound to the base collection's snapshot dir.
      // A full reindex (forceReindex) wipes the slate; otherwise broken files
      // recorded on this pass are retried by the next reindex_changes.
      const quarantineStore = new QuarantineStore(this.snapshotDir, collectionName);
      if (options?.forceReindex) {
        await quarantineStore.clearAll();
      }

      const ctx = this.initProcessing(setup.targetCollection, absolutePath, scanner, undefined, overrides?.chunkSize);
      // Embed-phase poison-pill isolation: an oversized chunk quarantines its
      // file instead of aborting the whole pass.
      ctx.chunkPipeline.setQuarantineStore(quarantineStore);

      const heartbeat = new HeartbeatGuard({
        start: () => {
          this.startHeartbeat(setup.targetCollection);
          return () => {
            this.stopHeartbeat();
          };
        },
      });

      return await heartbeat.run(async () => {
        // Pause HNSW indexing while we bulk-ingest. Reactive HNSW build during
        // upserts otherwise throttles ingest; deferring to a single post-ingest
        // pass is 2-3× faster on large codebases. `deleted_threshold` pause is
        // harmless here (no deletes during initial index).
        return new OptimizerLifecycle(this.qdrant).with(setup.targetCollection, async () => {
          const result = await this.processAndTrack(files, absolutePath, ctx, quarantineStore, progressCallback);
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

          await this.finalizeAlias(collectionName, setup);
          await storeIndexingMarker(this.qdrant, this.embeddings, setup.targetCollection, true, overrides?.modelInfo);
          await this.saveSnapshot(absolutePath, collectionName, files, stats, setup.aliasVersion);
          await this.recordRegistryEntry(collectionName, absolutePath);

          const enrichmentResult = getEnrichmentStatus();
          stats.enrichmentStatus = enrichmentResult.status;
          stats.enrichmentMetrics = enrichmentResult.metrics;
          stats.durationMs = Date.now() - startTime;
          return stats;
        });
      });
    } catch (error) {
      this.wrapUnexpectedError(error, IndexingFailedError);
    } finally {
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
    dimensionsOverride?: number,
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

    // Derive version from Qdrant truth (NOT from the snapshot, which can lag or
    // be lost and hand back a colliding version). The snapshot is still
    // loaded/written elsewhere for sync purposes — it is just no longer the
    // version source. See version-resolver.ts.
    const isAlias = exists ? await this.qdrant.aliases.isAlias(collectionName) : false;
    const aliasTargetCollection = isAlias
      ? (await this.qdrant.aliases.listAliases()).find((a) => a.aliasName === collectionName)?.collectionName
      : undefined;
    const allCollections = await this.qdrant.listCollections();

    // Detect migration: real collection exists but is not an alias
    const isMigration = exists && !isAlias;

    // Compute new version from the live alias target + any leftover versioned
    // collections (orphans), so a new version never re-collides with state Qdrant
    // already holds.
    const newVersion = computeNewVersion({
      collectionName,
      aliasTargetCollection,
      allCollections,
      isMigration,
    });
    const versionedName = `${collectionName}_v${newVersion}`;
    // The collection to switch the alias away from is exactly what the alias
    // currently points to (undefined on first index / migration).
    const previousCollection = aliasTargetCollection;

    // Orphan cleanup before creating new version — also drops the per-version
    // codegraph DuckDB file for each deleted orphan (best-effort, non-fatal).
    await cleanupOrphanedVersions(this.qdrant, collectionName, this.codegraphRemover);

    // Ancient-orphan sweep: reclaim `<base>_v<N>.duckdb` files whose Qdrant
    // collection is already gone (invisible to cleanupOrphanedVersions, which
    // only iterates live Qdrant collections). Skips the active alias target and
    // any DB still backed by a live Qdrant collection. Best-effort, non-fatal.
    if (this.codegraphLister && this.codegraphRemover) {
      await sweepCodegraphOrphans(this.qdrant, collectionName, this.codegraphLister, this.codegraphRemover);
    }

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
    const vectorSize = dimensionsOverride ?? this.embeddings.getDimensions();
    await this.qdrant.createCollection(
      versionedName,
      vectorSize,
      "Cosine",
      this.config.enableHybridSearch,
      this.config.quantizationScalar,
    );

    const schemaManager = this.deps.createSchemaManager(versionedName);
    await schemaManager.initializeSchema(versionedName);
    await storeIndexingMarker(this.qdrant, this.embeddings, versionedName, false, undefined, this.teaRagsVersion);

    return {
      ready: true,
      targetCollection: versionedName,
      previousCollection,
      aliasVersion: newVersion,
      // First index: nothing exists yet (no alias, no real collection).
      isFirstIndex: !exists && !isMigration,
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
      // Drop the migrated-away collection's codegraph DB (best-effort).
      await this.removeCodegraphDb(collectionName);
    } else if (setup.previousCollection) {
      // Atomic switch — zero downtime
      await this.qdrant.aliases.switchAlias(collectionName, setup.previousCollection, setup.targetCollection);
      await this.qdrant.deleteCollection(setup.previousCollection);
      // Drop the superseded version's per-version codegraph DB (best-effort) —
      // otherwise it leaks alongside every reindex (the deleted Qdrant
      // collection's DuckDB file is never reclaimed by orphan cleanup, which
      // only sees the NEXT reindex's orphans).
      await this.removeCodegraphDb(setup.previousCollection);
    }
  }

  /**
   * Remove a deleted collection's per-version codegraph DuckDB file. Best-effort
   * and non-fatal — a missing file is a no-op and any remover failure is
   * swallowed (logged in debug) so codegraph cleanup never aborts finalization.
   * No-op when codegraph is disabled (no remover wired).
   */
  private async removeCodegraphDb(collectionName: string): Promise<void> {
    if (!this.codegraphRemover) return;
    await this.codegraphRemover(collectionName).catch((err) => {
      if (isDebug()) {
        console.error(`[Index] codegraph DB cleanup failed for ${collectionName} (non-fatal):`, err);
      }
    });
  }

  // ── File processing ────────────────────────────────────

  private async processAndTrack(
    files: string[],
    absolutePath: string,
    ctx: ProcessingContext,
    quarantineStore: QuarantineStore,
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
        quarantineStore,
        // yl9tv cross-pass tee is DEFERRED to Task 5b (tea-rags-mcp-why9b):
        // codegraph enrichment runs off-thread (workerDescriptor), so feeding
        // the MAIN-thread provider's acceptExtraction never reaches the worker
        // that actually parses — the worker still re-parses (jitter persists)
        // AND the main-thread sink is never finalized (spill leak). Re-enable
        // only with the worker-owned input-spill protocol (see the handoff
        // doc). Until then the worker keeps its extractOneFile path (baseline).
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

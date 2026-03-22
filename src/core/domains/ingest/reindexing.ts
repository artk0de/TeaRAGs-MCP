/**
 * ReindexPipeline - Incremental re-indexing of changed files.
 *
 * Orchestrates: scan → detect changes → classify ignore changes →
 * delete old → process new/modified → snapshot.
 * File processing logic is delegated to FileProcessor.
 */

import { TeaRagsError } from "../../infra/errors.js";
import type { ChangeStats, ChunkLookupEntry, FileChanges, ProgressCallback } from "../../types.js";
import { NotIndexedError, ReindexFailedError, SnapshotMissingError } from "./errors.js";
import { BaseIndexingPipeline, type PipelineTuning, type ProcessingContext } from "./pipeline/base.js";
import { processRelativeFiles } from "./pipeline/file-processor.js";
import { storeIndexingMarker } from "./pipeline/indexing-marker.js";
import { pipelineLog } from "./pipeline/infra/debug-logger.js";
import { isDebug } from "./pipeline/infra/runtime.js";
import type { FileScanner } from "./pipeline/scanner.js";
import { performDeletion, type DeletionConfig } from "./sync/deletion-strategy.js";
import type { ParallelFileSynchronizer } from "./sync/parallel-synchronizer.js";
import { SnapshotCleaner } from "./sync/snapshot-cleaner.js";

interface ReindexContext {
  absolutePath: string;
  collectionName: string;
  synchronizer: ParallelFileSynchronizer;
  scanner: FileScanner;
  currentFiles: string[];
}

export class ReindexPipeline extends BaseIndexingPipeline {
  constructor(
    qdrant: ConstructorParameters<typeof BaseIndexingPipeline>[0],
    embeddings: ConstructorParameters<typeof BaseIndexingPipeline>[1],
    config: ConstructorParameters<typeof BaseIndexingPipeline>[2],
    enrichment: ConstructorParameters<typeof BaseIndexingPipeline>[3],
    deps: ConstructorParameters<typeof BaseIndexingPipeline>[4],
    private readonly deleteConfig: DeletionConfig = { batchSize: 500, concurrency: 8 },
    tuning?: PipelineTuning,
  ) {
    super(qdrant, embeddings, config, enrichment, deps, tuning);
  }

  async reindexChanges(path: string, progressCallback?: ProgressCallback): Promise<ChangeStats> {
    const startTime = Date.now();
    const { absolutePath, collectionName } = await this.resolveContext(path);
    const stats: ChangeStats = {
      filesAdded: 0,
      filesModified: 0,
      filesDeleted: 0,
      filesNewlyIgnored: 0,
      filesNewlyUnignored: 0,
      chunksAdded: 0,
      chunksDeleted: 0,
      durationMs: 0,
      status: "completed",
    };

    try {
      const ctx = await this.prepareReindexContext(absolutePath, collectionName);
      const resumeFromCheckpoint = await this.checkForCheckpoint(ctx.synchronizer);

      this.reportScanProgress(progressCallback, resumeFromCheckpoint);

      const changes = await this.detectFileChanges(ctx);
      stats.filesAdded = changes.added.length;
      stats.filesModified = changes.modified.length;
      stats.filesDeleted = changes.deleted.length;
      stats.filesNewlyIgnored = changes.newlyIgnored.length;
      stats.filesNewlyUnignored = changes.newlyUnignored.length;

      if (this.hasNoChanges(stats)) {
        await storeIndexingMarker(this.qdrant, this.embeddings, ctx.collectionName, true);
        await ctx.synchronizer.deleteCheckpoint();
        stats.durationMs = Date.now() - startTime;
        return stats;
      }

      // Deletion-only: no files to add/modify → skip pipeline init and enrichment
      if (changes.added.length === 0 && changes.modified.length === 0) {
        await this.executeDeletionOnly(ctx, changes, stats, progressCallback);
        await storeIndexingMarker(this.qdrant, this.embeddings, ctx.collectionName, true);
        await ctx.synchronizer.updateSnapshot(ctx.currentFiles);
        await ctx.synchronizer.deleteCheckpoint();
        stats.enrichmentStatus = "skipped";
        stats.durationMs = Date.now() - startTime;
        return stats;
      }

      const { chunksAdded, processingCtx, chunkMap } = await this.executeParallelPipelines(
        ctx,
        changes,
        progressCallback,
      );
      stats.chunksAdded = chunksAdded;

      await this.finalizeReindex(ctx, processingCtx, chunkMap, stats, startTime);
      return stats;
    } catch (error) {
      if (error instanceof TeaRagsError) {
        throw error;
      }
      const errorMessage = error instanceof Error ? error.message : String(error);
      throw new ReindexFailedError(errorMessage, error instanceof Error ? error : undefined);
    } finally {
      const cleaner = new SnapshotCleaner(this.snapshotDir, collectionName);
      await cleaner.cleanupAfterIndexing();
    }
  }

  // ── Preparation ──────────────────────────────────────────

  private async prepareReindexContext(absolutePath: string, collectionName: string): Promise<ReindexContext> {
    const exists = await this.qdrant.collectionExists(collectionName);
    if (!exists) {
      throw new NotIndexedError(absolutePath);
    }

    await this.runMigrations(collectionName, absolutePath);

    const synchronizer = this.deps.createSynchronizer(absolutePath, collectionName);
    const hasSnapshot = await synchronizer.initialize();
    if (!hasSnapshot) {
      throw new SnapshotMissingError(absolutePath);
    }

    const scanner = this.createScanner();
    const currentFiles = await this.scanFiles(absolutePath, scanner);

    return { absolutePath, collectionName, synchronizer, scanner, currentFiles };
  }

  private async runMigrations(collectionName: string, absolutePath: string): Promise<void> {
    const migrator = this.deps.createMigrator(collectionName, absolutePath);
    await migrator.ensureMigrated();

    const schemaManager = this.deps.createSchemaManager();
    const schemaMigration = await schemaManager.ensureCurrentSchema(collectionName);
    if (schemaMigration.migrationsApplied.length > 0) {
      pipelineLog.reindexPhase("schema_migration", {
        fromVersion: schemaMigration.fromVersion,
        toVersion: schemaMigration.toVersion,
        migrations: schemaMigration.migrationsApplied,
      });
    }
  }

  private async checkForCheckpoint(synchronizer: ParallelFileSynchronizer): Promise<boolean> {
    const checkpoint = await synchronizer.loadCheckpoint();
    if (checkpoint) {
      console.error(`[Reindex] Resuming from checkpoint: ${checkpoint.processedFiles.length} files already processed`);
      return true;
    }
    return false;
  }

  // ── Change detection ─────────────────────────────────────

  private async detectFileChanges(ctx: ReindexContext): Promise<FileChanges> {
    pipelineLog.stageStart("scan");
    const changes = await ctx.synchronizer.detectChanges(ctx.currentFiles);
    pipelineLog.stageEnd("scan");
    return changes;
  }

  // ── Parallel processing ──────────────────────────────────

  private async executeParallelPipelines(
    ctx: ReindexContext,
    changes: FileChanges,
    progressCallback?: ProgressCallback,
  ): Promise<{ chunksAdded: number; processingCtx: ProcessingContext; chunkMap: Map<string, ChunkLookupEntry[]> }> {
    const changedPaths = [...changes.added, ...changes.modified];
    const pCtx = this.initProcessing(ctx.collectionName, ctx.absolutePath, ctx.scanner, changedPaths);
    const chunkMap = new Map<string, ChunkLookupEntry[]>();

    const filesToDelete = [...changes.modified, ...changes.deleted];
    const addedFiles = [...changes.added];
    const modifiedFiles = [...changes.modified];

    const processOpts = {
      enableGitMetadata: this.config.enableGitMetadata === true,
      concurrency: this.tuning.fileConcurrency,
    };

    const parallelStart = Date.now();
    this.logParallelStart(filesToDelete, addedFiles, modifiedFiles);

    // Level 1: delete old chunks + process added files in parallel
    const deleteStartTime = Date.now();
    const deletePromise = performDeletion(
      this.qdrant,
      ctx.collectionName,
      filesToDelete,
      this.deleteConfig,
      progressCallback,
    );
    const addPromise = processRelativeFiles(
      addedFiles,
      ctx.absolutePath,
      pCtx.chunkerPool,
      pCtx.chunkPipeline,
      processOpts,
      chunkMap,
      "added",
    );

    pipelineLog.reindexPhase("DELETE_AND_ADD_STARTED", {
      deleteFiles: filesToDelete.length,
      addFiles: addedFiles.length,
    });

    await deletePromise;

    pipelineLog.reindexPhase("DELETE_COMPLETE", {
      durationMs: Date.now() - deleteStartTime,
      deleted: filesToDelete.length,
    });

    if (isDebug()) {
      console.error(`[Reindex] Delete complete, starting modified indexing (add still running in parallel)`);
    }

    // Level 2: process modified files (after delete completes)
    const modifiedStartTime = Date.now();
    const modifiedPromise = processRelativeFiles(
      modifiedFiles,
      ctx.absolutePath,
      pCtx.chunkerPool,
      pCtx.chunkPipeline,
      processOpts,
      chunkMap,
      "modified",
    );

    pipelineLog.reindexPhase("MODIFIED_STARTED", {
      modifiedFiles: modifiedFiles.length,
      addStillRunning: true,
    });

    const [addedChunks, modifiedChunks] = await Promise.all([addPromise, modifiedPromise]);

    pipelineLog.reindexPhase("ADD_AND_MODIFIED_COMPLETE", {
      addedChunks,
      modifiedChunks,
      addDurationMs: Date.now() - parallelStart,
      modifiedDurationMs: Date.now() - modifiedStartTime,
    });

    this.logPipelineStats(pCtx, parallelStart);

    return { chunksAdded: addedChunks + modifiedChunks, processingCtx: pCtx, chunkMap };
  }

  // ── Finalization ─────────────────────────────────────────

  private async finalizeReindex(
    ctx: ReindexContext,
    processingCtx: ProcessingContext,
    chunkMap: Map<string, ChunkLookupEntry[]>,
    stats: ChangeStats,
    startTime: number,
  ): Promise<void> {
    const getEnrichmentStatus = await this.finalizeProcessing(
      processingCtx,
      chunkMap,
      ctx.collectionName,
      ctx.absolutePath,
    );

    await storeIndexingMarker(this.qdrant, this.embeddings, ctx.collectionName, true);
    await ctx.synchronizer.updateSnapshot(ctx.currentFiles);
    await ctx.synchronizer.deleteCheckpoint();

    const enrichmentResult = getEnrichmentStatus();
    stats.enrichmentStatus = enrichmentResult.status;
    stats.enrichmentMetrics = enrichmentResult.metrics;
    stats.durationMs = Date.now() - startTime;

    if (isDebug()) {
      console.error(
        `[Reindex] Complete: ${stats.filesAdded} added, ` +
          `${stats.filesModified} modified, ${stats.filesDeleted} deleted${
            stats.filesNewlyIgnored > 0 ? `, ${stats.filesNewlyIgnored} newly ignored` : ""
          }${
            stats.filesNewlyUnignored > 0 ? `, ${stats.filesNewlyUnignored} newly unignored` : ""
          }. Created ${stats.chunksAdded} chunks in ${(stats.durationMs / 1000).toFixed(1)}s`,
      );
    }
  }

  // ── Deletion-only fast path ─────────────────────────────

  private async executeDeletionOnly(
    ctx: ReindexContext,
    changes: FileChanges,
    stats: ChangeStats,
    progressCallback?: ProgressCallback,
  ): Promise<void> {
    const filesToDelete = [...changes.deleted];

    pipelineLog.reindexPhase("DELETE_ONLY_START", { files: filesToDelete.length });

    await performDeletion(this.qdrant, ctx.collectionName, filesToDelete, this.deleteConfig, progressCallback);

    pipelineLog.reindexPhase("DELETE_ONLY_COMPLETE", { files: filesToDelete.length });

    if (isDebug()) {
      console.error(`[Reindex] Deletion-only: removed ${filesToDelete.length} files, skipping enrichment`);
    }
  }

  // ── Helpers ──────────────────────────────────────────────

  private hasNoChanges(stats: ChangeStats): boolean {
    return stats.filesAdded === 0 && stats.filesModified === 0 && stats.filesDeleted === 0;
  }

  private reportScanProgress(progressCallback: ProgressCallback | undefined, resume: boolean): void {
    progressCallback?.({
      phase: "scanning",
      current: 0,
      total: 100,
      percentage: 0,
      message: resume ? "Resuming from checkpoint..." : "Scanning for changes...",
    });
  }

  private logParallelStart(filesToDelete: string[], addedFiles: string[], modifiedFiles: string[]): void {
    pipelineLog.reindexPhase("PARALLEL_START", {
      deleted: filesToDelete.length,
      added: addedFiles.length,
      modified: modifiedFiles.length,
    });

    if (isDebug()) {
      console.error(
        `[Reindex] Starting parallel pipelines: ` +
          `delete=${filesToDelete.length}, added=${addedFiles.length}, modified=${modifiedFiles.length}`,
      );
    }
  }

  private logPipelineStats(pCtx: ProcessingContext, parallelStart: number): void {
    if (isDebug()) {
      const pipelineStats = pCtx.chunkPipeline.getStats();
      console.error(
        `[Reindex] ChunkPipeline before flush: ` +
          `pending=${pCtx.chunkPipeline.getPendingCount()}, ` +
          `processed=${pipelineStats.itemsProcessed}, ` +
          `batches=${pipelineStats.batchesProcessed}`,
      );
      console.error(
        `[Reindex] Parallel pipelines completed in ${Date.now() - parallelStart}ms ` +
          `(pipeline: ${pipelineStats.itemsProcessed} chunks in ${pipelineStats.batchesProcessed} batches, ` +
          `${pipelineStats.throughput.toFixed(1)} chunks/s)`,
      );
    }
  }
}

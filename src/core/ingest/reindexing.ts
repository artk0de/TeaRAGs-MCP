/**
 * ReindexPipeline - Incremental re-indexing of changed files.
 *
 * Orchestrates: scan → detect changes → delete old → process new/modified → snapshot.
 * File processing logic is delegated to FileProcessor.
 */

import type { ChangeStats, ChunkLookupEntry, ProgressCallback } from "../types.js";
import { BaseIndexingPipeline } from "./pipeline/base.js";
import { processRelativeFiles } from "./pipeline/file-processor.js";
import { pipelineLog } from "./pipeline/infra/debug-logger.js";
import { performDeletion } from "./sync/deletion-strategy.js";

export class ReindexPipeline extends BaseIndexingPipeline {
  async reindexChanges(path: string, progressCallback?: ProgressCallback): Promise<ChangeStats> {
    const startTime = Date.now();
    const stats: ChangeStats = {
      filesAdded: 0,
      filesModified: 0,
      filesDeleted: 0,
      chunksAdded: 0,
      chunksDeleted: 0,
      durationMs: 0,
      status: "completed",
    };

    try {
      const { absolutePath, collectionName } = await this.resolveContext(path);

      // Check if collection exists
      const exists = await this.qdrant.collectionExists(collectionName);
      if (!exists) {
        throw new Error(`Codebase not indexed: ${path}`);
      }

      // AUTO-MIGRATE: snapshots and schema
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

      // Initialize synchronizer
      const synchronizer = this.deps.createSynchronizer(absolutePath, collectionName);
      const hasSnapshot = await synchronizer.initialize();

      if (!hasSnapshot) {
        throw new Error("No previous snapshot found. Use index_codebase for initial indexing.");
      }

      // Check for checkpoint
      const checkpoint = await synchronizer.loadCheckpoint();
      let resumeFromCheckpoint = false;

      if (checkpoint) {
        resumeFromCheckpoint = true;
        console.error(
          `[Reindex] Resuming from checkpoint: ${checkpoint.processedFiles.length} files already processed`,
        );
      }

      // Scan current files
      progressCallback?.({
        phase: "scanning",
        current: 0,
        total: 100,
        percentage: 0,
        message: resumeFromCheckpoint ? "Resuming from checkpoint..." : "Scanning for changes...",
      });

      const scanner = this.createScanner();
      const currentFiles = await this.scanFiles(absolutePath, scanner);

      // Detect changes
      pipelineLog.stageStart("scan");
      const changes = await synchronizer.detectChanges(currentFiles);
      pipelineLog.stageEnd("scan");
      stats.filesAdded = changes.added.length;
      stats.filesModified = changes.modified.length;
      stats.filesDeleted = changes.deleted.length;

      if (stats.filesAdded === 0 && stats.filesModified === 0 && stats.filesDeleted === 0) {
        await synchronizer.deleteCheckpoint();
        stats.durationMs = Date.now() - startTime;
        return stats;
      }

      // Initialize processing components
      const ctx = this.initProcessing(collectionName, absolutePath, scanner);

      const chunkMap = new Map<string, ChunkLookupEntry[]>();
      const filesToDelete = [...changes.modified, ...changes.deleted];
      const addedFiles = [...changes.added];
      const modifiedFiles = [...changes.modified];

      const processOpts = { enableGitMetadata: this.config.enableGitMetadata === true };

      // PARALLEL PIPELINES: delete + add simultaneously, then modified after delete
      const parallelStart = Date.now();

      pipelineLog.reindexPhase("PARALLEL_START", {
        deleted: filesToDelete.length,
        added: addedFiles.length,
        modified: modifiedFiles.length,
      });

      if (process.env.DEBUG) {
        console.error(
          `[Reindex] Starting parallel pipelines: ` +
            `delete=${filesToDelete.length}, added=${addedFiles.length}, modified=${modifiedFiles.length}`,
        );
      }

      const deleteStartTime = Date.now();
      const deletePromise = performDeletion(this.qdrant, collectionName, filesToDelete, progressCallback);
      const addPromise = processRelativeFiles(
        addedFiles,
        absolutePath,
        ctx.chunkerPool,
        ctx.chunkPipeline,
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

      if (process.env.DEBUG) {
        console.error(`[Reindex] Delete complete, starting modified indexing (add still running in parallel)`);
      }

      const modifiedStartTime = Date.now();
      const modifiedPromise = processRelativeFiles(
        modifiedFiles,
        absolutePath,
        ctx.chunkerPool,
        ctx.chunkPipeline,
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

      // Flush, shutdown, and enrichment
      if (process.env.DEBUG) {
        const pipelineStats = ctx.chunkPipeline.getStats();
        console.error(
          `[Reindex] ChunkPipeline before flush: ` +
            `pending=${ctx.chunkPipeline.getPendingCount()}, ` +
            `processed=${pipelineStats.itemsProcessed}, ` +
            `batches=${pipelineStats.batchesProcessed}`,
        );
      }

      const getEnrichmentStatus = await this.finalizeProcessing(ctx, chunkMap, collectionName, absolutePath);

      const pipelineStats = ctx.chunkPipeline.getStats();
      if (process.env.DEBUG) {
        console.error(
          `[Reindex] Parallel pipelines completed in ${Date.now() - parallelStart}ms ` +
            `(pipeline: ${pipelineStats.itemsProcessed} chunks in ${pipelineStats.batchesProcessed} batches, ` +
            `${pipelineStats.throughput.toFixed(1)} chunks/s)`,
        );
      }

      stats.chunksAdded = addedChunks + modifiedChunks;

      // Update snapshot
      await synchronizer.updateSnapshot(currentFiles);
      await synchronizer.deleteCheckpoint();

      stats.enrichmentStatus = getEnrichmentStatus();
      stats.durationMs = Date.now() - startTime;

      if (process.env.DEBUG) {
        console.error(
          `[Reindex] Complete: ${stats.filesAdded} added, ` +
            `${stats.filesModified} modified, ${stats.filesDeleted} deleted. ` +
            `Created ${stats.chunksAdded} chunks in ${(stats.durationMs / 1000).toFixed(1)}s`,
        );
      }

      return stats;
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      throw new Error(`Incremental re-indexing failed: ${errorMessage}`);
    }
  }
}

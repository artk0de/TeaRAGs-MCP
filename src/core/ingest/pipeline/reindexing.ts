/**
 * ReindexPipeline - Incremental re-indexing of changed files.
 *
 * Orchestrates: scan → detect changes → delete old → process new/modified → snapshot.
 * File processing logic is delegated to FileProcessor.
 */

import { homedir } from "node:os";
import { join } from "node:path";

import { SchemaManager } from "../../adapters/qdrant/schema-migration.js";
import { resolveCollectionName, validatePath } from "../../api/shared.js";
import type { ChangeStats, ChunkLookupEntry, ProgressCallback } from "../../types.js";
import { BaseIndexingPipeline } from "./base.js";
import { pipelineLog } from "./debug-logger.js";
import { processFiles } from "./file-processor.js";
import { SnapshotMigrator } from "../sync/migration.js";
import { ParallelFileSynchronizer } from "../sync/parallel-synchronizer.js";

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
      const absolutePath = await validatePath(path);
      const collectionName = resolveCollectionName(absolutePath);

      // Check if collection exists
      const exists = await this.qdrant.collectionExists(collectionName);
      if (!exists) {
        throw new Error(`Codebase not indexed: ${path}`);
      }

      // AUTO-MIGRATE: snapshots and schema
      const snapshotDir = join(homedir(), ".tea-rags-mcp", "snapshots");
      const migrator = new SnapshotMigrator(snapshotDir, collectionName, absolutePath);
      await migrator.ensureMigrated();

      const schemaManager = new SchemaManager(this.qdrant);
      const schemaMigration = await schemaManager.ensureCurrentSchema(collectionName);
      if (schemaMigration.migrationsApplied.length > 0) {
        pipelineLog.reindexPhase("schema_migration", {
          fromVersion: schemaMigration.fromVersion,
          toVersion: schemaMigration.toVersion,
          migrations: schemaMigration.migrationsApplied,
        });
      }

      // Initialize synchronizer
      const synchronizer = new ParallelFileSynchronizer(absolutePath, collectionName, snapshotDir);
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
      const chunkerPool = this.createChunkerPool();
      const chunkPipeline = this.createChunkPipeline(collectionName);
      this.setupEnrichmentHooks(chunkPipeline, absolutePath, collectionName, scanner.getIgnoreFilter());
      chunkPipeline.start();

      const chunkMap = new Map<string, ChunkLookupEntry[]>();
      const filesToDelete = [...changes.modified, ...changes.deleted];
      const addedFiles = [...changes.added];
      const modifiedFiles = [...changes.modified];

      // Helper: index files via shared FileProcessor (resolves relative → absolute)
      const indexFiles = async (files: string[], label: string): Promise<number> => {
        if (files.length === 0) return 0;

        const absolutePaths = files.map((f) => join(absolutePath, f));

        if (process.env.DEBUG) {
          console.error(`[Reindex] ${label}: starting ${files.length} files`);
        }

        const result = await processFiles(
          absolutePaths,
          absolutePath,
          chunkerPool,
          chunkPipeline,
          { enableGitMetadata: this.config.enableGitMetadata === true },
        );

        // Merge chunkMap entries
        for (const [key, entries] of result.chunkMap) {
          const existing = chunkMap.get(key) || [];
          chunkMap.set(key, [...existing, ...entries]);
        }

        if (process.env.DEBUG) {
          console.error(`[Reindex] ${label}: completed ${files.length} files, ${result.chunksCreated} chunks queued`);
        }

        return result.chunksCreated;
      };

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
      const deletePromise = this.performDeletion(collectionName, filesToDelete, progressCallback);
      const addPromise = indexFiles(addedFiles, "added");

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
      const modifiedPromise = indexFiles(modifiedFiles, "modified");

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

      // Flush and shutdown
      if (process.env.DEBUG) {
        const pipelineStats = chunkPipeline.getStats();
        console.error(
          `[Reindex] ChunkPipeline before flush: ` +
            `pending=${chunkPipeline.getPendingCount()}, ` +
            `processed=${pipelineStats.itemsProcessed}, ` +
            `batches=${pipelineStats.batchesProcessed}`,
        );
      }

      await this.flushAndShutdown(chunkPipeline, chunkerPool);

      const pipelineStats = chunkPipeline.getStats();
      if (process.env.DEBUG) {
        console.error(
          `[Reindex] Parallel pipelines completed in ${Date.now() - parallelStart}ms ` +
            `(pipeline: ${pipelineStats.itemsProcessed} chunks in ${pipelineStats.batchesProcessed} batches, ` +
            `${pipelineStats.throughput.toFixed(1)} chunks/s)`,
        );
      }

      stats.chunksAdded = addedChunks + modifiedChunks;

      // Enrichment completion
      const getEnrichmentStatus = this.startEnrichment(chunkMap, collectionName, absolutePath);

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

  private async performDeletion(
    collectionName: string,
    filesToDelete: string[],
    progressCallback?: ProgressCallback,
  ): Promise<void> {
    if (filesToDelete.length === 0) return;

    progressCallback?.({
      phase: "scanning",
      current: 0,
      total: filesToDelete.length,
      percentage: 5,
      message: `Deleting old chunks for ${filesToDelete.length} files...`,
    });

    try {
      const deleteResult = await this.qdrant.deletePointsByPathsBatched(collectionName, filesToDelete, {
        batchSize: 100,
        concurrency: 4,
        onProgress: (deleted, total) => {
          progressCallback?.({
            phase: "scanning",
            current: deleted,
            total,
            percentage: 5 + Math.floor((deleted / total) * 5),
            message: `Deleting old chunks: ${deleted}/${total} files...`,
          });
        },
      });

      if (process.env.DEBUG) {
        console.error(
          `[Reindex] Deleted ${deleteResult.deletedPaths} paths in ${deleteResult.batchCount} batches (${deleteResult.durationMs}ms)`,
        );
      }
    } catch (error) {
      // FALLBACK LEVEL 1
      const errorMsg = error instanceof Error ? error.message : String(error);
      pipelineLog.fallback({ component: "Reindex" }, 1, `deletePointsByPathsBatched failed: ${errorMsg}`);
      console.error(
        `[Reindex] FALLBACK L1: deletePointsByPathsBatched failed for ${filesToDelete.length} paths:`,
        errorMsg,
      );

      try {
        const fallbackStart = Date.now();
        await this.qdrant.deletePointsByPaths(collectionName, filesToDelete);
        pipelineLog.step({ component: "Reindex" }, "FALLBACK_L1_SUCCESS", {
          durationMs: Date.now() - fallbackStart,
          paths: filesToDelete.length,
        });
        console.error(
          `[Reindex] FALLBACK L1 SUCCESS: deletePointsByPaths completed in ${Date.now() - fallbackStart}ms`,
        );
      } catch (fallbackError) {
        // FALLBACK LEVEL 2
        const fallbackErrorMsg = fallbackError instanceof Error ? fallbackError.message : String(fallbackError);
        pipelineLog.fallback({ component: "Reindex" }, 2, `deletePointsByPaths failed: ${fallbackErrorMsg}`);
        console.error(`[Reindex] FALLBACK L2: deletePointsByPaths also failed:`, fallbackErrorMsg);
        console.error(
          `[Reindex] FALLBACK L2: Starting INDIVIDUAL deletions for ${filesToDelete.length} paths (SLOW!)`,
        );

        let deleted = 0;
        let failed = 0;
        const individualStart = Date.now();

        for (const relativePath of filesToDelete) {
          try {
            const filter = {
              must: [{ key: "relativePath", match: { value: relativePath } }],
            };
            await this.qdrant.deletePointsByFilter(collectionName, filter);
            deleted++;
          } catch (innerError) {
            failed++;
            if (process.env.DEBUG) {
              console.error(`[Reindex] FALLBACK L2: Failed to delete ${relativePath}:`, innerError);
            }
          }
        }

        pipelineLog.step({ component: "Reindex" }, "FALLBACK_L2_COMPLETE", {
          deleted,
          failed,
          durationMs: Date.now() - individualStart,
        });
        console.error(
          `[Reindex] FALLBACK L2 COMPLETE: ${deleted} deleted, ${failed} failed in ${Date.now() - individualStart}ms`,
        );
      }
    }
  }
}

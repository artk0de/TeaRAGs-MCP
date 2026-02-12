/**
 * ReindexModule - Incremental re-indexing of changed files.
 *
 * Extracted from CodeIndexer to isolate the incremental update logic.
 */

import { promises as fs } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { EmbeddingProvider } from "../../embeddings/base.js";
import type { QdrantManager } from "../../qdrant/client.js";
import { ChunkerPool } from "../chunker/chunker-pool.js";
import { MetadataExtractor } from "../metadata.js";
import { ChunkPipeline, DEFAULT_CONFIG } from "../pipeline/index.js";
import { pipelineLog } from "../pipeline/debug-logger.js";
import { FileScanner } from "../scanner.js";
import { SchemaManager } from "../schema-migration.js";
import { SnapshotMigrator } from "../sync/migration.js";
import { ParallelFileSynchronizer, parallelLimit } from "../sync/parallel-synchronizer.js";
import type {
  ChangeStats,
  ChunkLookupEntry,
  CodeChunk,
  CodeConfig,
  ProgressCallback,
} from "../types.js";
import { validatePath, resolveCollectionName } from "./shared.js";
import type { EnrichmentModule } from "./enrichment-module.js";

export class ReindexModule {
  constructor(
    private qdrant: QdrantManager,
    private embeddings: EmbeddingProvider,
    private config: CodeConfig,
    private enrichment: EnrichmentModule,
  ) {}

  /**
   * Incrementally re-index only changed files
   */
  async reindexChanges(
    path: string,
    progressCallback?: ProgressCallback,
  ): Promise<ChangeStats> {
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

      // AUTO-MIGRATE: Upgrade old snapshots to v3 (sharded) if needed
      const snapshotDir = join(homedir(), ".tea-rags-mcp", "snapshots");
      const migrator = new SnapshotMigrator(snapshotDir, collectionName, absolutePath);
      await migrator.ensureMigrated();

      // AUTO-MIGRATE: Upgrade collection schema to v4 (payload indexes) if needed
      const schemaManager = new SchemaManager(this.qdrant);
      const schemaMigration = await schemaManager.ensureCurrentSchema(collectionName);
      if (schemaMigration.migrationsApplied.length > 0) {
        pipelineLog.reindexPhase("schema_migration", {
          fromVersion: schemaMigration.fromVersion,
          toVersion: schemaMigration.toVersion,
          migrations: schemaMigration.migrationsApplied,
        });
      }

      // Initialize parallel synchronizer (uses sharded snapshots)
      const synchronizer = new ParallelFileSynchronizer(absolutePath, collectionName, snapshotDir);
      const hasSnapshot = await synchronizer.initialize();

      if (!hasSnapshot) {
        throw new Error(
          "No previous snapshot found. Use index_codebase for initial indexing.",
        );
      }

      // Check for existing checkpoint (resume from interruption)
      const checkpoint = await synchronizer.loadCheckpoint();
      let resumeFromCheckpoint = false;
      let alreadyProcessedFiles = new Set<string>();

      if (checkpoint) {
        resumeFromCheckpoint = true;
        alreadyProcessedFiles = new Set(checkpoint.processedFiles);
        console.error(
          `[Reindex] Resuming from checkpoint: ${checkpoint.processedFiles.length} files already processed`
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

      const scanner = new FileScanner({
        supportedExtensions: this.config.supportedExtensions,
        ignorePatterns: this.config.ignorePatterns,
        customIgnorePatterns: this.config.customIgnorePatterns,
      });

      await scanner.loadIgnorePatterns(absolutePath);
      pipelineLog.resetProfiler();
      pipelineLog.stageStart("scan");
      const currentFiles = await scanner.scanDirectory(absolutePath);
      pipelineLog.stageEnd("scan");

      // Detect changes
      pipelineLog.stageStart("scan");
      const changes = await synchronizer.detectChanges(currentFiles);
      pipelineLog.stageEnd("scan");
      stats.filesAdded = changes.added.length;
      stats.filesModified = changes.modified.length;
      stats.filesDeleted = changes.deleted.length;

      if (
        stats.filesAdded === 0 &&
        stats.filesModified === 0 &&
        stats.filesDeleted === 0
      ) {
        // Clean up checkpoint if exists
        await synchronizer.deleteCheckpoint();
        stats.durationMs = Date.now() - startTime;
        return stats;
      }

      // Checkpoint configuration
      const CHECKPOINT_INTERVAL = 100; // Save checkpoint every N files

      const chunkerConfig = {
        chunkSize: this.config.chunkSize,
        chunkOverlap: this.config.chunkOverlap,
        maxChunkSize: this.config.chunkSize * 2,
      };
      const chunkerPoolSize = parseInt(process.env.CHUNKER_POOL_SIZE || "4", 10);
      const chunkerPool = new ChunkerPool(chunkerPoolSize, chunkerConfig);
      const metadataExtractor = new MetadataExtractor();

      // Phase 2 chunk tracking: maps absolute file paths to chunk entries for git enrichment
      const chunkMap = new Map<string, ChunkLookupEntry[]>();

      // OPTIMIZATION: Parallel pipelines for delete and index operations
      const filesToDelete = [...changes.modified, ...changes.deleted];
      const addedFiles = [...changes.added];
      const modifiedFiles = [...changes.modified];

      // Helper function to perform deletion
      const performDeletion = async (): Promise<void> => {
        if (filesToDelete.length === 0) return;

        progressCallback?.({
          phase: "scanning",
          current: 0,
          total: filesToDelete.length,
          percentage: 5,
          message: `Deleting old chunks for ${filesToDelete.length} files...`,
        });

        try {
          const deleteResult = await this.qdrant.deletePointsByPathsBatched(
            collectionName,
            filesToDelete,
            {
              batchSize: 100,
              concurrency: 4,
              onProgress: (deleted, total) => {
                progressCallback?.({
                  phase: "scanning",
                  current: deleted,
                  total: total,
                  percentage: 5 + Math.floor((deleted / total) * 5),
                  message: `Deleting old chunks: ${deleted}/${total} files...`,
                });
              },
            },
          );

          if (process.env.DEBUG) {
            console.error(
              `[Reindex] Deleted ${deleteResult.deletedPaths} paths in ${deleteResult.batchCount} batches (${deleteResult.durationMs}ms)`,
            );
          }
        } catch (error) {
          // FALLBACK LEVEL 1: Batched delete failed, trying single combined request
          const errorMsg = error instanceof Error ? error.message : String(error);
          pipelineLog.fallback({ component: "Reindex" }, 1, `deletePointsByPathsBatched failed: ${errorMsg}`);
          console.error(
            `[Reindex] FALLBACK L1: deletePointsByPathsBatched failed for ${filesToDelete.length} paths:`,
            errorMsg
          );

          try {
            const fallbackStart = Date.now();
            await this.qdrant.deletePointsByPaths(collectionName, filesToDelete);
            pipelineLog.step({ component: "Reindex" }, "FALLBACK_L1_SUCCESS", {
              durationMs: Date.now() - fallbackStart,
              paths: filesToDelete.length,
            });
            console.error(
              `[Reindex] FALLBACK L1 SUCCESS: deletePointsByPaths completed in ${Date.now() - fallbackStart}ms`
            );
          } catch (fallbackError) {
            // FALLBACK LEVEL 2: Combined request also failed, doing individual deletions
            const fallbackErrorMsg = fallbackError instanceof Error ? fallbackError.message : String(fallbackError);
            pipelineLog.fallback({ component: "Reindex" }, 2, `deletePointsByPaths failed: ${fallbackErrorMsg}`);
            console.error(
              `[Reindex] FALLBACK L2: deletePointsByPaths also failed:`,
              fallbackErrorMsg
            );
            console.error(
              `[Reindex] FALLBACK L2: Starting INDIVIDUAL deletions for ${filesToDelete.length} paths (SLOW!)`
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
              `[Reindex] FALLBACK L2 COMPLETE: ${deleted} deleted, ${failed} failed in ${Date.now() - individualStart}ms`
            );
          }
        }
      };

      // Initialize ChunkPipeline for even load distribution
      // This replaces direct embedding/store calls with a batching pipeline
      const chunkPipeline = new ChunkPipeline(
        this.qdrant,
        this.embeddings,
        collectionName,
        {
          workerPool: DEFAULT_CONFIG.workerPool,
          accumulator: DEFAULT_CONFIG.upsertAccumulator,
          enableHybrid: this.config.enableHybridSearch,
        },
      );
      // Start git log reading in parallel with embedding (Phase 2a prefetch)
      if (this.config.enableGitMetadata) {
        this.enrichment.prefetchGitLog(absolutePath, collectionName, scanner.getIgnoreFilter());
        chunkPipeline.setOnBatchUpserted((items) => {
          this.enrichment.onChunksStored(collectionName, absolutePath, items);
        });
      }

      chunkPipeline.start();

      // STREAMING: Helper function to index files with bounded concurrency
      // Chunks are sent to pipeline immediately as files are processed
      const indexFiles = async (
        files: string[],
        label: string
      ): Promise<number> => {
        if (files.length === 0) return 0;

        let chunksCreated = 0;
        const streamingConcurrency = parseInt(process.env.FILE_PROCESSING_CONCURRENCY || "50", 10);

        if (process.env.DEBUG) {
          console.error(`[Reindex] ${label}: starting ${files.length} files (streaming, concurrency=${streamingConcurrency})`);
        }

        // STREAMING: Process files with bounded concurrency, send chunks immediately
        await parallelLimit(
          files,
          async (filePath) => {
            try {
              const absoluteFilePath = join(absolutePath, filePath);
              const code = await fs.readFile(absoluteFilePath, "utf-8");

              if (metadataExtractor.containsSecrets(code)) {
                return;
              }

              const language = metadataExtractor.extractLanguage(absoluteFilePath);
              const { imports } = metadataExtractor.extractImportsExports(code, language);
              const parseStart = Date.now();
              const { chunks } = await chunkerPool.processFile(absoluteFilePath, code, language);
              pipelineLog.addStageTime("parse", Date.now() - parseStart);

              // Process and send chunks IMMEDIATELY (streaming)
              for (const chunk of chunks) {
                const baseChunk = {
                  content: chunk.content,
                  startLine: chunk.startLine,
                  endLine: chunk.endLine,
                  metadata: {
                    filePath: chunk.metadata.filePath,
                    language: chunk.metadata.language,
                    chunkIndex: chunk.metadata.chunkIndex,
                    name: chunk.metadata.name,
                    chunkType: chunk.metadata.chunkType,
                    parentName: chunk.metadata.parentName,
                    parentType: chunk.metadata.parentType,
                    symbolId: chunk.metadata.symbolId,
                    isDocumentation: chunk.metadata.isDocumentation,
                    ...(imports.length > 0 && { imports }),
                  } as CodeChunk["metadata"],
                };

                // Wait for backpressure if needed
                if (chunkPipeline.isBackpressured()) {
                  await chunkPipeline.waitForBackpressure(30000);
                }

                // IMMEDIATE: Send chunk to pipeline right away
                const chunkId = metadataExtractor.generateChunkId(chunk);
                chunkPipeline.addChunk(
                  baseChunk as CodeChunk,
                  chunkId,
                  absolutePath,
                );
                chunksCreated++;

                // Track for Phase 2 git enrichment
                if (this.config.enableGitMetadata) {
                  const entries = chunkMap.get(absoluteFilePath) || [];
                  entries.push({ chunkId, startLine: chunk.startLine, endLine: chunk.endLine });
                  chunkMap.set(absoluteFilePath, entries);
                }
              }

            } catch (error) {
              console.error(`Failed to process ${filePath}:`, error);
            }
          },
          streamingConcurrency,
        );

        if (process.env.DEBUG) {
          console.error(`[Reindex] ${label}: completed ${files.length} files, ${chunksCreated} chunks queued`);
        }

        return chunksCreated;
      };

      // PARALLEL PIPELINES: Optimized for maximum throughput
      // - Delete and Add start simultaneously (Add doesn't need old chunks deleted)
      // - Modified starts immediately after Delete (doesn't wait for Add)
      // - Add and Modified can run in parallel after Delete completes
      const startTime2 = Date.now();

      pipelineLog.reindexPhase("PARALLEL_START", {
        deleted: filesToDelete.length,
        added: addedFiles.length,
        modified: modifiedFiles.length,
      });

      if (process.env.DEBUG) {
        console.error(
          `[Reindex] Starting parallel pipelines: ` +
          `delete=${filesToDelete.length}, added=${addedFiles.length}, modified=${modifiedFiles.length}`
        );
      }

      // Start both Delete and Add simultaneously
      const deleteStartTime = Date.now();
      const deletePromise = performDeletion();
      const addPromise = indexFiles(addedFiles, "added");

      pipelineLog.reindexPhase("DELETE_AND_ADD_STARTED", {
        deleteFiles: filesToDelete.length,
        addFiles: addedFiles.length,
      });

      // Modified only needs to wait for Delete (not Add!)
      // This allows Modified and Add to run in parallel after Delete completes
      await deletePromise;

      pipelineLog.reindexPhase("DELETE_COMPLETE", {
        durationMs: Date.now() - deleteStartTime,
        deleted: filesToDelete.length,
      });

      if (process.env.DEBUG) {
        console.error(
          `[Reindex] Delete complete, starting modified indexing (add still running in parallel)`
        );
      }

      // Start Modified - now runs in parallel with remaining Add work
      const modifiedStartTime = Date.now();
      const modifiedPromise = indexFiles(modifiedFiles, "modified");

      pipelineLog.reindexPhase("MODIFIED_STARTED", {
        modifiedFiles: modifiedFiles.length,
        addStillRunning: true,
      });

      // Wait for both Add and Modified to complete
      const [addedChunks, modifiedChunks] = await Promise.all([
        addPromise,
        modifiedPromise,
      ]);

      pipelineLog.reindexPhase("ADD_AND_MODIFIED_COMPLETE", {
        addedChunks,
        modifiedChunks,
        addDurationMs: Date.now() - startTime2,
        modifiedDurationMs: Date.now() - modifiedStartTime,
      });

      // Flush and shutdown ChunkPipeline to ensure all chunks are processed
      if (process.env.DEBUG) {
        const pipelineStats = chunkPipeline.getStats();
        console.error(
          `[Reindex] ChunkPipeline before flush: ` +
            `pending=${chunkPipeline.getPendingCount()}, ` +
            `processed=${pipelineStats.itemsProcessed}, ` +
            `batches=${pipelineStats.batchesProcessed}`
        );
      }

      await chunkPipeline.flush();
      await Promise.all([
        chunkPipeline.shutdown(),
        chunkerPool.shutdown(),
      ]);

      const pipelineStats = chunkPipeline.getStats();
      if (process.env.DEBUG) {
        console.error(
          `[Reindex] Parallel pipelines completed in ${Date.now() - startTime2}ms ` +
            `(pipeline: ${pipelineStats.itemsProcessed} chunks in ${pipelineStats.batchesProcessed} batches, ` +
            `${pipelineStats.throughput.toFixed(1)} chunks/s)`
        );
      }

      stats.chunksAdded = addedChunks + modifiedChunks;

      // Complete git enrichment — fire-and-forget
      if (this.config.enableGitMetadata && chunkMap.size > 0) {
        this.enrichment.startChunkChurn(collectionName, absolutePath, chunkMap);
        this.enrichment.awaitCompletion(collectionName).catch((error) => {
          console.error("[Reindex] Background enrichment failed:", error);
        });
        stats.enrichmentStatus = "background";
      } else if (!this.config.enableGitMetadata) {
        stats.enrichmentStatus = "skipped";
      }

      // Update snapshot
      await synchronizer.updateSnapshot(currentFiles);

      // Delete checkpoint on successful completion
      await synchronizer.deleteCheckpoint();

      stats.durationMs = Date.now() - startTime;

      if (process.env.DEBUG) {
        console.error(
          `[Reindex] Complete: ${stats.filesAdded} added, ` +
          `${stats.filesModified} modified, ${stats.filesDeleted} deleted. ` +
          `Created ${stats.chunksAdded} chunks in ${(stats.durationMs / 1000).toFixed(1)}s`
        );
      }

      return stats;
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      throw new Error(`Incremental re-indexing failed: ${errorMessage}`);
    }
  }
}

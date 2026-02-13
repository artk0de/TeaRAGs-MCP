/**
 * IndexingModule - Full codebase indexing from scratch.
 *
 * Extracted from CodeIndexer to isolate the initial indexing logic.
 */

import { promises as fs } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import type { EmbeddingProvider } from "../../embeddings/base.js";
import type { QdrantManager } from "../../qdrant/client.js";
import { ChunkerPool } from "../chunker/chunker-pool.js";
import { MetadataExtractor } from "../metadata.js";
import { pipelineLog } from "../pipeline/debug-logger.js";
import { ChunkPipeline, DEFAULT_CONFIG } from "../pipeline/index.js";
import { FileScanner } from "../scanner.js";
import { SchemaManager } from "../schema-migration.js";
import { ParallelFileSynchronizer, parallelLimit } from "../sync/parallel-synchronizer.js";
import type { ChunkLookupEntry, CodeChunk, CodeConfig, IndexOptions, IndexStats, ProgressCallback } from "../types.js";
import type { EnrichmentModule } from "./enrichment-module.js";
import { INDEXING_METADATA_ID, resolveCollectionName, validatePath } from "./shared.js";

export class IndexingModule {
  constructor(
    private readonly qdrant: QdrantManager,
    private readonly embeddings: EmbeddingProvider,
    private readonly config: CodeConfig,
    private readonly enrichment: EnrichmentModule,
  ) {}

  /**
   * Index a codebase from scratch or force re-index
   */
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

    const absolutePath = await validatePath(path);
    const collectionName = resolveCollectionName(absolutePath);

    try {
      // 1. Scan files
      progressCallback?.({
        phase: "scanning",
        current: 0,
        total: 100,
        percentage: 0,
        message: "Scanning files...",
      });

      const scanner = new FileScanner({
        supportedExtensions: options?.extensions || this.config.supportedExtensions,
        ignorePatterns: this.config.ignorePatterns,
        customIgnorePatterns: options?.ignorePatterns || this.config.customIgnorePatterns,
      });

      await scanner.loadIgnorePatterns(absolutePath);
      pipelineLog.resetProfiler();
      pipelineLog.stageStart("scan");
      const files = await scanner.scanDirectory(absolutePath);
      pipelineLog.stageEnd("scan");

      stats.filesScanned = files.length;

      if (files.length === 0) {
        stats.status = "completed";
        stats.durationMs = Date.now() - startTime;
        return stats;
      }

      // 2. Create or verify collection
      const collectionExists = await this.qdrant.collectionExists(collectionName);

      // Early return if collection already exists and forceReindex is not set
      // This prevents duplicate indexing - use reindexChanges for incremental updates
      if (collectionExists && !options?.forceReindex) {
        stats.status = "completed";
        stats.durationMs = Date.now() - startTime;
        stats.errors?.push(
          `Collection already exists. Use forceReindex=true to re-index from scratch, or use reindexChanges for incremental updates.`,
        );
        return stats;
      }

      if (options?.forceReindex && collectionExists) {
        await this.qdrant.deleteCollection(collectionName);
      }

      // Create new collection (either first time or after force delete)
      const vectorSize = this.embeddings.getDimensions();
      await this.qdrant.createCollection(collectionName, vectorSize, "Cosine", this.config.enableHybridSearch);

      // Initialize schema with payload indexes for optimal performance
      const schemaManager = new SchemaManager(this.qdrant);
      await schemaManager.initializeSchema(collectionName);

      // Store "indexing in progress" marker immediately after collection is ready
      await this.storeIndexingMarker(collectionName, false);

      // 3. Initialize parallel processing components
      const chunkerConfig = {
        chunkSize: this.config.chunkSize,
        chunkOverlap: this.config.chunkOverlap,
        maxChunkSize: this.config.chunkSize * 2,
      };
      const chunkerPoolSize = parseInt(process.env.CHUNKER_POOL_SIZE || "4", 10);
      const chunkerPool = new ChunkerPool(chunkerPoolSize, chunkerConfig);
      const metadataExtractor = new MetadataExtractor();
      const indexedFiles: string[] = [];

      // Initialize ChunkPipeline for parallel embedding and storage
      const chunkPipeline = new ChunkPipeline(this.qdrant, this.embeddings, collectionName, {
        workerPool: DEFAULT_CONFIG.workerPool,
        accumulator: DEFAULT_CONFIG.upsertAccumulator,
        enableHybrid: this.config.enableHybridSearch,
      });
      // Start git log reading in parallel with embedding (Phase 2a prefetch)
      if (this.config.enableGitMetadata) {
        this.enrichment.prefetchGitLog(absolutePath, collectionName, scanner.getIgnoreFilter());
        chunkPipeline.setOnBatchUpserted((items) => {
          this.enrichment.onChunksStored(collectionName, absolutePath, items);
        });
      }

      chunkPipeline.start();

      // 4. STREAMING: Process files with bounded concurrency, send chunks immediately
      // This eliminates burst-pause pattern by streaming chunks as files are processed
      const fileProcessingConcurrency = parseInt(process.env.FILE_PROCESSING_CONCURRENCY || "50", 10);
      let totalChunksQueued = 0;
      let filesProcessed = 0;

      // Phase 2 chunk tracking: maps absolute file paths to chunk entries for git enrichment
      const chunkMap = new Map<string, ChunkLookupEntry[]>();

      // STREAMING: Process files with bounded concurrency
      // Each file sends chunks to pipeline immediately after processing
      await parallelLimit(
        files,
        async (filePath) => {
          try {
            const code = await fs.readFile(filePath, "utf-8");

            // Check for secrets (basic detection)
            if (metadataExtractor.containsSecrets(code)) {
              stats.errors?.push(`Skipped ${filePath}: potential secrets detected`);
              return;
            }

            const language = metadataExtractor.extractLanguage(filePath);
            const { imports } = metadataExtractor.extractImportsExports(code, language);
            const parseStart = Date.now();
            const { chunks } = await chunkerPool.processFile(filePath, code, language);
            pipelineLog.addStageTime("parse", Date.now() - parseStart);

            // Apply chunk limits if configured
            const chunksToAdd = this.config.maxChunksPerFile ? chunks.slice(0, this.config.maxChunksPerFile) : chunks;

            // Process and send chunks IMMEDIATELY (streaming)
            for (const chunk of chunksToAdd) {
              // Check total chunk limit
              if (this.config.maxTotalChunks && totalChunksQueued >= this.config.maxTotalChunks) {
                return;
              }

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
              chunkPipeline.addChunk(baseChunk as CodeChunk, chunkId, absolutePath);
              totalChunksQueued++;

              // Track for Phase 2 git enrichment
              if (this.config.enableGitMetadata) {
                const entries = chunkMap.get(filePath) || [];
                entries.push({
                  chunkId,
                  startLine: chunk.startLine,
                  endLine: chunk.endLine,
                  lineRanges: chunk.metadata.lineRanges,
                });
                chunkMap.set(filePath, entries);
              }
            }

            stats.filesIndexed++;
            indexedFiles.push(filePath);
            filesProcessed++;

            // Report progress: first file, then every 10 files
            if (filesProcessed === 1 || filesProcessed % 10 === 0) {
              const pipelineStats = chunkPipeline.getStats();
              progressCallback?.({
                phase: "chunking",
                current: filesProcessed,
                total: files.length,
                percentage: 10 + Math.round((filesProcessed / files.length) * 40),
                message: `Processing: ${filesProcessed}/${files.length} files, ${pipelineStats.itemsProcessed}/${totalChunksQueued} chunks embedded`,
              });
            }
          } catch (error) {
            const errorMessage = error instanceof Error ? error.message : String(error);
            stats.errors?.push(`Skipped ${filePath}: ${errorMessage}`);
          }
        },
        fileProcessingConcurrency,
      );

      stats.chunksCreated = totalChunksQueued;

      // 5. Flush and shutdown pipeline to complete all pending operations
      progressCallback?.({
        phase: "storing",
        current: totalChunksQueued,
        total: totalChunksQueued,
        percentage: 90,
        message: "Finalizing embeddings and storage...",
      });

      await chunkPipeline.flush();
      await Promise.all([chunkPipeline.shutdown(), chunkerPool.shutdown()]);

      const finalPipelineStats = chunkPipeline.getStats();
      if (process.env.DEBUG) {
        console.error(
          `[Index] Pipeline completed: ${finalPipelineStats.itemsProcessed} chunks in ${finalPipelineStats.batchesProcessed} batches, ` +
            `${finalPipelineStats.throughput.toFixed(1)} chunks/s`,
        );
      }

      // Complete git enrichment — fire-and-forget.
      // Phase 2a (streaming applies + backfill) and Phase 2b (chunk churn) run in background.
      // We track the promise to check if it finishes before indexCodebase returns.
      let enrichmentDone = false;
      if (this.config.enableGitMetadata && chunkMap.size > 0) {
        this.enrichment.startChunkChurn(collectionName, absolutePath, chunkMap);
        this.enrichment
          .awaitCompletion(collectionName)
          .then(() => {
            enrichmentDone = true;
          })
          .catch((error) => {
            console.error("[Index] Background enrichment failed:", error);
          });
      } else if (!this.config.enableGitMetadata) {
        stats.enrichmentStatus = "skipped";
      }

      // Save snapshot for incremental updates
      try {
        const snapshotDir = join(homedir(), ".tea-rags-mcp", "snapshots");
        const synchronizer = new ParallelFileSynchronizer(absolutePath, collectionName, snapshotDir);
        await synchronizer.updateSnapshot(indexedFiles);
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        console.error("Failed to save snapshot:", errorMessage);
        stats.errors?.push(`Snapshot save failed: ${errorMessage}`);
      }

      // Store completion marker to indicate indexing is complete
      await this.storeIndexingMarker(collectionName, true);

      // Check enrichment status: it may have completed during snapshot/marker writes
      if (this.config.enableGitMetadata && chunkMap.size > 0) {
        stats.enrichmentStatus = enrichmentDone ? "completed" : "background";
      }

      stats.durationMs = Date.now() - startTime;
      return stats;
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      stats.status = "failed";
      stats.errors?.push(`Indexing failed: ${errorMessage}`);
      stats.durationMs = Date.now() - startTime;
      return stats;
    }
  }

  /**
   * Store an indexing status marker in the collection.
   * Called at the start of indexing with complete=false, and at the end with complete=true.
   */
  private async storeIndexingMarker(collectionName: string, complete: boolean): Promise<void> {
    try {
      if (complete) {
        // Use setPayload (merge) to avoid overwriting enrichment data
        // that may have been written by the background enrichment task.
        try {
          await this.qdrant.setPayload(
            collectionName,
            { indexingComplete: true, completedAt: new Date().toISOString() },
            { points: [INDEXING_METADATA_ID], wait: true },
          );
        } catch (error) {
          console.error("[IndexingMarker] Failed to set completion marker via setPayload:", error);
          // Fallback: overwrite the point (loses enrichment data but at least marks complete)
          const vectorSize = this.embeddings.getDimensions();
          const zeroVector: number[] = new Array<number>(vectorSize).fill(0);
          await this.qdrant.addPoints(collectionName, [
            {
              id: INDEXING_METADATA_ID,
              vector: zeroVector,
              payload: {
                _type: "indexing_metadata",
                indexingComplete: true,
                completedAt: new Date().toISOString(),
              },
            },
          ]);
        }
        return;
      }

      // Initial marker: create the point with a zero vector (required by Qdrant)
      const vectorSize = this.embeddings.getDimensions();
      const zeroVector: number[] = new Array<number>(vectorSize).fill(0);

      const collectionInfo = await this.qdrant.getCollectionInfo(collectionName);

      const payload = {
        _type: "indexing_metadata",
        indexingComplete: false,
        startedAt: new Date().toISOString(),
      };

      if (collectionInfo.hybridEnabled) {
        await this.qdrant.addPointsWithSparse(collectionName, [
          {
            id: INDEXING_METADATA_ID,
            vector: zeroVector,
            sparseVector: { indices: [], values: [] },
            payload,
          },
        ]);
      } else {
        await this.qdrant.addPoints(collectionName, [
          {
            id: INDEXING_METADATA_ID,
            vector: zeroVector,
            payload,
          },
        ]);
      }
    } catch (error) {
      // Non-fatal: log but don't fail the indexing
      console.error("Failed to store indexing marker:", error);
    }
  }
}

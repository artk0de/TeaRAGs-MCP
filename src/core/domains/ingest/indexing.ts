/**
 * IndexPipeline - Full codebase indexing from scratch.
 *
 * Orchestrates: scan → collection setup → file processing → snapshot → marker.
 * File processing logic is delegated to FileProcessor.
 */

import type { IndexOptions, IndexStats, ProgressCallback } from "../../types.js";
import { BaseIndexingPipeline } from "./pipeline/base.js";
import { processFiles } from "./pipeline/file-processor.js";
import { storeIndexingMarker } from "./pipeline/indexing-marker.js";
import { isDebug } from "./pipeline/infra/runtime.js";

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
      // 1. Scan files
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

      stats.filesScanned = files.length;

      if (files.length === 0) {
        stats.durationMs = Date.now() - startTime;
        return stats;
      }

      // 2. Create or verify collection
      const collectionExists = await this.qdrant.collectionExists(collectionName);

      if (collectionExists && !options?.forceReindex) {
        stats.durationMs = Date.now() - startTime;
        stats.errors?.push(
          `Collection already exists. Use forceReindex=true to re-index from scratch, or use reindexChanges for incremental updates.`,
        );
        return stats;
      }

      if (options?.forceReindex && collectionExists) {
        await this.qdrant.deleteCollection(collectionName);
      }

      const vectorSize = this.embeddings.getDimensions();
      await this.qdrant.createCollection(
        collectionName,
        vectorSize,
        "Cosine",
        this.config.enableHybridSearch,
        this.config.quantizationScalar,
      );

      const schemaManager = this.deps.createSchemaManager();
      await schemaManager.initializeSchema(collectionName);

      await storeIndexingMarker(this.qdrant, this.embeddings, collectionName, false);

      // 3. Initialize processing components
      const ctx = this.initProcessing(collectionName, absolutePath, scanner);

      // 4. Process files via shared FileProcessor
      let filesProcessed = 0;
      let chunksQueued = 0;
      const result = await processFiles(
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

      stats.filesIndexed = result.filesProcessed;
      stats.chunksCreated = result.chunksCreated;
      if (result.errors.length > 0) {
        stats.errors?.push(...result.errors);
      }

      // 5. Flush and shutdown
      progressCallback?.({
        phase: "storing",
        current: result.chunksCreated,
        total: result.chunksCreated,
        percentage: 90,
        message: "Finalizing embeddings and storage...",
      });

      const getEnrichmentStatus = await this.finalizeProcessing(ctx, result.chunkMap, collectionName, absolutePath);

      const finalPipelineStats = ctx.chunkPipeline.getStats();
      if (isDebug()) {
        console.error(
          `[Index] Pipeline completed: ${finalPipelineStats.itemsProcessed} chunks in ${finalPipelineStats.batchesProcessed} batches, ` +
            `${finalPipelineStats.throughput.toFixed(1)} chunks/s`,
        );
      }

      // 7. Save snapshot
      try {
        const synchronizer = this.deps.createSynchronizer(absolutePath, collectionName);
        await synchronizer.updateSnapshot(files);
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        console.error("Failed to save snapshot:", errorMessage);
        stats.errors?.push(`Snapshot save failed: ${errorMessage}`);
      }

      await storeIndexingMarker(this.qdrant, this.embeddings, collectionName, true);

      stats.enrichmentStatus = getEnrichmentStatus();
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
}

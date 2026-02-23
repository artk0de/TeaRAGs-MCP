/**
 * IndexPipeline - Full codebase indexing from scratch.
 *
 * Orchestrates: scan → collection setup → file processing → snapshot → marker.
 * File processing logic is delegated to FileProcessor.
 */

import { homedir } from "node:os";
import { join } from "node:path";

import { SchemaManager } from "../adapters/qdrant/schema-migration.js";
import { resolveCollectionName, validatePath } from "../api/shared.js";
import type { IndexOptions, IndexStats, ProgressCallback } from "../types.js";
import { BaseIndexingPipeline } from "./pipeline/base.js";
import { INDEXING_METADATA_ID } from "./constants.js";
import { processFiles } from "./pipeline/file-processor.js";
import { ParallelFileSynchronizer } from "./sync/parallel-synchronizer.js";

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
      await this.qdrant.createCollection(collectionName, vectorSize, "Cosine", this.config.enableHybridSearch);

      const schemaManager = new SchemaManager(this.qdrant);
      await schemaManager.initializeSchema(collectionName);

      await this.storeIndexingMarker(collectionName, false);

      // 3. Initialize processing components
      const chunkerPool = this.createChunkerPool();
      const chunkPipeline = this.createChunkPipeline(collectionName);
      this.setupEnrichmentHooks(chunkPipeline, absolutePath, collectionName, scanner.getIgnoreFilter());
      chunkPipeline.start();

      // 4. Process files via shared FileProcessor
      let filesProcessed = 0;
      let chunksQueued = 0;
      const result = await processFiles(
        files,
        absolutePath,
        chunkerPool,
        chunkPipeline,
        {
          enableGitMetadata: this.config.enableGitMetadata === true,
          maxChunksPerFile: this.config.maxChunksPerFile,
          maxTotalChunks: this.config.maxTotalChunks,
        },
        {
          onFileProcessed: (_filePath, chunksCount) => {
            filesProcessed++;
            chunksQueued += chunksCount;
            if (filesProcessed === 1 || filesProcessed % 10 === 0) {
              const pipelineStats = chunkPipeline.getStats();
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

      await this.flushAndShutdown(chunkPipeline, chunkerPool);

      const finalPipelineStats = chunkPipeline.getStats();
      if (process.env.DEBUG) {
        console.error(
          `[Index] Pipeline completed: ${finalPipelineStats.itemsProcessed} chunks in ${finalPipelineStats.batchesProcessed} batches, ` +
            `${finalPipelineStats.throughput.toFixed(1)} chunks/s`,
        );
      }

      // 6. Enrichment completion
      const getEnrichmentStatus = this.startEnrichment(result.chunkMap, collectionName, absolutePath);

      // 7. Save snapshot
      try {
        const snapshotDir = join(homedir(), ".tea-rags-mcp", "snapshots");
        const synchronizer = new ParallelFileSynchronizer(absolutePath, collectionName, snapshotDir);
        await synchronizer.updateSnapshot(files);
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        console.error("Failed to save snapshot:", errorMessage);
        stats.errors?.push(`Snapshot save failed: ${errorMessage}`);
      }

      await this.storeIndexingMarker(collectionName, true);

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

  private async storeIndexingMarker(collectionName: string, complete: boolean): Promise<void> {
    try {
      if (complete) {
        try {
          await this.qdrant.setPayload(
            collectionName,
            { indexingComplete: true, completedAt: new Date().toISOString() },
            { points: [INDEXING_METADATA_ID], wait: true },
          );
        } catch (error) {
          console.error("[IndexingMarker] Failed to set completion marker via setPayload:", error);
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
      console.error("Failed to store indexing marker:", error);
    }
  }
}

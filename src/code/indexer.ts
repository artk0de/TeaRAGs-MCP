/**
 * CodeIndexer - Main orchestrator for code vectorization
 */

import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import { homedir } from "node:os";
import { extname, join, relative, resolve } from "node:path";
import type { EmbeddingProvider } from "../embeddings/base.js";
import { BM25SparseVectorGenerator } from "../embeddings/sparse.js";
import type { QdrantManager } from "../qdrant/client.js";
import {
  filterResultsByGlob,
  calculateFetchLimit,
} from "../qdrant/filters/index.js";
import { TreeSitterChunker } from "./chunker/tree-sitter-chunker.js";
import { GitMetadataService } from "./git/index.js";
import { MetadataExtractor } from "./metadata.js";
import { ChunkPipeline, DEFAULT_CONFIG } from "./pipeline/index.js";
import { pipelineLog } from "./pipeline/debug-logger.js";
import { FileScanner } from "./scanner.js";
import { SchemaManager } from "./schema-migration.js";
import { SnapshotMigrator } from "./sync/migration.js";
import { ParallelFileSynchronizer, parallelLimit } from "./sync/parallel-synchronizer.js";
import type {
  ChangeStats,
  CodeChunk,
  CodeConfig,
  CodeSearchResult,
  IndexOptions,
  IndexStats,
  IndexStatus,
  ProgressCallback,
  SearchOptions,
} from "./types.js";

/** Reserved ID for storing indexing metadata in the collection */
const INDEXING_METADATA_ID = "__indexing_metadata__";

export class CodeIndexer {
  constructor(
    private qdrant: QdrantManager,
    private embeddings: EmbeddingProvider,
    private config: CodeConfig,
  ) {}

  /**
   * Validate that a path doesn't attempt directory traversal
   * @throws Error if path traversal is detected
   */
  private async validatePath(path: string): Promise<string> {
    const absolutePath = resolve(path);

    try {
      // Resolve the real path (follows symlinks)
      const realPath = await fs.realpath(absolutePath);

      // For now, we just ensure the path exists and is resolved
      // In a more restrictive environment, you could check against an allowlist
      return realPath;
    } catch (error) {
      // If realpath fails, the path doesn't exist yet or is invalid
      // For operations like indexing, we still need to accept non-existent paths
      // so we just return the resolved absolute path
      return absolutePath;
    }
  }

  /**
   * Index a codebase from scratch or force re-index
   */
  async indexCodebase(
    path: string,
    options?: IndexOptions,
    progressCallback?: ProgressCallback,
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

    const absolutePath = await this.validatePath(path);
    const collectionName = this.getCollectionName(absolutePath);

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
        supportedExtensions:
          options?.extensions || this.config.supportedExtensions,
        ignorePatterns: this.config.ignorePatterns,
        customIgnorePatterns:
          options?.ignorePatterns || this.config.customIgnorePatterns,
      });

      await scanner.loadIgnorePatterns(absolutePath);
      const files = await scanner.scanDirectory(absolutePath);

      stats.filesScanned = files.length;

      if (files.length === 0) {
        stats.status = "completed";
        stats.durationMs = Date.now() - startTime;
        return stats;
      }

      // 2. Create or verify collection
      const collectionExists =
        await this.qdrant.collectionExists(collectionName);

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
      await this.qdrant.createCollection(
        collectionName,
        vectorSize,
        "Cosine",
        this.config.enableHybridSearch,
      );

      // Initialize schema with payload indexes for optimal performance
      const schemaManager = new SchemaManager(this.qdrant);
      await schemaManager.initializeSchema(collectionName);

      // Store "indexing in progress" marker immediately after collection is ready
      await this.storeIndexingMarker(collectionName, false);

      // 3. Initialize parallel processing components
      const chunker = new TreeSitterChunker({
        chunkSize: this.config.chunkSize,
        chunkOverlap: this.config.chunkOverlap,
        maxChunkSize: this.config.chunkSize * 2,
      });
      const metadataExtractor = new MetadataExtractor();
      const indexedFiles: string[] = [];

      // Initialize git metadata service (optional)
      const gitMetadataService = this.config.enableGitMetadata
        ? new GitMetadataService({ debug: process.env.DEBUG === "true" })
        : null;
      if (gitMetadataService) {
        await gitMetadataService.initialize();
      }

      // Initialize ChunkPipeline for parallel embedding and storage
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
      chunkPipeline.start();

      // 4. STREAMING: Process files with bounded concurrency, send chunks immediately
      // This eliminates burst-pause pattern by streaming chunks as files are processed
      const fileProcessingConcurrency = parseInt(process.env.FILE_PROCESSING_CONCURRENCY || "10", 10);
      let totalChunksQueued = 0;
      let filesProcessed = 0;

      // NOTE: prefetchBlame removed - it blocks GPU for too long!
      // Git blame now runs lazily during file processing, allowing:
      // - First files to reach pipeline immediately
      // - GPU to start embedding while other files still processing
      // - Better CPU/GPU overlap instead of sequential phases

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
            const chunks = await chunker.chunk(code, filePath, language);

            // Apply chunk limits if configured
            const chunksToAdd = this.config.maxChunksPerFile
              ? chunks.slice(0, this.config.maxChunksPerFile)
              : chunks;

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
                } as CodeChunk["metadata"],
              };

              // Add git metadata if service is enabled (blame already in L1 cache)
              // IMPORTANT: Pass fileContent to avoid re-reading file for hash check
              if (gitMetadataService) {
                const gitMeta = await gitMetadataService.getChunkMetadata(
                  filePath,
                  chunk.startLine,
                  chunk.endLine,
                  code, // Pass content to avoid fs.readFile for each chunk!
                );
                if (gitMeta) {
                  baseChunk.metadata.git = {
                    lastModifiedAt: gitMeta.lastModifiedAt,
                    firstCreatedAt: gitMeta.firstCreatedAt,
                    dominantAuthor: gitMeta.dominantAuthor,
                    dominantAuthorEmail: gitMeta.dominantAuthorEmail,
                    authors: gitMeta.authors,
                    commitCount: gitMeta.commitCount,
                    lastCommitHash: gitMeta.lastCommitHash,
                    ageDays: gitMeta.ageDays,
                    taskIds: gitMeta.taskIds,
                  };
                }
              }

              // Wait for backpressure if needed
              if (chunkPipeline.isBackpressured()) {
                await chunkPipeline.waitForBackpressure(30000);
              }

              // IMMEDIATE: Send chunk to pipeline right away
              chunkPipeline.addChunk(
                baseChunk as CodeChunk,
                metadataExtractor.generateChunkId(chunk),
                absolutePath,
              );
              totalChunksQueued++;
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
      await chunkPipeline.shutdown();

      const finalPipelineStats = chunkPipeline.getStats();
      if (process.env.DEBUG) {
        console.error(
          `[Index] Pipeline completed: ${finalPipelineStats.itemsProcessed} chunks in ${finalPipelineStats.batchesProcessed} batches, ` +
          `${finalPipelineStats.throughput.toFixed(1)} chunks/s`
        );
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

      stats.durationMs = Date.now() - startTime;
      return stats;
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);
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
  private async storeIndexingMarker(
    collectionName: string,
    complete: boolean,
  ): Promise<void> {
    try {
      // Create a dummy vector of zeros (required by Qdrant)
      const vectorSize = this.embeddings.getDimensions();
      const zeroVector = new Array(vectorSize).fill(0);

      // Check if collection uses hybrid mode
      const collectionInfo =
        await this.qdrant.getCollectionInfo(collectionName);

      const payload = {
        _type: "indexing_metadata",
        indexingComplete: complete,
        ...(complete
          ? { completedAt: new Date().toISOString() }
          : { startedAt: new Date().toISOString() }),
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

  /**
   * Search code semantically
   */
  async searchCode(
    path: string,
    query: string,
    options?: SearchOptions,
  ): Promise<CodeSearchResult[]> {
    const absolutePath = await this.validatePath(path);
    const collectionName = this.getCollectionName(absolutePath);

    // Check if collection exists
    const exists = await this.qdrant.collectionExists(collectionName);
    if (!exists) {
      throw new Error(`Codebase not indexed: ${path}`);
    }

    // Check if collection has hybrid search enabled
    const collectionInfo = await this.qdrant.getCollectionInfo(collectionName);
    const useHybrid =
      (options?.useHybrid ?? this.config.enableHybridSearch) &&
      collectionInfo.hybridEnabled;

    // Generate query embedding
    const { embedding } = await this.embeddings.embed(query);

    // Build filter
    let filter: any;
    // Note: pathPattern is handled via client-side filtering, not Qdrant filter
    const hasBasicFilters = options?.fileTypes || options?.documentationOnly;
    // Git filters per canonical algorithm (aggregated signals only)
    const hasGitFilters =
      options?.author ||
      options?.modifiedAfter ||
      options?.modifiedBefore ||
      options?.minAgeDays !== undefined ||
      options?.maxAgeDays !== undefined ||
      options?.minCommitCount !== undefined ||
      options?.taskId;

    if (hasBasicFilters || hasGitFilters) {
      filter = { must: [] };

      // Basic filters
      if (options?.fileTypes && options.fileTypes.length > 0) {
        filter.must.push({
          key: "fileExtension",
          match: { any: options.fileTypes },
        });
      }

      // Filter to documentation only (markdown, READMEs, etc.)
      if (options?.documentationOnly) {
        filter.must.push({
          key: "isDocumentation",
          match: { value: true },
        });
      }

      // Git metadata filters (canonical algorithm: nested git.* keys)
      if (options?.author) {
        filter.must.push({
          key: "git.dominantAuthor",
          match: { value: options.author },
        });
      }

      if (options?.modifiedAfter) {
        const timestamp = Math.floor(
          new Date(options.modifiedAfter).getTime() / 1000,
        );
        filter.must.push({
          key: "git.lastModifiedAt",
          range: { gte: timestamp },
        });
      }

      if (options?.modifiedBefore) {
        const timestamp = Math.floor(
          new Date(options.modifiedBefore).getTime() / 1000,
        );
        filter.must.push({
          key: "git.lastModifiedAt",
          range: { lte: timestamp },
        });
      }

      if (options?.minAgeDays !== undefined) {
        filter.must.push({
          key: "git.ageDays",
          range: { gte: options.minAgeDays },
        });
      }

      if (options?.maxAgeDays !== undefined) {
        filter.must.push({
          key: "git.ageDays",
          range: { lte: options.maxAgeDays },
        });
      }

      if (options?.minCommitCount !== undefined) {
        filter.must.push({
          key: "git.commitCount",
          range: { gte: options.minCommitCount },
        });
      }

      if (options?.taskId) {
        filter.must.push({
          key: "git.taskIds",
          match: { any: [options.taskId] },
        });
      }
    }

    // Calculate fetch limit (fetch more if we need to filter by glob pattern)
    const requestedLimit = options?.limit || this.config.defaultSearchLimit;
    const fetchLimit = calculateFetchLimit(
      requestedLimit,
      Boolean(options?.pathPattern),
    );

    // Search with hybrid or standard search
    let results;
    if (useHybrid) {
      const sparseGenerator = new BM25SparseVectorGenerator();
      const sparseVector = sparseGenerator.generate(query);
      results = await this.qdrant.hybridSearch(
        collectionName,
        embedding,
        sparseVector,
        fetchLimit,
        filter,
      );
    } else {
      results = await this.qdrant.search(
        collectionName,
        embedding,
        fetchLimit,
        filter,
      );
    }

    // Apply glob pattern filter if specified (client-side filtering)
    const globFilteredResults = options?.pathPattern
      ? filterResultsByGlob(results, options.pathPattern)
      : results;

    // Apply score threshold if specified
    const filteredResults = options?.scoreThreshold
      ? globFilteredResults.filter(
          (r) => r.score >= (options.scoreThreshold || 0),
        )
      : globFilteredResults;

    // Format results (include git metadata if present)
    // Limit to requested count after all filtering
    return filteredResults.slice(0, requestedLimit).map((r) => ({
      content: r.payload?.content || "",
      filePath: r.payload?.relativePath || "",
      startLine: r.payload?.startLine || 0,
      endLine: r.payload?.endLine || 0,
      language: r.payload?.language || "unknown",
      score: r.score,
      fileExtension: r.payload?.fileExtension || "",
      // Include git metadata if it exists (canonical algorithm: aggregated signals)
      ...(r.payload?.git && {
        metadata: {
          git: {
            lastModifiedAt: r.payload.git.lastModifiedAt,
            firstCreatedAt: r.payload.git.firstCreatedAt,
            dominantAuthor: r.payload.git.dominantAuthor,
            dominantAuthorEmail: r.payload.git.dominantAuthorEmail,
            authors: r.payload.git.authors,
            commitCount: r.payload.git.commitCount,
            lastCommitHash: r.payload.git.lastCommitHash,
            ageDays: r.payload.git.ageDays,
            taskIds: r.payload.git.taskIds,
          },
        },
      }),
    }));
  }

  /**
   * Get indexing status for a codebase
   */
  async getIndexStatus(path: string): Promise<IndexStatus> {
    const absolutePath = await this.validatePath(path);
    const collectionName = this.getCollectionName(absolutePath);
    const exists = await this.qdrant.collectionExists(collectionName);

    if (!exists) {
      return { isIndexed: false, status: "not_indexed" };
    }

    // Check for indexing marker in Qdrant (persisted across instances)
    const indexingMarker = await this.qdrant.getPoint(
      collectionName,
      INDEXING_METADATA_ID,
    );
    const info = await this.qdrant.getCollectionInfo(collectionName);

    // Check marker status
    const isComplete = indexingMarker?.payload?.indexingComplete === true;
    const isInProgress = indexingMarker?.payload?.indexingComplete === false;

    // Subtract 1 from points count if marker exists (metadata point doesn't count as a chunk)
    const actualChunksCount = indexingMarker
      ? Math.max(0, info.pointsCount - 1)
      : info.pointsCount;

    if (isInProgress) {
      // Indexing in progress - marker exists with indexingComplete=false
      return {
        isIndexed: false,
        status: "indexing",
        collectionName,
        chunksCount: actualChunksCount,
      };
    }

    if (isComplete) {
      // Indexing completed - marker exists with indexingComplete=true
      return {
        isIndexed: true,
        status: "indexed",
        collectionName,
        chunksCount: actualChunksCount,
        lastUpdated: indexingMarker.payload?.completedAt
          ? new Date(indexingMarker.payload.completedAt)
          : undefined,
      };
    }

    // Legacy collection (no marker) - check if it has content
    // If it has chunks, assume it's indexed (backwards compatibility)
    if (actualChunksCount > 0) {
      return {
        isIndexed: true,
        status: "indexed",
        collectionName,
        chunksCount: actualChunksCount,
      };
    }

    // Collection exists but no chunks and no marker - not indexed
    return {
      isIndexed: false,
      status: "not_indexed",
      collectionName,
      chunksCount: 0,
    };
  }

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
      const absolutePath = await this.validatePath(path);
      const collectionName = this.getCollectionName(absolutePath);

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
      const currentFiles = await scanner.scanDirectory(absolutePath);

      // Detect changes
      const changes = await synchronizer.detectChanges(currentFiles);
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

      const chunker = new TreeSitterChunker({
        chunkSize: this.config.chunkSize,
        chunkOverlap: this.config.chunkOverlap,
        maxChunkSize: this.config.chunkSize * 2,
      });
      const metadataExtractor = new MetadataExtractor();

      // Initialize git metadata service (optional)
      const gitMetadataService = this.config.enableGitMetadata
        ? new GitMetadataService({ debug: process.env.DEBUG === "true" })
        : null;
      if (gitMetadataService) {
        await gitMetadataService.initialize();
      }

      // OPTIMIZATION: Parallel pipelines for delete and index operations
      // - Added files: can be indexed immediately (no old chunks to delete)
      // - Modified files: must wait for deletion of old chunks before indexing
      // - Deleted files: only need deletion, no indexing
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
      chunkPipeline.start();

      // STREAMING: Helper function to index files with bounded concurrency
      // Chunks are sent to pipeline immediately as files are processed
      const indexFiles = async (
        files: string[],
        label: string
      ): Promise<number> => {
        if (files.length === 0) return 0;

        let chunksCreated = 0;
        const streamingConcurrency = parseInt(process.env.FILE_PROCESSING_CONCURRENCY || "10", 10);

        if (process.env.DEBUG) {
          console.error(`[Reindex] ${label}: starting ${files.length} files (streaming, concurrency=${streamingConcurrency})`);
        }

        // NOTE: prefetchBlame removed - it blocks GPU for too long!
        // Git blame runs lazily during file processing for better CPU/GPU overlap

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
              const chunks = await chunker.chunk(code, absoluteFilePath, language);

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
                    isDocumentation: chunk.metadata.isDocumentation,
                  } as CodeChunk["metadata"],
                };

                // Add git metadata if service is enabled (blame already in L1 cache)
                // IMPORTANT: Pass fileContent to avoid re-reading file for hash check
                if (gitMetadataService) {
                  const gitMeta = await gitMetadataService.getChunkMetadata(
                    absoluteFilePath,
                    chunk.startLine,
                    chunk.endLine,
                    code, // Pass content to avoid fs.readFile for each chunk!
                  );
                  if (gitMeta) {
                    baseChunk.metadata.git = {
                      lastModifiedAt: gitMeta.lastModifiedAt,
                      firstCreatedAt: gitMeta.firstCreatedAt,
                      dominantAuthor: gitMeta.dominantAuthor,
                      dominantAuthorEmail: gitMeta.dominantAuthorEmail,
                      authors: gitMeta.authors,
                      commitCount: gitMeta.commitCount,
                      lastCommitHash: gitMeta.lastCommitHash,
                      ageDays: gitMeta.ageDays,
                      taskIds: gitMeta.taskIds,
                    };
                  }
                }

                // Wait for backpressure if needed
                if (chunkPipeline.isBackpressured()) {
                  await chunkPipeline.waitForBackpressure(30000);
                }

                // IMMEDIATE: Send chunk to pipeline right away
                chunkPipeline.addChunk(
                  baseChunk as CodeChunk,
                  metadataExtractor.generateChunkId(chunk),
                  absolutePath,
                );
                chunksCreated++;
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
      await chunkPipeline.shutdown();

      const pipelineStats = chunkPipeline.getStats();
      if (process.env.DEBUG) {
        console.error(
          `[Reindex] Parallel pipelines completed in ${Date.now() - startTime2}ms ` +
            `(pipeline: ${pipelineStats.itemsProcessed} chunks in ${pipelineStats.batchesProcessed} batches, ` +
            `${pipelineStats.throughput.toFixed(1)} chunks/s)`
        );
      }

      stats.chunksAdded = addedChunks + modifiedChunks;

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

  /**
   * Clear all indexed data for a codebase
   */
  async clearIndex(path: string): Promise<void> {
    const absolutePath = await this.validatePath(path);
    const collectionName = this.getCollectionName(absolutePath);
    const exists = await this.qdrant.collectionExists(collectionName);

    if (exists) {
      await this.qdrant.deleteCollection(collectionName);
    }

    // Also delete snapshot
    try {
      const snapshotDir = join(homedir(), ".tea-rags-mcp", "snapshots");
      const synchronizer = new ParallelFileSynchronizer(absolutePath, collectionName, snapshotDir);
      await synchronizer.deleteSnapshot();
    } catch (_error) {
      // Ignore snapshot deletion errors
    }
  }

  /**
   * Generate deterministic collection name from codebase path
   */
  private getCollectionName(path: string): string {
    const absolutePath = resolve(path);
    const hash = createHash("md5").update(absolutePath).digest("hex");
    return `code_${hash.substring(0, 8)}`;
  }
}

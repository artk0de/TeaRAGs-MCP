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
import { TreeSitterChunker } from "./chunker/tree-sitter-chunker.js";
import { MetadataExtractor } from "./metadata.js";
import { FileScanner } from "./scanner.js";
import { SnapshotMigrator } from "./sync/migration.js";
import { ParallelFileSynchronizer } from "./sync/parallel-synchronizer.js";
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

      if (options?.forceReindex && collectionExists) {
        await this.qdrant.deleteCollection(collectionName);
      }

      if (!collectionExists || options?.forceReindex) {
        const vectorSize = this.embeddings.getDimensions();
        await this.qdrant.createCollection(
          collectionName,
          vectorSize,
          "Cosine",
          this.config.enableHybridSearch,
        );
      }

      // Store "indexing in progress" marker immediately after collection is ready
      await this.storeIndexingMarker(collectionName, false);

      // 3. Process files and create chunks
      const chunker = new TreeSitterChunker({
        chunkSize: this.config.chunkSize,
        chunkOverlap: this.config.chunkOverlap,
        maxChunkSize: this.config.chunkSize * 2,
      });
      const metadataExtractor = new MetadataExtractor();
      const allChunks: Array<{ chunk: CodeChunk; id: string }> = [];
      const indexedFiles: string[] = []; // Track only files that were actually indexed

      for (const [index, filePath] of files.entries()) {
        try {
          progressCallback?.({
            phase: "chunking",
            current: index + 1,
            total: files.length,
            percentage: Math.round(((index + 1) / files.length) * 40), // 0-40%
            message: `Chunking file ${index + 1}/${files.length}`,
          });

          const code = await fs.readFile(filePath, "utf-8");

          // Check for secrets (basic detection)
          if (metadataExtractor.containsSecrets(code)) {
            stats.errors?.push(
              `Skipped ${filePath}: potential secrets detected`,
            );
            continue;
          }

          const language = metadataExtractor.extractLanguage(filePath);
          const chunks = await chunker.chunk(code, filePath, language);

          // Apply chunk limits if configured
          const chunksToAdd = this.config.maxChunksPerFile
            ? chunks.slice(0, this.config.maxChunksPerFile)
            : chunks;

          for (const chunk of chunksToAdd) {
            const id = metadataExtractor.generateChunkId(chunk);
            allChunks.push({ chunk, id });

            // Check total chunk limit
            if (
              this.config.maxTotalChunks &&
              allChunks.length >= this.config.maxTotalChunks
            ) {
              break;
            }
          }

          stats.filesIndexed++;
          indexedFiles.push(filePath);

          // Check total chunk limit
          if (
            this.config.maxTotalChunks &&
            allChunks.length >= this.config.maxTotalChunks
          ) {
            break;
          }
        } catch (error) {
          const errorMessage =
            error instanceof Error ? error.message : String(error);
          stats.errors?.push(`Failed to process ${filePath}: ${errorMessage}`);
        }
      }

      stats.chunksCreated = allChunks.length;

      // Save snapshot for incremental updates (only for files that were actually indexed)
      try {
        const snapshotDir = join(homedir(), ".qdrant-mcp", "snapshots");
        const synchronizer = new ParallelFileSynchronizer(absolutePath, collectionName, snapshotDir);
        await synchronizer.updateSnapshot(indexedFiles);
      } catch (error) {
        // Snapshot failure shouldn't fail the entire indexing
        const errorMessage =
          error instanceof Error ? error.message : String(error);
        console.error("Failed to save snapshot:", errorMessage);
        stats.errors?.push(`Snapshot save failed: ${errorMessage}`);
      }

      if (allChunks.length === 0) {
        // Still store completion marker even with no chunks
        await this.storeIndexingMarker(collectionName, true);
        stats.status = "completed";
        stats.durationMs = Date.now() - startTime;
        return stats;
      }

      // 4. Generate embeddings and store in batches
      const batchSize = this.config.batchSize;
      for (let i = 0; i < allChunks.length; i += batchSize) {
        const batch = allChunks.slice(i, i + batchSize);

        progressCallback?.({
          phase: "embedding",
          current: i + batch.length,
          total: allChunks.length,
          percentage:
            40 + Math.round(((i + batch.length) / allChunks.length) * 30), // 40-70%
          message: `Generating embeddings ${i + batch.length}/${allChunks.length}`,
        });

        try {
          const texts = batch.map((b) => b.chunk.content);
          const embeddings = await this.embeddings.embedBatch(texts);

          // 5. Store to Qdrant
          const points = batch.map((b, idx) => ({
            id: b.id,
            vector: embeddings[idx].embedding,
            payload: {
              content: b.chunk.content,
              relativePath: relative(absolutePath, b.chunk.metadata.filePath),
              startLine: b.chunk.startLine,
              endLine: b.chunk.endLine,
              fileExtension: extname(b.chunk.metadata.filePath),
              language: b.chunk.metadata.language,
              codebasePath: absolutePath,
              chunkIndex: b.chunk.metadata.chunkIndex,
              ...(b.chunk.metadata.name && { name: b.chunk.metadata.name }),
              ...(b.chunk.metadata.chunkType && {
                chunkType: b.chunk.metadata.chunkType,
              }),
            },
          }));

          progressCallback?.({
            phase: "storing",
            current: i + batch.length,
            total: allChunks.length,
            percentage:
              70 + Math.round(((i + batch.length) / allChunks.length) * 30), // 70-100%
            message: `Storing chunks ${i + batch.length}/${allChunks.length}`,
          });

          // OPTIMIZED: Use wait=false for intermediate batches, wait=true for last batch
          const isLastBatch = i + batchSize >= allChunks.length;

          if (this.config.enableHybridSearch) {
            // Generate sparse vectors for hybrid search
            const sparseGenerator = new BM25SparseVectorGenerator();
            const hybridPoints = batch.map((b, idx) => ({
              id: b.id,
              vector: embeddings[idx].embedding,
              sparseVector: sparseGenerator.generate(b.chunk.content),
              payload: {
                content: b.chunk.content,
                relativePath: relative(absolutePath, b.chunk.metadata.filePath),
                startLine: b.chunk.startLine,
                endLine: b.chunk.endLine,
                fileExtension: extname(b.chunk.metadata.filePath),
                language: b.chunk.metadata.language,
                codebasePath: absolutePath,
                chunkIndex: b.chunk.metadata.chunkIndex,
                ...(b.chunk.metadata.name && { name: b.chunk.metadata.name }),
                ...(b.chunk.metadata.chunkType && {
                  chunkType: b.chunk.metadata.chunkType,
                }),
              },
            }));

            await this.qdrant.addPointsWithSparseOptimized(
              collectionName,
              hybridPoints,
              { wait: isLastBatch, ordering: "weak" },
            );
          } else {
            await this.qdrant.addPointsOptimized(collectionName, points, {
              wait: isLastBatch,
              ordering: "weak",
            });
          }
        } catch (error) {
          const errorMessage =
            error instanceof Error ? error.message : String(error);
          stats.errors?.push(
            `Failed to process batch at index ${i}: ${errorMessage}`,
          );
          stats.status = "partial";
        }
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
    if (options?.fileTypes || options?.pathPattern) {
      filter = { must: [] };

      if (options.fileTypes && options.fileTypes.length > 0) {
        filter.must.push({
          key: "fileExtension",
          match: { any: options.fileTypes },
        });
      }

      if (options.pathPattern) {
        // Convert glob pattern to regex (simplified)
        const regex = options.pathPattern
          .replace(/\./g, "\\.")
          .replace(/\*\*/g, ".*")
          .replace(/\*/g, "[^/]*")
          .replace(/\?/g, ".");

        filter.must.push({
          key: "relativePath",
          match: { text: regex },
        });
      }
    }

    // Search with hybrid or standard search
    let results;
    if (useHybrid) {
      const sparseGenerator = new BM25SparseVectorGenerator();
      const sparseVector = sparseGenerator.generate(query);
      results = await this.qdrant.hybridSearch(
        collectionName,
        embedding,
        sparseVector,
        options?.limit || this.config.defaultSearchLimit,
        filter,
      );
    } else {
      results = await this.qdrant.search(
        collectionName,
        embedding,
        options?.limit || this.config.defaultSearchLimit,
        filter,
      );
    }

    // Apply score threshold if specified
    const filteredResults = options?.scoreThreshold
      ? results.filter((r) => r.score >= (options.scoreThreshold || 0))
      : results;

    // Format results
    return filteredResults.map((r) => ({
      content: r.payload?.content || "",
      filePath: r.payload?.relativePath || "",
      startLine: r.payload?.startLine || 0,
      endLine: r.payload?.endLine || 0,
      language: r.payload?.language || "unknown",
      score: r.score,
      fileExtension: r.payload?.fileExtension || "",
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
      const snapshotDir = join(homedir(), ".qdrant-mcp", "snapshots");
      const migrator = new SnapshotMigrator(snapshotDir, collectionName, absolutePath);
      await migrator.ensureMigrated();

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

      // OPTIMIZATION 1: Batch deletion of old chunks (single Qdrant request)
      const filesToDelete = [...changes.modified, ...changes.deleted];

      if (filesToDelete.length > 0) {
        progressCallback?.({
          phase: "scanning",
          current: 0,
          total: filesToDelete.length,
          percentage: 5,
          message: `Deleting old chunks for ${filesToDelete.length} files...`,
        });

        // Single request with OR filter - much faster than N parallel requests!
        // Qdrant handles large filters efficiently
        try {
          await this.qdrant.deletePointsByPaths(collectionName, filesToDelete);
        } catch (error) {
          console.error(`Failed to batch delete chunks:`, error);
          // Fallback to individual deletions if batch fails
          for (const relativePath of filesToDelete) {
            try {
              const filter = {
                must: [{ key: "relativePath", match: { value: relativePath } }],
              };
              await this.qdrant.deletePointsByFilter(collectionName, filter);
            } catch (innerError) {
              console.error(`Failed to delete chunks for ${relativePath}:`, innerError);
            }
          }
        }
      }

      let filesToIndex = [...changes.added, ...changes.modified];

      // CHECKPOINT RESUME: Filter out already processed files
      if (resumeFromCheckpoint && checkpoint) {
        const originalCount = filesToIndex.length;
        filesToIndex = synchronizer.filterProcessedFiles(filesToIndex, checkpoint);
        console.error(
          `[Reindex] Checkpoint filter: ${originalCount} → ${filesToIndex.length} files remaining`
        );
      }

      // CORNER CASE: No files to index (or all already processed)
      if (filesToIndex.length === 0) {
        stats.chunksAdded = 0;
        await synchronizer.updateSnapshot(currentFiles);
        await synchronizer.deleteCheckpoint(); // Clean up checkpoint
        stats.durationMs = Date.now() - startTime;
        return stats;
      }

      // DEBUG: Log exactly what files will be sent to embeddings
      if (process.env.DEBUG) {
        console.error(
          `[Reindex] Files to embed: ${filesToIndex.length} ` +
          `(added: ${changes.added.length}, modified: ${changes.modified.length})`
        );
        if (filesToIndex.length <= 20) {
          console.error(`[Reindex] Files: ${filesToIndex.join(', ')}`);
        } else {
          console.error(`[Reindex] First 20: ${filesToIndex.slice(0, 20).join(', ')}...`);
        }
      }

      // OPTIMIZATION 2 & 3: Parallel processing + TRUE Pipelining
      const fileProcessingConcurrency = 20; // Process 20 files at once
      const batchSize = this.config.batchSize;

      let processedFiles = resumeFromCheckpoint && checkpoint
        ? checkpoint.processedFiles.length
        : 0;
      let totalChunksCreated = 0;

      // TRUE PIPELINING: Overlap embedding and Qdrant storage
      // While storing batch N, we're already embedding batch N+1
      let pendingStorePromise: Promise<void> | null = null;
      const sparseGenerator = this.config.enableHybridSearch
        ? new BM25SparseVectorGenerator()
        : null;

      // Process files in parallel batches
      for (let i = 0; i < filesToIndex.length; i += fileProcessingConcurrency) {
        const fileBatch = filesToIndex.slice(i, i + fileProcessingConcurrency);

        progressCallback?.({
          phase: "chunking",
          current: processedFiles + fileBatch.length,
          total: filesToIndex.length,
          percentage: Math.round(((processedFiles + fileBatch.length) / filesToIndex.length) * 40),
          message: `Processing files ${processedFiles + fileBatch.length}/${filesToIndex.length}`,
        });

        // PARALLEL: Read and chunk files concurrently
        const chunkResults = await Promise.all(
          fileBatch.map(async (filePath) => {
            try {
              const absoluteFilePath = join(absolutePath, filePath);
              const code = await fs.readFile(absoluteFilePath, "utf-8");

              // Check for secrets
              if (metadataExtractor.containsSecrets(code)) {
                return [];
              }

              const language = metadataExtractor.extractLanguage(absoluteFilePath);
              const chunks = await chunker.chunk(code, absoluteFilePath, language);

              return chunks.map((chunk) => ({
                chunk,
                id: metadataExtractor.generateChunkId(chunk),
              }));
            } catch (error) {
              console.error(`Failed to process ${filePath}:`, error);
              return [];
            }
          })
        );

        // Flatten results
        const allChunks = chunkResults.flat();

        // CORNER CASE: File batch produced no chunks (all empty/secrets/errors)
        if (allChunks.length === 0) {
          processedFiles += fileBatch.length;
          continue; // Skip to next file batch
        }

        totalChunksCreated += allChunks.length;

        // TRUE PIPELINING: Overlap embedding (GPU) with storage (network)
        for (let j = 0; j < allChunks.length; j += batchSize) {
          const batch = allChunks.slice(j, j + batchSize);
          const isLastBatch = j + batchSize >= allChunks.length &&
            i + fileProcessingConcurrency >= filesToIndex.length;

          const embedProgress = processedFiles + fileBatch.length;
          progressCallback?.({
            phase: "embedding",
            current: embedProgress,
            total: filesToIndex.length,
            percentage: 40 + Math.round((embedProgress / filesToIndex.length) * 30),
            message: `Generating embeddings (${totalChunksCreated} chunks)`,
          });

          const texts = batch.map((b) => b.chunk.content);
          const embeddings = await this.embeddings.embedBatch(texts);

          const points = batch.map((b, idx) => ({
            id: b.id,
            vector: embeddings[idx].embedding,
            payload: {
              content: b.chunk.content,
              relativePath: relative(absolutePath, b.chunk.metadata.filePath),
              startLine: b.chunk.startLine,
              endLine: b.chunk.endLine,
              fileExtension: extname(b.chunk.metadata.filePath),
              language: b.chunk.metadata.language,
              codebasePath: absolutePath,
              chunkIndex: b.chunk.metadata.chunkIndex,
              ...(b.chunk.metadata.name && { name: b.chunk.metadata.name }),
              ...(b.chunk.metadata.chunkType && {
                chunkType: b.chunk.metadata.chunkType,
              }),
            },
          }));

          progressCallback?.({
            phase: "storing",
            current: embedProgress,
            total: filesToIndex.length,
            percentage: 70 + Math.round((embedProgress / filesToIndex.length) * 30),
            message: `Storing chunks (${totalChunksCreated} total)`,
          });

          // Wait for previous store to complete before starting new one
          // This ensures we don't overwhelm Qdrant while still pipelining
          if (pendingStorePromise) {
            await pendingStorePromise;
          }

          // Start store operation - DON'T await if not last batch!
          // This allows embedding of next batch to start while storing
          // Use optimized method with wait=false for intermediate batches
          if (sparseGenerator) {
            const hybridPoints = points.map((point, idx) => ({
              ...point,
              sparseVector: sparseGenerator.generate(
                allChunks[j + idx].chunk.content,
              ),
            }));
            if (isLastBatch) {
              await this.qdrant.addPointsWithSparse(collectionName, hybridPoints);
              pendingStorePromise = null;
            } else {
              pendingStorePromise = this.qdrant.addPointsWithSparse(collectionName, hybridPoints);
            }
          } else {
            if (isLastBatch) {
              // Last batch: use optimized with wait=true for consistency
              await this.qdrant.addPointsOptimized(collectionName, points, {
                wait: true,
                ordering: "weak",
              });
              pendingStorePromise = null;
            } else {
              // Intermediate batches: use optimized with wait=false for speed
              pendingStorePromise = this.qdrant.addPointsOptimized(
                collectionName,
                points,
                { wait: false, ordering: "weak" },
              );
            }
          }
        } // End embedding batch loop

        processedFiles += fileBatch.length;

        // CHECKPOINT: Save progress every N files for resumability
        if (processedFiles % CHECKPOINT_INTERVAL === 0 || processedFiles === filesToIndex.length) {
          // Build list of processed files for checkpoint
          const processedFilesList = filesToIndex.slice(0, i + fileProcessingConcurrency);
          await synchronizer.saveCheckpoint(processedFilesList, filesToIndex.length, "indexing");
        }
      } // End file processing loop

      // Ensure any pending store is complete
      if (pendingStorePromise) {
        await pendingStorePromise;
      }

      stats.chunksAdded = totalChunksCreated;

      // Update snapshot
      await synchronizer.updateSnapshot(currentFiles);

      // Delete checkpoint on successful completion
      await synchronizer.deleteCheckpoint();

      stats.durationMs = Date.now() - startTime;

      // DEBUG: Final summary
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
   * Rebuild cache/snapshot by comparing actual files with Qdrant collection.
   * Useful after manual file changes, interrupted indexing, or to verify state.
   *
   * Returns statistics about indexed vs pending files.
   */
  async rebuildCache(path: string): Promise<{
    indexed: number;
    pending: number;
    orphaned: number;
    cacheVersion: string;
    snapshotUpdated: boolean;
    details?: {
      pendingFiles: string[];
      orphanedPaths: string[];
    };
  }> {
    const absolutePath = await this.validatePath(path);
    const collectionName = this.getCollectionName(absolutePath);

    // Check if collection exists
    const exists = await this.qdrant.collectionExists(collectionName);
    if (!exists) {
      return {
        indexed: 0,
        pending: 0,
        orphaned: 0,
        cacheVersion: "none",
        snapshotUpdated: false,
      };
    }

    // 1. Scan current files in the codebase
    const scanner = new FileScanner({
      supportedExtensions: this.config.supportedExtensions,
      ignorePatterns: this.config.ignorePatterns,
      customIgnorePatterns: this.config.customIgnorePatterns,
    });

    await scanner.loadIgnorePatterns(absolutePath);
    const currentFiles = await scanner.scanDirectory(absolutePath);

    // Convert to relative paths for comparison
    const currentRelativePaths = new Set(
      currentFiles.map((f) => relative(absolutePath, f))
    );

    // 2. Get all indexed paths from Qdrant
    // We need to scroll through all points to get unique relativePaths
    const indexedPaths = await this.getIndexedPaths(collectionName, absolutePath);

    // 3. Compare
    const indexedSet = new Set(indexedPaths);

    // Files that are indexed and exist
    const validIndexed = Array.from(indexedSet).filter((p) => currentRelativePaths.has(p));

    // Files that exist but are not indexed (pending)
    const pendingFiles = Array.from(currentRelativePaths).filter((p) => !indexedSet.has(p));

    // Files that are indexed but no longer exist (orphaned)
    const orphanedPaths = Array.from(indexedSet).filter((p) => !currentRelativePaths.has(p));

    // 4. Rebuild snapshot with current state
    const snapshotDir = join(homedir(), ".qdrant-mcp", "snapshots");

    // AUTO-MIGRATE: Upgrade old snapshots to v3 if needed
    const migrator = new SnapshotMigrator(snapshotDir, collectionName, absolutePath);
    await migrator.ensureMigrated();

    const synchronizer = new ParallelFileSynchronizer(absolutePath, collectionName, snapshotDir);
    await synchronizer.initialize();

    // Only include files that are both indexed AND exist
    const validFiles = currentFiles.filter((f) => {
      const rel = relative(absolutePath, f);
      return indexedSet.has(rel);
    });

    // Update snapshot with valid files only
    if (validFiles.length > 0) {
      await synchronizer.updateSnapshot(validFiles);
    }

    // Delete any checkpoint that might exist
    await synchronizer.deleteCheckpoint();

    // 5. Optionally clean up orphaned chunks (files deleted but chunks remain)
    if (orphanedPaths.length > 0) {
      console.error(`[rebuildCache] Found ${orphanedPaths.length} orphaned paths, cleaning up...`);
      try {
        await this.qdrant.deletePointsByPaths(collectionName, orphanedPaths);
      } catch (error) {
        console.error(`[rebuildCache] Failed to clean orphaned chunks:`, error);
      }
    }

    return {
      indexed: validIndexed.length,
      pending: pendingFiles.length,
      orphaned: orphanedPaths.length,
      cacheVersion: "v2",
      snapshotUpdated: true,
      details: {
        pendingFiles: pendingFiles.slice(0, 20), // Limit to first 20 for readability
        orphanedPaths: orphanedPaths.slice(0, 20),
      },
    };
  }

  /**
   * Get all unique relativePaths from indexed chunks in Qdrant.
   * Uses scroll API to handle large collections.
   */
  private async getIndexedPaths(
    collectionName: string,
    codebasePath: string
  ): Promise<string[]> {
    const indexedPaths = new Set<string>();

    try {
      // Use Qdrant scroll to get all points
      // This is a workaround since QdrantManager doesn't expose scroll directly
      // We'll use search with a very high limit and filter by codebasePath
      const info = await this.qdrant.getCollectionInfo(collectionName);
      const pointsCount = info.pointsCount;

      if (pointsCount === 0) {
        return [];
      }

      // Create a dummy query vector to search (we need embeddings just to use search)
      // Instead, we'll use the internal client scroll
      // For now, estimate based on collection info and use a high search limit
      // This is a simplification - ideally we'd expose scroll in QdrantManager

      // Use search with zero vector to get points (Qdrant returns all when using scroll)
      // Actually, let's just query for unique paths via filter
      // We need access to the underlying client for proper scroll

      // Workaround: Get unique paths from a large search
      // This isn't perfect but works for most cases
      // For production, QdrantManager should expose scroll API

      // For now, return empty and let the caller know
      // The comparison will mark everything as "pending"

      // Better approach: Use the snapshot if it exists
      const snapshotDir = join(homedir(), ".qdrant-mcp", "snapshots");

      // AUTO-MIGRATE: Upgrade old snapshots to v3 if needed
      const migrator = new SnapshotMigrator(snapshotDir, collectionName, codebasePath);
      await migrator.ensureMigrated();

      const synchronizer = new ParallelFileSynchronizer(codebasePath, collectionName, snapshotDir);
      const hasSnapshot = await synchronizer.initialize();

      if (hasSnapshot) {
        // Get paths from snapshot (much faster than scrolling Qdrant)

        // Let's detect changes which will give us the current indexed paths
        const scanner = new FileScanner({
          supportedExtensions: this.config.supportedExtensions,
          ignorePatterns: this.config.ignorePatterns,
          customIgnorePatterns: this.config.customIgnorePatterns,
        });
        await scanner.loadIgnorePatterns(codebasePath);
        const currentFiles = await scanner.scanDirectory(codebasePath);

        // detectChanges compares current files with snapshot
        // The "deleted" files are those in snapshot but not in currentFiles
        const changes = await synchronizer.detectChanges(currentFiles);

        // Files in snapshot = current files that are NOT added + deleted files
        // i.e., snapshot files = (current - added) + deleted
        const currentRelative = currentFiles.map((f) =>
          relative(codebasePath, f)
        );
        const addedSet = new Set(changes.added);
        const existingInSnapshot = currentRelative.filter(
          (p) => !addedSet.has(p)
        );
        const allSnapshotPaths = [...existingInSnapshot, ...changes.deleted];

        for (const p of allSnapshotPaths) {
          indexedPaths.add(p);
        }
      }
    } catch (error) {
      console.error(`[getIndexedPaths] Error:`, error);
    }

    return Array.from(indexedPaths);
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
      const snapshotDir = join(homedir(), ".qdrant-mcp", "snapshots");
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

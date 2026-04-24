/**
 * FileProcessor - Shared file processing logic for indexing pipelines.
 *
 * Reads files, checks for secrets, chunks them, and sends to ChunkPipeline.
 * Eliminates duplication between IndexPipeline and ReindexPipeline.
 */

import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import { join, relative } from "node:path";

import { isTestPath } from "../../../infra/scope-detection.js";
import type { ChunkLookupEntry, CodeChunk } from "../../../types.js";
import type { ReindexCoordinator } from "../sync/reindex-coordinator.js";
import type { ChunkPipeline } from "./chunk-pipeline.js";
import type { ChunkerPool } from "./chunker/infra/pool.js";
import { generateChunkId } from "./chunker/utils/chunk-id.js";
import { extractImportsExports } from "./chunker/utils/import-extractor.js";
import { detectLanguage } from "./chunker/utils/language-detector.js";
import { containsSecrets } from "./chunker/utils/secrets-detector.js";
import { pipelineLog } from "./infra/debug-logger.js";
import { parallelLimit } from "./infra/parallel.js";
import { isDebug } from "./infra/runtime.js";

/**
 * Post-process chunks of a single file:
 * 1. Replace readable symbolId with doc:hash for documentation chunks
 * 2. Assign navigation links (prevSymbolId / nextSymbolId) for all chunks
 *
 * Mutates chunks in place. Must be called AFTER chunking, BEFORE pipeline.
 */
export function assignNavigationAndDocSymbolId(chunks: CodeChunk[], basePath: string): void {
  // Phase 1: compute doc symbolIds
  for (const chunk of chunks) {
    if (chunk.metadata.isDocumentation) {
      const relPath = relative(basePath, chunk.metadata.filePath);
      const hp = chunk.metadata.headingPath;
      let hashInput: string;
      if (hp && hp.length > 0) {
        hashInput = `${relPath}#${hp.map((h) => h.text).join(" > ")}`;
      } else if (chunk.metadata.name === "Preamble") {
        hashInput = `${relPath}#preamble`;
      } else {
        hashInput = `${relPath}#${chunk.metadata.chunkIndex}`;
      }
      chunk.metadata.symbolId = `doc:${createHash("sha256").update(hashInput).digest("hex").slice(0, 12)}`;
      chunk.metadata.parentSymbolId = relPath;
    }
  }

  // Phase 2: assign navigation
  for (let i = 0; i < chunks.length; i++) {
    const nav: { prevSymbolId?: string; nextSymbolId?: string } = {};
    if (i > 0 && chunks[i - 1].metadata.symbolId) {
      nav.prevSymbolId = chunks[i - 1].metadata.symbolId;
    }
    if (i < chunks.length - 1 && chunks[i + 1].metadata.symbolId) {
      nav.nextSymbolId = chunks[i + 1].metadata.symbolId;
    }
    chunks[i].metadata.navigation = nav;
  }
}

export interface FileProcessorOptions {
  enableGitMetadata: boolean;
  maxChunksPerFile?: number;
  maxTotalChunks?: number;
  concurrency?: number;
  /**
   * Optional per-file barrier. When set, files whose delete silently failed
   * (tracked by the coordinator) are skipped from upsert to prevent orphan
   * duplicates. Pass ONLY for the modified-files pass — added files have no
   * old chunks to collide with. See reindex-resilience plan Phase 3.2.
   */
  coordinator?: ReindexCoordinator;
}

export interface FileProcessResult {
  chunksCreated: number;
  filesProcessed: number;
  chunkMap: Map<string, ChunkLookupEntry[]>;
  errors: string[];
}

export interface FileProcessCallbacks {
  onFileProcessed?: (filePath: string, chunksCount: number) => void;
}

/**
 * Process a batch of files: read → secrets check → chunk → pipeline submit → enrichment track.
 *
 * @param absolutePaths - Absolute file paths to process
 * @param basePath - Base path of the codebase (for pipeline context)
 * @param chunkerPool - Pool for AST-aware chunking
 * @param chunkPipeline - Pipeline for embedding and storage
 * @param options - Processing options
 * @param callbacks - Optional callbacks for progress tracking
 */
export async function processFiles(
  absolutePaths: string[],
  basePath: string,
  chunkerPool: ChunkerPool,
  chunkPipeline: ChunkPipeline,
  options: FileProcessorOptions,
  callbacks?: FileProcessCallbacks,
): Promise<FileProcessResult> {
  const result: FileProcessResult = {
    chunksCreated: 0,
    filesProcessed: 0,
    chunkMap: new Map(),
    errors: [],
  };

  const concurrency = options.concurrency ?? 50;

  await parallelLimit(
    absolutePaths,
    async (filePath) => {
      // Declared outside try/catch so the error-path emission can reference them
      // even when failure happens before assignment.
      let relativePath = filePath;
      let language = "unknown";
      try {
        const code = await fs.readFile(filePath, "utf-8");
        const bytes = Buffer.byteLength(code, "utf8");
        language = detectLanguage(filePath);
        relativePath = filePath.startsWith(basePath) ? filePath.slice(basePath.length + 1) : filePath;

        // Phase 3.2 gate: skip files whose delete silently failed in this
        // reindex. Runs BEFORE parse/chunk to save CPU on blocked files.
        // Emits exactly one FILE_INGESTED skip record to preserve the
        // "one event per touched file" invariant.
        if (options.coordinator && !options.coordinator.canUpsertForFile(relativePath)) {
          pipelineLog.fileIngested(
            { component: "FileProcessor" },
            {
              path: relativePath,
              language,
              bytes,
              chunks: 0,
              parseMs: 0,
              skipped: true,
              skipReason: "delete-failed",
            },
          );
          return;
        }

        if (!isTestPath(relativePath, language) && containsSecrets(code)) {
          result.errors.push(`Skipped ${filePath}: potential secrets detected`);
          pipelineLog.fileIngested(
            { component: "FileProcessor" },
            {
              path: relativePath,
              language,
              bytes,
              chunks: 0,
              parseMs: 0,
              skipped: true,
              skipReason: "secrets",
            },
          );
          return;
        }

        const { imports } = extractImportsExports(code, language);
        const parseStart = Date.now();
        const { chunks } = await chunkerPool.processFile(filePath, code, language);
        const parseMs = Date.now() - parseStart;
        pipelineLog.addStageTime("parse", parseMs);

        // Post-process: doc symbolIds + navigation links
        assignNavigationAndDocSymbolId(chunks, basePath);

        // Apply chunk limits if configured
        const chunksToAdd = options.maxChunksPerFile ? chunks.slice(0, options.maxChunksPerFile) : chunks;

        let chunksAddedForFile = 0;
        let hitChunkLimit = false;
        for (const chunk of chunksToAdd) {
          // Check total chunk limit
          if (options.maxTotalChunks && result.chunksCreated >= options.maxTotalChunks) {
            hitChunkLimit = true;
            break;
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
              parentSymbolId: chunk.metadata.parentSymbolId,
              parentType: chunk.metadata.parentType,
              symbolId: chunk.metadata.symbolId,
              isDocumentation: chunk.metadata.isDocumentation,
              methodLines: chunk.metadata.methodLines,
              headingPath: chunk.metadata.headingPath,
              navigation: chunk.metadata.navigation,
              ...(imports.length > 0 && { imports }),
            } as CodeChunk["metadata"],
          };

          // Wait for backpressure if needed
          if (chunkPipeline.isBackpressured()) {
            await chunkPipeline.waitForBackpressure(30000);
          }

          // Send chunk to pipeline immediately
          const chunkId = generateChunkId(chunk);
          chunkPipeline.addChunk(baseChunk as CodeChunk, chunkId, basePath);
          result.chunksCreated++;
          chunksAddedForFile++;

          // Track for git enrichment
          if (options.enableGitMetadata) {
            const entries = result.chunkMap.get(filePath) || [];
            entries.push({
              chunkId,
              startLine: chunk.startLine,
              endLine: chunk.endLine,
              lineRanges: chunk.metadata.lineRanges,
            });
            result.chunkMap.set(filePath, entries);
          }
        }

        if (hitChunkLimit) {
          // Partial file — counter never advances; emit explicit skip so the
          // file still appears in post-mortem telemetry with skipReason.
          pipelineLog.fileIngested(
            { component: "FileProcessor" },
            {
              path: relativePath,
              language,
              bytes,
              chunks: chunksAddedForFile,
              parseMs,
              skipped: true,
              skipReason: "chunk-limit",
            },
          );
          return;
        }

        result.filesProcessed++;
        callbacks?.onFileProcessed?.(filePath, chunksToAdd.length);
        pipelineLog.fileIngested(
          { component: "FileProcessor" },
          {
            path: relativePath,
            language,
            bytes,
            chunks: chunksToAdd.length,
            parseMs,
          },
        );
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        result.errors.push(`Skipped ${filePath}: ${errorMessage}`);
        pipelineLog.fileIngested(
          { component: "FileProcessor" },
          {
            path: relativePath,
            language,
            bytes: 0,
            chunks: 0,
            parseMs: 0,
            skipped: true,
            skipReason: "error",
          },
        );
      }
    },
    concurrency,
  );

  return result;
}

/**
 * Process files given as relative paths, resolving them to absolute paths.
 * Merges resulting chunkMap entries into a provided shared map.
 *
 * Convenience wrapper for reindex workflows where file lists are relative to basePath.
 *
 * @param relativePaths - File paths relative to basePath
 * @param basePath - Base path of the codebase
 * @param chunkerPool - Pool for AST-aware chunking
 * @param chunkPipeline - Pipeline for embedding and storage
 * @param options - Processing options
 * @param chunkMap - Shared chunkMap to merge results into
 * @param label - Label for debug logging
 * @returns Number of chunks created
 */
export async function processRelativeFiles(
  relativePaths: string[],
  basePath: string,
  chunkerPool: ChunkerPool,
  chunkPipeline: ChunkPipeline,
  options: FileProcessorOptions,
  chunkMap: Map<string, ChunkLookupEntry[]>,
  label: string,
): Promise<number> {
  if (relativePaths.length === 0) return 0;

  const absolutePaths = relativePaths.map((f) => join(basePath, f));

  if (isDebug()) {
    console.error(`[Reindex] ${label}: starting ${relativePaths.length} files`);
  }

  const result = await processFiles(absolutePaths, basePath, chunkerPool, chunkPipeline, options);

  // Merge chunkMap entries
  for (const [key, entries] of result.chunkMap) {
    const existing = chunkMap.get(key) || [];
    chunkMap.set(key, [...existing, ...entries]);
  }

  if (isDebug()) {
    console.error(`[Reindex] ${label}: completed ${relativePaths.length} files, ${result.chunksCreated} chunks queued`);
  }

  return result.chunksCreated;
}

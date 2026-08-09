/**
 * SourceFileIngestor — one source file's trip through the ingest pipeline:
 * read → pre-parse skip policy → chunk → submit to ChunkPipeline → telemetry.
 *
 * `processFiles` owns the fan-out (parallelLimit) and the shared accumulator;
 * this owns what happens to a single file. Splitting there keeps the batch
 * orchestration readable and gives the per-file decision sequence — three skip
 * gates, a chunk-limit early exit, a quarantine path — its own named steps
 * instead of one 240-line closure.
 *
 * Every exit emits exactly ONE `FILE_INGESTED` record (the invariant the skip
 * reasons exist to preserve), so a post-mortem sees every touched file.
 */

import { promises as fs } from "node:fs";

import { isCompiledJsContent, isJsFamilyPath } from "../../../infra/file-classification/index.js";
import { isTestPath } from "../../../infra/scope-detection.js";
import type { CodeChunk } from "../../../types.js";
import { classifyQuarantinable } from "../sync/index.js";
import type { ChunkPipeline } from "./chunk-pipeline.js";
import { assignNavigationAndDocSymbolId } from "./chunker/chunk-navigation.js";
import type { ChunkerPool } from "./chunker/infra/pool.js";
import { assignSymbolMass } from "./chunker/symbol-mass.js";
import { generateChunkId } from "./chunker/utils/chunk-id.js";
import { extractImportsExports } from "./chunker/utils/import-extractor.js";
import { detectLanguage } from "./chunker/utils/language-detector.js";
import { containsSecrets } from "./chunker/utils/secrets-detector.js";
import type { FileProcessCallbacks, FileProcessorOptions, FileProcessResult } from "./file-processor.js";
import { pipelineLog, type FileIngestRecord } from "./infra/debug-logger.js";

/** Reasons a file is dropped BEFORE it is parsed — cheapest gates first. */
type PreParseSkipReason = Extract<FileIngestRecord["skipReason"], "delete-failed" | "secrets" | "compiled">;

/** What submitting one file's chunks to the pipeline produced. */
interface FileChunkSubmissionOutcome {
  chunksAdded: number;
  /** The run-wide `maxTotalChunks` ceiling cut this file short (partial file). */
  hitChunkLimit: boolean;
}

export interface SourceFileIngestorDeps {
  basePath: string;
  chunkerPool: ChunkerPool;
  chunkPipeline: ChunkPipeline;
  options: FileProcessorOptions;
  callbacks?: FileProcessCallbacks;
  /** Shared accumulator — mutated in place across the concurrent fan-out. */
  result: FileProcessResult;
}

export class SourceFileIngestor {
  constructor(private readonly deps: SourceFileIngestorDeps) {}

  async ingest(filePath: string): Promise<void> {
    const { options, callbacks, result, basePath, chunkerPool } = this.deps;
    // Declared outside try/catch so the error-path emission can reference them
    // even when failure happens before assignment.
    let relativePath = filePath;
    let language = "unknown";
    try {
      // Computed before readFile so the error/quarantine path keys the file
      // by its relative path even when the read itself fails.
      relativePath = filePath.startsWith(basePath) ? filePath.slice(basePath.length + 1) : filePath;
      const code = await fs.readFile(filePath, "utf-8");
      const bytes = Buffer.byteLength(code, "utf8");
      language = detectLanguage(filePath);

      const skipReason = this.preParseSkipReason(filePath, relativePath, code, language);
      if (skipReason) {
        if (skipReason === "secrets") {
          result.errors.push(`Skipped ${filePath}: potential secrets detected`);
        }
        this.report({ path: relativePath, language, bytes, chunks: 0, parseMs: 0, skipped: true, skipReason });
        return;
      }

      const { imports } = extractImportsExports(code, language);
      const parseStart = Date.now();
      const { chunks, extraction } = await chunkerPool.processFile(
        filePath,
        code,
        language,
        options.onFileExtraction !== undefined,
      );
      const parseMs = Date.now() - parseStart;
      pipelineLog.addStageTime("parse", parseMs);

      // yl9tv cross-pass — tee the codegraph extraction (from the chunker's
      // single parse) to the enrichment coordinator with a root-relative
      // relPath, so the codegraph provider's spill is fed from here instead of
      // re-parsing on the main thread.
      if (extraction && options.onFileExtraction) {
        extraction.relPath = relativePath;
        options.onFileExtraction(extraction);
      }

      // Post-process: doc symbolIds + navigation links
      assignNavigationAndDocSymbolId(chunks, basePath);
      // Post-process: symbol mass over the file's full chunk array. Runs
      // after doc symbolIds so documentation chunks are already identifiable.
      assignSymbolMass(chunks, code);

      // Apply chunk limits if configured
      const chunksToAdd = options.maxChunksPerFile ? chunks.slice(0, options.maxChunksPerFile) : chunks;
      const submission = await this.submitChunks(filePath, chunksToAdd, imports);

      if (submission.hitChunkLimit) {
        // Partial file — counter never advances; emit explicit skip so the
        // file still appears in post-mortem telemetry with skipReason.
        this.report({
          path: relativePath,
          language,
          bytes,
          chunks: submission.chunksAdded,
          parseMs,
          skipped: true,
          skipReason: "chunk-limit",
        });
        return;
      }

      result.filesProcessed++;
      // A previously-quarantined file that now succeeds is un-quarantined.
      if (options.quarantineStore && options.quarantinedRetry?.has(relativePath)) {
        await options.quarantineStore.clear(relativePath);
      }
      callbacks?.onFileProcessed?.(filePath, chunksToAdd.length);
      this.report({ path: relativePath, language, bytes, chunks: chunksToAdd.length, parseMs });
    } catch (error) {
      await this.recordFailure(filePath, relativePath, language, error);
    }
  }

  /**
   * Gates that run BEFORE parse/chunk, cheapest first — each one saves the full
   * parse cost on a file that must not reach the index.
   *
   * 1. Phase 3.2 reindex barrier: a file whose delete silently failed must not
   *    be re-upserted (orphan duplicates).
   * 2. Secrets: never embed credential-looking content from non-test files.
   * 3. 9oq5e Layer 2 — CONTENT net for a compiled JS bundle that slipped past
   *    the scanner's path-based ignore (e.g. committed under src/). Such a
   *    bundle is readable-but-compiled: it blows the tree-sitter parse budget
   *    (~51s for a 268KB d3.js) and pollutes a code RAG. JS-family only — gated
   *    on extension so .mjs/.cjs (which detectLanguage reports as "unknown")
   *    are still covered.
   */
  private preParseSkipReason(
    filePath: string,
    relativePath: string,
    code: string,
    language: string,
  ): PreParseSkipReason | undefined {
    const { coordinator } = this.deps.options;
    if (coordinator && !coordinator.canUpsertForFile(relativePath)) return "delete-failed";
    if (!isTestPath(relativePath, language) && containsSecrets(code)) return "secrets";
    if (isJsFamilyPath(filePath) && isCompiledJsContent(code)) return "compiled";
    return undefined;
  }

  /**
   * Hand this file's chunks to the pipeline one at a time, respecting the
   * run-wide chunk ceiling and the pipeline's backpressure signal, and track
   * each accepted chunk for git enrichment.
   */
  private async submitChunks(
    filePath: string,
    chunksToAdd: CodeChunk[],
    imports: string[],
  ): Promise<FileChunkSubmissionOutcome> {
    const { options, result, chunkPipeline, basePath } = this.deps;
    let chunksAdded = 0;

    for (const chunk of chunksToAdd) {
      // Check total chunk limit
      if (options.maxTotalChunks && result.chunksCreated >= options.maxTotalChunks) {
        return { chunksAdded, hitChunkLimit: true };
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
          memberCount: chunk.metadata.memberCount,
          moduleLines: chunk.metadata.moduleLines,
          moduleMethodCount: chunk.metadata.moduleMethodCount,
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
      chunksAdded++;

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

    return { chunksAdded, hitChunkLimit: false };
  }

  /**
   * Poison-pill quarantine: record read/parse failures so the file is retried
   * on the next pass instead of vanishing from the index. Falls through to the
   * plain "error" skip path when no store is wired or the error is
   * non-quarantinable (transient infra / programming invariant).
   */
  private async recordFailure(filePath: string, relativePath: string, language: string, error: unknown): Promise<void> {
    const { options, result } = this.deps;
    const errorMessage = error instanceof Error ? error.message : String(error);
    result.errors.push(`Skipped ${filePath}: ${errorMessage}`);

    const quarantinable = options.quarantineStore ? classifyQuarantinable(error, relativePath) : null;
    if (options.quarantineStore && quarantinable) {
      await options.quarantineStore.markFailed(relativePath, quarantinable);
    }

    this.report({
      path: relativePath,
      language,
      bytes: 0,
      chunks: 0,
      parseMs: 0,
      skipped: true,
      skipReason: quarantinable ? "quarantined" : "error",
    });
  }

  private report(record: FileIngestRecord): void {
    pipelineLog.fileIngested({ component: "FileProcessor" }, record);
  }
}

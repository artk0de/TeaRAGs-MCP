/**
 * MetadataApplier - Applies file-level git metadata to indexed chunks.
 *
 * Handles both streaming application (git log ready) and queued flush
 * (git log still reading). Also performs backfill for files outside
 * the --since window.
 */

import { relative } from "node:path";

import type { QdrantManager } from "../../adapters/qdrant/client.js";
import { computeFileMetadata, type GitLogReader } from "../git/git-log-reader.js";
import type { FileChurnData } from "../git/types.js";
import { pipelineLog } from "../pipeline/debug-logger.js";
import type { ChunkItem } from "../pipeline/types.js";

const BATCH_SIZE = 100;

export interface ApplyDiagnostics {
  matchedFiles: number;
  missedFiles: number;
  missedPathSamples: string[];
  missedFileChunks: Map<string, { chunkId: string; endLine: number }[]>;
}

export class MetadataApplier {
  // Path match diagnostics (accumulated across applies)
  matchedFiles = 0;
  missedFiles = 0;
  readonly missedPathSamples: string[] = [];
  readonly missedFileChunks = new Map<string, { chunkId: string; endLine: number }[]>();

  constructor(private readonly qdrant: QdrantManager) {}

  /**
   * Apply file-level git metadata to a batch of chunks via batchSetPayload.
   */
  async applyFileMetadata(
    collectionName: string,
    gitLogResult: Map<string, FileChurnData>,
    pathBase: string,
    items: ChunkItem[],
  ): Promise<void> {
    const applyStart = Date.now();

    // Group items by filePath
    const byFile = new Map<string, ChunkItem[]>();
    for (const item of items) {
      const fp = item.chunk.metadata.filePath;
      const existing = byFile.get(fp) || [];
      existing.push(item);
      byFile.set(fp, existing);
    }

    const operations: {
      payload: Record<string, unknown>;
      points: (string | number)[];
    }[] = [];

    for (const [filePath, fileItems] of byFile) {
      const relativePath = relative(pathBase, filePath);
      const churnData: FileChurnData | undefined = gitLogResult.get(relativePath);
      if (!churnData) {
        this.missedFiles++;
        if (this.missedPathSamples.length < 10) {
          this.missedPathSamples.push(relativePath);
        }
        // Track for backfill
        const existing = this.missedFileChunks.get(relativePath) || [];
        for (const item of fileItems) {
          existing.push({ chunkId: item.chunkId, endLine: item.chunk.endLine });
        }
        this.missedFileChunks.set(relativePath, existing);
        continue;
      }
      this.matchedFiles++;

      const maxEndLine = fileItems.reduce((max, item) => Math.max(max, item.chunk.endLine), 0);
      const metadata = computeFileMetadata(churnData, maxEndLine);
      const gitPayload = { git: metadata };

      for (const item of fileItems) {
        operations.push({ payload: gitPayload, points: [item.chunkId] });
      }
    }

    if (operations.length === 0) return;

    for (let i = 0; i < operations.length; i += BATCH_SIZE) {
      const batch = operations.slice(i, i + BATCH_SIZE);
      try {
        await this.qdrant.batchSetPayload(collectionName, batch);
      } catch (error) {
        if (process.env.DEBUG) {
          console.error("[MetadataApplier] batchSetPayload failed:", error);
        }
      }
    }

    const applyDuration = Date.now() - applyStart;
    pipelineLog.addStageTime("enrichApply", applyDuration);
  }

  /**
   * Backfill file-level git metadata for files not in the main --since window.
   * Runs `git log --numstat -- <paths>` without --since restriction.
   */
  async backfillMissedFiles(collectionName: string, logReader: GitLogReader, gitRepoRoot: string): Promise<void> {
    if (this.missedFileChunks.size === 0) return;

    const missedPaths = Array.from(this.missedFileChunks.keys());
    pipelineLog.enrichmentPhase("BACKFILL_START", {
      missedFiles: missedPaths.length,
    });

    const backfillStart = Date.now();
    let backfillData: Map<string, FileChurnData>;
    try {
      const timeoutMs = parseInt(process.env.GIT_BACKFILL_TIMEOUT_MS ?? "30000", 10);
      backfillData = await logReader.buildFileMetadataForPaths(gitRepoRoot, missedPaths, timeoutMs);
    } catch (error) {
      pipelineLog.enrichmentPhase("BACKFILL_FAILED", {
        error: error instanceof Error ? error.message : String(error),
      });
      return;
    }

    const operations: {
      payload: Record<string, unknown>;
      points: (string | number)[];
    }[] = [];
    let backfilledFiles = 0;

    for (const [relPath, chunks] of this.missedFileChunks) {
      const churnData: FileChurnData | undefined = backfillData.get(relPath);
      if (!churnData) continue;

      const maxEndLine = chunks.reduce((max, c) => Math.max(max, c.endLine), 0);
      const metadata = computeFileMetadata(churnData, maxEndLine);
      const gitPayload = { git: metadata };

      for (const chunk of chunks) {
        operations.push({ payload: gitPayload, points: [chunk.chunkId] });
      }
      backfilledFiles++;
    }

    if (operations.length > 0) {
      for (let i = 0; i < operations.length; i += BATCH_SIZE) {
        const batch = operations.slice(i, i + BATCH_SIZE);
        try {
          await this.qdrant.batchSetPayload(collectionName, batch);
        } catch (error) {
          if (process.env.DEBUG) {
            console.error("[MetadataApplier] backfill batchSetPayload failed:", error);
          }
        }
      }
    }

    const backfillDuration = Date.now() - backfillStart;
    this.matchedFiles += backfilledFiles;
    this.missedFiles -= backfilledFiles;

    pipelineLog.enrichmentPhase("BACKFILL_COMPLETE", {
      missedFiles: missedPaths.length,
      backfilledFiles,
      backfilledChunks: operations.length,
      stillMissed: missedPaths.length - backfilledFiles,
      durationMs: backfillDuration,
    });
  }
}

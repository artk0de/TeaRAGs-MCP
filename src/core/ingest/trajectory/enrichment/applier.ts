/**
 * EnrichmentApplier — provider-agnostic payload writer for Qdrant.
 *
 * Writes enrichment data under nested structure:
 * - File-level: { [providerKey]: { file: data } }
 * - Chunk-level: { [providerKey]: { chunk: overlay } }
 *
 * Replaces git-specific MetadataApplier + chunk-churn write logic.
 */

import { relative } from "node:path";

import type { QdrantManager } from "../../../adapters/qdrant/client.js";
import { pipelineLog } from "../../pipeline/debug-logger.js";
import type { ChunkItem } from "../../pipeline/types.js";

const BATCH_SIZE = 100;

export type FileTransform = (data: Record<string, unknown>, maxEndLine: number) => Record<string, unknown>;

export class EnrichmentApplier {
  matchedFiles = 0;
  missedFiles = 0;
  readonly missedPathSamples: string[] = [];
  readonly missedFileChunks = new Map<string, { chunkId: string; endLine: number }[]>();

  constructor(private readonly qdrant: QdrantManager) {}

  /**
   * Apply file-level metadata to a batch of chunks.
   * Payload written as { [providerKey]: { file: data } }.
   *
   * @param transform Optional per-file transform called with (rawData, maxEndLine).
   *   Git uses this for computeFileMetadata(churnData, maxEndLine).
   */
  async applyFileMetadata(
    collectionName: string,
    providerKey: string,
    fileMetadata: Map<string, Record<string, unknown>>,
    pathBase: string,
    items: ChunkItem[],
    transform?: FileTransform,
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
      const data = fileMetadata.get(relativePath);
      if (!data) {
        this.missedFiles++;
        if (this.missedPathSamples.length < 10) {
          this.missedPathSamples.push(relativePath);
        }
        const existing = this.missedFileChunks.get(relativePath) || [];
        for (const item of fileItems) {
          existing.push({ chunkId: item.chunkId, endLine: item.chunk.endLine });
        }
        this.missedFileChunks.set(relativePath, existing);
        continue;
      }
      this.matchedFiles++;

      const maxEndLine = fileItems.reduce((max, item) => Math.max(max, item.chunk.endLine), 0);
      const finalData = transform ? transform(data, maxEndLine) : data;
      const payload = { [providerKey]: { file: finalData } };

      for (const item of fileItems) {
        operations.push({ payload, points: [item.chunkId] });
      }
    }

    if (operations.length === 0) return;

    for (let i = 0; i < operations.length; i += BATCH_SIZE) {
      const batch = operations.slice(i, i + BATCH_SIZE);
      try {
        await this.qdrant.batchSetPayload(collectionName, batch);
      } catch (error) {
        if (process.env.DEBUG) {
          console.error("[EnrichmentApplier] batchSetPayload failed:", error);
        }
      }
    }

    pipelineLog.addStageTime("enrichApply", Date.now() - applyStart);
  }

  /**
   * Apply chunk-level metadata overlays.
   * Payload written as { [providerKey]: { chunk: overlay } }.
   */
  async applyChunkMetadata(
    collectionName: string,
    providerKey: string,
    chunkMetadata: Map<string, Map<string, Record<string, unknown>>>,
  ): Promise<number> {
    let batch: {
      payload: Record<string, unknown>;
      points: (string | number)[];
    }[] = [];
    let applied = 0;

    for (const [, overlayMap] of chunkMetadata) {
      for (const [chunkId, overlay] of overlayMap) {
        batch.push({
          payload: { [providerKey]: { chunk: overlay } },
          points: [chunkId],
        });

        if (batch.length >= BATCH_SIZE) {
          try {
            await this.qdrant.batchSetPayload(collectionName, batch);
            applied += batch.length;
          } catch (error) {
            if (process.env.DEBUG) {
              console.error("[EnrichmentApplier] chunk batch failed:", error);
            }
          }
          batch = [];
        }
      }
    }

    if (batch.length > 0) {
      try {
        await this.qdrant.batchSetPayload(collectionName, batch);
        applied += batch.length;
      } catch (error) {
        if (process.env.DEBUG) {
          console.error("[EnrichmentApplier] final chunk batch failed:", error);
        }
      }
    }

    return applied;
  }
}

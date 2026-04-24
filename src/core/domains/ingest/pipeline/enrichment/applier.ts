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

import type { QdrantManager } from "../../../../adapters/qdrant/client.js";
import type {
  ChunkSignalOverlay,
  FileSignalOverlay,
  FileSignalTransform,
} from "../../../../contracts/types/provider.js";
import { pipelineLog } from "../infra/debug-logger.js";
import { isDebug } from "../infra/runtime.js";
import type { ChunkItem } from "../types.js";

const BATCH_SIZE = 100;

export class EnrichmentApplier {
  matchedFiles = 0;
  missedFiles = 0;
  readonly missedPathSamples: string[] = [];
  readonly missedFileChunks = new Map<string, { chunkId: string; endLine: number }[]>();

  constructor(private readonly qdrant: QdrantManager) {}

  /**
   * Apply file-level signals to a batch of chunks.
   * Payload written as { [providerKey]: { file: data } }.
   *
   * @param transform Optional per-file transform called with (rawData, maxEndLine).
   *   Git uses this for computeFileSignals(churnData, maxEndLine).
   */
  async applyFileSignals(
    collectionName: string,
    providerKey: string,
    fileMetadata: Map<string, FileSignalOverlay>,
    pathBase: string,
    items: ChunkItem[],
    transform?: FileSignalTransform,
    enrichedAt?: string,
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
      key?: string;
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
        if (enrichedAt) {
          for (const item of fileItems) {
            // File-level stamp: marks "we tried, no git history".
            operations.push({
              payload: { enrichedAt },
              points: [item.chunkId],
              key: `${providerKey}.file`,
            });
            // Chunk-level stamp: same semantics. Without this, recovery keeps
            // counting these chunks forever and forces chunk.status=degraded
            // even though there is nothing retriable.
            operations.push({
              payload: { enrichedAt },
              points: [item.chunkId],
              key: `${providerKey}.chunk`,
            });
          }
        }
        continue;
      }
      this.matchedFiles++;

      const maxEndLine = fileItems.reduce((max, item) => Math.max(max, item.chunk.endLine), 0);
      const finalData = transform ? transform(data, maxEndLine) : data;
      const payload = enrichedAt
        ? { ...(finalData as Record<string, unknown>), enrichedAt }
        : (finalData as Record<string, unknown>);

      for (const item of fileItems) {
        operations.push({
          payload,
          points: [item.chunkId],
          key: `${providerKey}.file`,
        });
      }
    }

    if (operations.length === 0) return;

    for (let i = 0; i < operations.length; i += BATCH_SIZE) {
      const batch = operations.slice(i, i + BATCH_SIZE);
      try {
        await this.qdrant.batchSetPayload(collectionName, batch);
      } catch (error) {
        if (isDebug()) {
          console.error("[EnrichmentApplier] batchSetPayload failed:", error);
        }
      }
    }

    pipelineLog.addStageTime("enrichApply", Date.now() - applyStart);
  }

  /**
   * Apply chunk-level signal overlays.
   * Payload written as { [providerKey]: { chunk: overlay } }.
   */
  async applyChunkSignals(
    collectionName: string,
    providerKey: string,
    chunkMetadata: Map<string, Map<string, ChunkSignalOverlay>>,
    enrichedAt?: string,
    /** All chunk IDs that were requested for enrichment. Used to stamp enrichedAt
     *  on chunks that buildChunkSignals found no commits for — so they don't
     *  remain "unenriched" forever and trigger infinite recovery loops. */
    allRequestedChunkIds?: Set<string>,
  ): Promise<number> {
    const enrichedChunkIds = new Set<string>();
    let batch: {
      payload: Record<string, unknown>;
      points: (string | number)[];
      key?: string;
    }[] = [];
    let applied = 0;

    for (const [, overlayMap] of chunkMetadata) {
      for (const [chunkId, overlay] of overlayMap) {
        enrichedChunkIds.add(chunkId);
        const payload = enrichedAt
          ? { ...(overlay as Record<string, unknown>), enrichedAt }
          : (overlay as Record<string, unknown>);
        batch.push({
          payload,
          points: [chunkId],
          key: `${providerKey}.chunk`,
        });

        if (batch.length >= BATCH_SIZE) {
          try {
            await this.qdrant.batchSetPayload(collectionName, batch);
            applied += batch.length;
          } catch (error) {
            if (isDebug()) {
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
        if (isDebug()) {
          console.error("[EnrichmentApplier] final chunk batch failed:", error);
        }
      }
    }

    // Stamp enrichedAt on chunks that had no commits (not in chunkMetadata).
    // Without this, these chunks stay "unenriched" and recovery retries forever.
    if (enrichedAt && allRequestedChunkIds) {
      const missed: string[] = [];
      for (const id of allRequestedChunkIds) {
        if (!enrichedChunkIds.has(id)) missed.push(id);
      }

      if (missed.length > 0) {
        for (let i = 0; i < missed.length; i += BATCH_SIZE) {
          const stampBatch = missed.slice(i, i + BATCH_SIZE).map((id) => ({
            payload: { enrichedAt } as Record<string, unknown>,
            points: [id] as (string | number)[],
            key: `${providerKey}.chunk`,
          }));
          try {
            await this.qdrant.batchSetPayload(collectionName, stampBatch);
            applied += stampBatch.length;
          } catch (error) {
            if (isDebug()) {
              console.error("[EnrichmentApplier] enrichedAt stamp batch failed:", error);
            }
          }
        }
      }
    }

    return applied;
  }
}

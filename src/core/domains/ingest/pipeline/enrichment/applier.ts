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
import { MissedFileTracker } from "./missed-file-tracker.js";
import type { MissedFileChunk } from "./types.js";

const BATCH_SIZE = 100;
const MISSED_PATH_SAMPLE_LIMIT = 10;

export class EnrichmentApplier {
  matchedFiles = 0;
  private readonly missedTracker = new MissedFileTracker({
    sampleLimit: MISSED_PATH_SAMPLE_LIMIT,
  });

  constructor(private readonly qdrant: QdrantManager) {}

  /** Count of files whose chunks landed without matching file metadata. */
  get missedFiles(): number {
    return this.missedTracker.missedCount;
  }

  /** Bounded sample of missed paths (capped at MISSED_PATH_SAMPLE_LIMIT). */
  get missedPathSamples(): readonly string[] {
    return this.missedTracker.samples;
  }

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
        this.missedTracker.track(
          relativePath,
          fileItems.map((item) => ({
            chunkId: item.chunkId,
            startLine: item.chunk.startLine,
            endLine: item.chunk.endLine,
          })),
        );
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
   * Apply file-level overlays keyed by an accumulated chunkMap
   * (relPath → ChunkLookupEntry[]) rather than a ChunkItem[] batch. Used by the
   * codegraph finalize file-apply path: the deferred chunkMap that ChunkPhase
   * assembled gives us relPath → chunkId mapping, but no ChunkItem objects.
   *
   * Mirrors EnrichmentBackfiller.runFor's file-apply loop: per file, resolve the
   * overlay, compute maxEndLine across its entries, transform, stamp enrichedAt,
   * and write one `${providerKey}.file` op per chunkId.
   *
   * @returns number of files applied (overlay present + at least one entry).
   */
  async applyFinalizeFile(
    collectionName: string,
    providerKey: string,
    fileOverlays: Map<string, FileSignalOverlay>,
    chunkMap: ReadonlyMap<string, readonly { chunkId: string; startLine: number; endLine: number }[]>,
    transform?: FileSignalTransform,
    enrichedAt?: string,
  ): Promise<number> {
    const fileKey = `${providerKey}.file`;
    const ops: {
      payload: Record<string, unknown>;
      points: (string | number)[];
      key: string;
    }[] = [];
    let appliedFiles = 0;

    for (const [relPath, entries] of chunkMap) {
      const overlay = fileOverlays.get(relPath);
      if (!overlay) {
        // File the deferred provider didn't produce a file overlay for (e.g. a
        // language it doesn't graph: markdown / json). Stamp a bare enrichedAt
        // so these chunks aren't counted "unenriched" forever — mirrors the
        // miss-stamp semantics of applyFileSignals / applyChunkSignals.
        if (enrichedAt) {
          for (const entry of entries) {
            ops.push({ payload: { enrichedAt }, points: [entry.chunkId], key: fileKey });
          }
        }
        continue;
      }
      const maxEndLine = entries.reduce((max, e) => Math.max(max, e.endLine), 0);
      const final = transform ? transform(overlay, maxEndLine) : overlay;
      const payload = enrichedAt
        ? { ...(final as Record<string, unknown>), enrichedAt }
        : (final as Record<string, unknown>);
      for (const entry of entries) {
        ops.push({ payload, points: [entry.chunkId], key: fileKey });
      }
      appliedFiles++;
      this.matchedFiles++;
    }

    for (let i = 0; i < ops.length; i += BATCH_SIZE) {
      try {
        await this.qdrant.batchSetPayload(collectionName, ops.slice(i, i + BATCH_SIZE));
      } catch (error) {
        if (isDebug()) {
          console.error("[EnrichmentApplier] applyFinalizeFile batch failed:", error);
        }
      }
    }

    return appliedFiles;
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

  /** Read-only snapshot of files whose chunks landed without matching file metadata. */
  getMissedFileChunks(): ReadonlyMap<string, readonly MissedFileChunk[]> {
    return this.missedTracker.chunkMap;
  }

  /** Adjust matched/missed counters after a successful backfill. */
  markBackfilled(count: number): void {
    this.matchedFiles += count;
    this.missedTracker.decrementMissed(count);
  }
}

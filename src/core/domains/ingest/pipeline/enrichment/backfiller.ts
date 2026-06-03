/**
 * EnrichmentBackfiller — closed loop for files whose chunks landed without
 * matching file metadata in the original prefetch.
 *
 * Reads applier.getMissedFileChunks(), fetches file+chunk overlays via the
 * provider, applies them via the applier, then updates counters via
 * applier.markBackfilled(count). All state mutation lives on the applier; this
 * component owns the orchestration only.
 *
 * Writes use the nested `key` parameter (`<providerKey>.file` / `.chunk`) so
 * Qdrant scopes the set to that sub-tree — without it, `{git: {file: ...}}`
 * would replace the entire `git` payload and clobber sibling sub-trees written
 * earlier in this same run.
 */

import type { QdrantManager } from "../../../../adapters/qdrant/client.js";
import type { EnrichmentExecutor } from "../../../../contracts/types/enrichment-executor.js";
import type { ChunkSignalOverlay, FileSignalOverlay } from "../../../../contracts/types/provider.js";
import type { ChunkLookupEntry } from "../../../../types.js";
import { pipelineLog } from "../infra/debug-logger.js";
import { isDebug } from "../infra/runtime.js";
import type { EnrichmentApplier } from "./applier.js";
import type { ProviderContext } from "./types.js";

const BATCH_SIZE = 100;

export class EnrichmentBackfiller {
  constructor(
    private readonly applier: EnrichmentApplier,
    private readonly qdrant: QdrantManager,
    private readonly executor: EnrichmentExecutor,
  ) {}

  async runFor(coll: string, ctx: ProviderContext, runStartedAt: string): Promise<void> {
    const missed = this.applier.getMissedFileChunks();
    if (missed.size === 0) return;
    if (!ctx.effectiveRoot) return;

    const root = ctx.effectiveRoot;
    const missedPaths = Array.from(missed.keys());
    pipelineLog.enrichmentPhase("BACKFILL_START", {
      provider: ctx.key,
      missedFiles: missedPaths.length,
    });

    const start = Date.now();
    let backfillData: Map<string, FileSignalOverlay>;
    try {
      // Whole-set semantics: backfill must NOT route through streamFileBatch
      // (whose extraction side-effects belong to the streaming file phase).
      // Forward the active collection so codegraph (and any other
      // collection-scoped provider) backfills the right per-collection
      // store, not a stale default one.
      backfillData = await this.executor.runFileSignals(ctx.provider, root, missedPaths, {
        collectionName: coll,
      });
    } catch (error) {
      pipelineLog.enrichmentPhase("BACKFILL_FAILED", {
        provider: ctx.key,
        error: error instanceof Error ? error.message : String(error),
      });
      return;
    }

    const fileKey = `${ctx.key}.file`;
    const ops: {
      payload: Record<string, unknown>;
      points: (string | number)[];
      key: string;
    }[] = [];
    const backfilledPaths: string[] = [];

    for (const [relPath, chunks] of missed) {
      const data = backfillData.get(relPath);
      if (!data) continue;
      const maxEndLine = chunks.reduce((max, c) => Math.max(max, c.endLine), 0);
      const final = ctx.provider.fileSignalTransform ? ctx.provider.fileSignalTransform(data, maxEndLine) : data;
      const fileData = runStartedAt
        ? { ...(final as Record<string, unknown>), enrichedAt: runStartedAt }
        : (final as Record<string, unknown>);
      for (const chunk of chunks) {
        ops.push({ payload: fileData, points: [chunk.chunkId], key: fileKey });
      }
      backfilledPaths.push(relPath);
    }

    if (ops.length > 0) {
      for (let i = 0; i < ops.length; i += BATCH_SIZE) {
        try {
          await this.qdrant.batchSetPayload(coll, ops.slice(i, i + BATCH_SIZE));
        } catch (error) {
          if (isDebug()) {
            console.error(`[Enrichment:${ctx.key}] backfill batch failed:`, error);
          }
        }
      }
    }

    this.applier.markBackfilled(backfilledPaths);

    pipelineLog.enrichmentPhase("BACKFILL_COMPLETE", {
      provider: ctx.key,
      missedFiles: missedPaths.length,
      backfilledFiles: backfilledPaths.length,
      backfilledChunks: ops.length,
      stillMissed: missedPaths.length - backfilledPaths.length,
      durationMs: Date.now() - start,
    });

    await this.backfillChunkSignals(coll, ctx, backfillData, runStartedAt);
  }

  private async backfillChunkSignals(
    coll: string,
    ctx: ProviderContext,
    backfillData: Map<string, FileSignalOverlay>,
    runStartedAt: string,
  ): Promise<void> {
    const root = ctx.effectiveRoot;
    if (!root) return;

    const map = new Map<string, ChunkLookupEntry[]>();
    for (const [relPath, chunks] of this.applier.getMissedFileChunks()) {
      if (!backfillData.has(relPath)) continue;
      map.set(
        relPath,
        chunks.map((c) => ({
          chunkId: c.chunkId,
          startLine: c.startLine,
          endLine: c.endLine,
        })),
      );
    }
    if (map.size === 0) return;

    const start = Date.now();
    pipelineLog.enrichmentPhase("CHUNK_BACKFILL_START", {
      provider: ctx.key,
      files: map.size,
      chunks: [...map.values()].reduce((sum, arr) => sum + arr.length, 0),
    });

    let overlays: Map<string, Map<string, ChunkSignalOverlay>>;
    try {
      overlays = await this.executor.runChunkBatch(ctx.provider, root, map, { collectionName: coll });
    } catch (error) {
      pipelineLog.enrichmentPhase("CHUNK_BACKFILL_FAILED", {
        provider: ctx.key,
        error: error instanceof Error ? error.message : String(error),
      });
      return;
    }

    const chunkKey = `${ctx.key}.chunk`;
    const ops: {
      payload: Record<string, unknown>;
      points: (string | number)[];
      key: string;
    }[] = [];
    for (const chunkMap of overlays.values()) {
      for (const [chunkId, overlay] of chunkMap) {
        const chunkData = runStartedAt
          ? {
              ...(overlay as Record<string, unknown>),
              enrichedAt: runStartedAt,
            }
          : (overlay as Record<string, unknown>);
        ops.push({
          payload: chunkData,
          points: [chunkId],
          key: chunkKey,
        });
      }
    }

    if (ops.length > 0) {
      for (let i = 0; i < ops.length; i += BATCH_SIZE) {
        try {
          await this.qdrant.batchSetPayload(coll, ops.slice(i, i + BATCH_SIZE));
        } catch (error) {
          if (isDebug()) {
            console.error(`[Enrichment:${ctx.key}] chunk backfill batch failed:`, error);
          }
        }
      }
    }

    pipelineLog.enrichmentPhase("CHUNK_BACKFILL_COMPLETE", {
      provider: ctx.key,
      files: map.size,
      chunks: ops.length,
      durationMs: Date.now() - start,
    });
  }
}

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
import type { PhysicalCollectionName } from "../../../../contracts/types/collection-identity.js";
import type { EnrichmentExecutor } from "../../../../contracts/types/enrichment-executor.js";
import type { ChunkSignalOverlay, FileSignalOverlay } from "../../../../contracts/types/provider.js";
import type { ChunkLookupEntry } from "../../../../types.js";
import { pipelineLog } from "../infra/debug-logger.js";
import type { EnrichmentApplier } from "./applier.js";
import { batchDeletePayloadWithRetry, batchSetPayloadWithRetry, type BatchPayloadOp } from "./batch-write.js";
import { OmittedOverlayKeyCollector } from "./omitted-overlay-keys.js";
import { filterChunkEnrichMap, filterFileEnrichPaths } from "./policy.js";
import type { ProviderContext } from "./types.js";

const BATCH_SIZE = 100;

/**
 * Write overlay ops, then delete the optional keys they omit — the applier's
 * overlay contract, for the one writer that builds its own ops (bd
 * tea-rags-mcp-9mwny). Every op here IS an overlay: the backfill writes no bare
 * stamps. Points of a batch that never landed keep their old overlay whole.
 */
async function writeOverlayOps(
  qdrant: QdrantManager,
  coll: PhysicalCollectionName,
  ops: BatchPayloadOp[],
  levelKey: string,
  optionalKeys: readonly string[] | undefined,
): Promise<void> {
  const omissions = new OmittedOverlayKeyCollector(levelKey, optionalKeys ?? []);
  for (let i = 0; i < ops.length; i += BATCH_SIZE) {
    const batch = ops.slice(i, i + BATCH_SIZE);
    if (!(await batchSetPayloadWithRetry(qdrant, coll, batch))) continue;
    for (const op of batch) omissions.add(op.payload, op.points);
  }
  await batchDeletePayloadWithRetry(qdrant, coll, omissions.toOps());
}

export class EnrichmentBackfiller {
  constructor(
    private readonly applier: EnrichmentApplier,
    private readonly qdrant: QdrantManager,
    private readonly executor: EnrichmentExecutor,
  ) {}

  async runFor(coll: PhysicalCollectionName, ctx: ProviderContext, runStartedAt: string): Promise<void> {
    const missed = this.applier.getMissedFileChunks();
    if (missed.size === 0) return;
    if (!ctx.effectiveRoot) return;

    const root = ctx.effectiveRoot;
    // Per-file enrichment policy: a generated file (scope "none") is a "missed
    // file" by construction — its chunks landed without file metadata BECAUSE
    // the streaming phase intentionally skipped it. Re-enriching it here would
    // resurrect the very git signals the policy suppresses. Drop scope-"none"
    // paths before backfill so the skip holds across this path too.
    const missedPaths = filterFileEnrichPaths(ctx.provider, Array.from(missed.keys()));
    if (missedPaths.length === 0) return;
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
      backfillData = await this.executor.runFileSignalsRecovery(ctx.provider, root, missedPaths, {
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

    await writeOverlayOps(this.qdrant, coll, ops, fileKey, ctx.provider.optionalOverlayKeys?.file);

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
    coll: PhysicalCollectionName,
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
          ...(c.symbolId !== undefined ? { symbolId: c.symbolId } : {}),
        })),
      );
    }
    // Per-file policy: only "full"-scope files get the chunk-churn walk. Drops
    // "file-only" (docs) so chunk backfill never resurrects the chunk signals
    // the streaming chunk phase deliberately skipped.
    const scoped = filterChunkEnrichMap(ctx.provider, map);
    if (scoped.size === 0) return;

    const start = Date.now();
    pipelineLog.enrichmentPhase("CHUNK_BACKFILL_START", {
      provider: ctx.key,
      files: scoped.size,
      chunks: [...scoped.values()].reduce((sum, arr) => sum + arr.length, 0),
    });

    let overlays: Map<string, Map<string, ChunkSignalOverlay>>;
    try {
      overlays = await this.executor.runChunkBatch(ctx.provider, root, scoped, { collectionName: coll });
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

    await writeOverlayOps(this.qdrant, coll, ops, chunkKey, ctx.provider.optionalOverlayKeys?.chunk);

    pipelineLog.enrichmentPhase("CHUNK_BACKFILL_COMPLETE", {
      provider: ctx.key,
      files: scoped.size,
      chunks: ops.length,
      durationMs: Date.now() - start,
    });
  }
}

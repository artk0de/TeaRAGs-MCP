/**
 * FilePhase — per-batch streaming file enrichment.
 *
 * onBatch computes the batch's file signals via streamFileBatch (fallback
 * buildFileSignals({ paths })) and applies them immediately — no whole-repo
 * prefetch gate. Fully-deferred providers (codegraph) are SKIPPED in onBatch;
 * their file overlays come from finalizeSignals applied via applyFinalize.
 * On a stream/finalize failure FilePhase marks the provider failed and signals
 * chunkPhase.markFailed so ChunkPhase skips it.
 */

import { relative } from "node:path";

import type { FileSignalOptions, FileSignalOverlay } from "../../../../contracts/types/provider.js";
import { pipelineLog } from "../infra/debug-logger.js";
import type { ChunkItem } from "../types.js";
import type { EnrichmentApplier } from "./applier.js";
import type { ChunkPhase } from "./chunk-phase.js";
import type { EnrichmentMarkerStore } from "./marker-store.js";
import type { ProviderContext } from "./types.js";

interface FilePhaseState {
  prefetchFailed: boolean;
  fileWork: Promise<void>[];
  prefetchStartTime: number;
  prefetchEndTime: number;
  pipelineFlushTime: number;
  prefetchDurationMs: number;
  streamingApplies: number;
  flushApplies: number;
  fileMetadataCount: number;
}

function createState(): FilePhaseState {
  return {
    prefetchFailed: false,
    fileWork: [],
    prefetchStartTime: 0,
    prefetchEndTime: 0,
    pipelineFlushTime: 0,
    prefetchDurationMs: 0,
    streamingApplies: 0,
    flushApplies: 0,
    fileMetadataCount: 0,
  };
}

function extractErrorMessage(error: unknown): string {
  // Walk the cause chain so wrapped errors (e.g. CodegraphResolveError →
  // DuckDB driver error) surface the underlying message instead of the
  // generic outer wrapper. Without this, the marker only sees "Codegraph
  // resolve failed after 291 files" while the actual cause (constraint
  // violation, JSON parse, file-level resolver throw) is lost.
  if (!(error instanceof Error)) return String(error);
  const parts: string[] = [error.message];
  let cur: unknown = (error as { cause?: unknown }).cause;
  // Guard against pathological cycles (cause chain referencing itself).
  const seen = new Set<unknown>([error]);
  while (cur instanceof Error && !seen.has(cur)) {
    seen.add(cur);
    parts.push(`caused by: ${cur.message}`);
    cur = (cur as { cause?: unknown }).cause;
  }
  return parts.join(" → ");
}

export interface FilePhaseMetrics {
  maxPrefetchDurationMs: number;
  totalStreamingApplies: number;
  totalFlushApplies: number;
  totalFileMetadataCount: number;
  firstProvider: {
    prefetchStartTime: number;
    prefetchEndTime: number;
    pipelineFlushTime: number;
  } | null;
}

export class FilePhase {
  private readonly states = new Map<string, FilePhaseState>();
  private contexts: Map<string, ProviderContext> = new Map();
  private coll = "";
  private runId = "";
  private runStartedAt = "";
  private chunkPhase: ChunkPhase | null = null;

  constructor(
    private readonly applier: EnrichmentApplier,
    private readonly markerStore: EnrichmentMarkerStore,
  ) {}

  /**
   * Bind the ChunkPhase that FilePhase signals on a stream/finalize failure
   * (chunkPhase.markFailed) so ChunkPhase skips the failed provider. Optional —
   * ChunkPhase remains drivable directly for unit-level tests.
   */
  bindChunkPhase(chunkPhase: ChunkPhase): void {
    this.chunkPhase = chunkPhase;
  }

  init(contexts: ReadonlyMap<string, ProviderContext>, coll: string, runId: string, runStartedAt: string): void {
    this.contexts = new Map(contexts);
    this.coll = coll;
    this.runId = runId;
    this.runStartedAt = runStartedAt;
    this.states.clear();
    for (const key of contexts.keys()) this.states.set(key, createState());
  }

  /**
   * Stream this batch's file signals and apply immediately. Returns the batch's
   * file-work promise so the coordinator can sequence file→chunk per batch.
   * Fully-deferred providers (codegraph) are skipped entirely — their file
   * overlays come from applyFinalize, and their miss-tracking is irrelevant.
   */
  async onBatch(coll: string, absolutePath: string, items: ChunkItem[]): Promise<void> {
    const collected: Promise<void>[] = [];
    for (const ctx of this.contexts.values()) {
      const state = this.states.get(ctx.key);
      if (!state) continue;
      // pipelineFlushTime tracks when chunks first land — best-effort overlap
      // metric. Recorded even for failed providers (mirrors original).
      state.pipelineFlushTime = Date.now();
      if (state.prefetchStartTime === 0) state.prefetchStartTime = state.pipelineFlushTime;
      if (state.prefetchFailed) continue;

      const root = ctx.effectiveRoot ?? absolutePath;
      const relPaths = this.uniqueRelPaths(items, root);

      // Fully-deferred providers (codegraph): still DRIVE streamFileBatch so the
      // run sink extracts the batch into the graph during embedding overlap, but
      // do NOT apply the (empty) result and do NOT miss-track — file overlays
      // are read back once the graph is finalized via finalizeSignals →
      // applyFinalize. Skipping the call entirely would leave the graph empty
      // (degraded file signals + zero chunk signals).
      if (ctx.provider.defersChunkEnrichment) {
        if (!ctx.provider.streamFileBatch) continue;
        const extractWork = ctx.provider
          .streamFileBatch(root, relPaths, {
            collectionName: this.coll || undefined,
            ignoreFilter: ctx.ignoreFilter ?? undefined,
          })
          .then(() => undefined)
          .catch(async (error: unknown) => {
            await this.recordPrefetchFailure(ctx, state, error);
          });
        state.fileWork.push(extractWork);
        collected.push(extractWork);
        continue;
      }

      const streamFn =
        ctx.provider.streamFileBatch ??
        (async (r: string, p: string[], o?: FileSignalOptions) => ctx.provider.buildFileSignals(r, { ...o, paths: p }));

      const work = streamFn(root, relPaths, {
        collectionName: this.coll || undefined,
        ignoreFilter: ctx.ignoreFilter ?? undefined,
      })
        .then(async (overlays) => {
          await this.applier.applyFileSignals(
            coll,
            ctx.key,
            overlays,
            root,
            items,
            ctx.provider.fileSignalTransform,
            this.runStartedAt,
          );
          state.streamingApplies++;
          pipelineLog.enrichmentPhase("STREAMING_APPLY", {
            provider: ctx.key,
            chunks: items.length,
          });
        })
        .catch(async (error: unknown) => {
          await this.recordPrefetchFailure(ctx, state, error);
        });

      state.fileWork.push(work);
      collected.push(work);
    }
    await Promise.all(collected);
  }

  /**
   * Apply a fully-deferred provider's finalize file overlays, keyed by the
   * accumulated chunkMap (relPath → ChunkLookupEntry[]) from ChunkPhase.
   */
  async applyFinalize(
    coll: string,
    ctx: ProviderContext,
    fileOverlays: Map<string, FileSignalOverlay>,
    chunkMap: ReadonlyMap<string, readonly { chunkId: string; startLine: number; endLine: number }[]>,
  ): Promise<void> {
    const state = this.states.get(ctx.key);
    if (!state) return;
    const start = Date.now();
    await this.applier.applyFinalizeFile(
      coll,
      ctx.key,
      fileOverlays,
      chunkMap,
      ctx.provider.fileSignalTransform,
      this.runStartedAt,
    );
    state.streamingApplies++;
    state.prefetchEndTime = Date.now();
    state.prefetchDurationMs += state.prefetchEndTime - start;
  }

  /** No-op: there is no whole-repo prefetch to await anymore. */
  async awaitPrefetch(): Promise<void> {
    return Promise.resolve();
  }

  async drain(): Promise<void> {
    const all = [...this.states.values()].flatMap((s) => s.fileWork);
    if (all.length === 0) return;
    await Promise.allSettled(all);
    for (const s of this.states.values()) s.fileWork.length = 0;
  }

  hasPrefetchFailed(providerKey: string): boolean {
    return this.states.get(providerKey)?.prefetchFailed ?? false;
  }

  getPrefetchDurationMs(providerKey: string): number {
    return this.states.get(providerKey)?.prefetchDurationMs ?? 0;
  }

  getMetrics(): FilePhaseMetrics {
    let max = 0;
    let stream = 0;
    let flush = 0;
    let meta = 0;
    let first: FilePhaseMetrics["firstProvider"] = null;
    let i = 0;
    for (const s of this.states.values()) {
      max = Math.max(max, s.prefetchDurationMs);
      stream += s.streamingApplies;
      flush += s.flushApplies;
      meta += s.fileMetadataCount;
      if (i++ === 0) {
        first = {
          prefetchStartTime: s.prefetchStartTime,
          prefetchEndTime: s.prefetchEndTime,
          pipelineFlushTime: s.pipelineFlushTime,
        };
      }
    }
    return {
      maxPrefetchDurationMs: max,
      totalStreamingApplies: stream,
      totalFlushApplies: flush,
      totalFileMetadataCount: meta,
      firstProvider: first,
    };
  }

  /** Mark a provider's file stream/finalize as failed + persist the marker. */
  private async recordPrefetchFailure(ctx: ProviderContext, state: FilePhaseState, error: unknown): Promise<void> {
    state.prefetchFailed = true;
    state.prefetchEndTime = Date.now();
    const msg = extractErrorMessage(error);
    console.error(`[Enrichment:${ctx.key}] Stream/finalize failed:`, msg);
    pipelineLog.enrichmentPhase("PREFETCH_FAILED", {
      provider: ctx.key,
      error: msg,
      durationMs: state.prefetchDurationMs,
    });
    this.chunkPhase?.markFailed(ctx.key);
    if (this.coll) {
      // Await the marker write so callers observe the failed marker on storage.
      // Propagate the concrete error message so get_index_status surfaces the
      // cause instead of a generic in_progress placeholder.
      await this.markerStore.markPrefetchFailed(
        this.coll,
        ctx.key,
        this.runId,
        this.runStartedAt,
        state.prefetchDurationMs,
        msg,
      );
    }
  }

  private uniqueRelPaths(items: ChunkItem[], root: string): string[] {
    const seen = new Set<string>();
    for (const item of items) {
      seen.add(relative(root, item.chunk.metadata.filePath));
    }
    return [...seen];
  }
}

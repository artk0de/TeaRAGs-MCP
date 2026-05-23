/**
 * FilePhase — provider.buildFileSignals prefetch and per-batch
 * applyFileSignals dispatch. Buffers batches that arrive before prefetch
 * resolves; drains them via prefetch.then(). On prefetch error writes
 * markerStore.markPrefetchFailed and signals chunkPhase.markFailed; on
 * prefetch ready signals chunkPhase.markReady so chunk-side buffered
 * batches drain.
 */

import type { Ignore } from "ignore";

import type { FileSignalOverlay } from "../../../../contracts/types/provider.js";
import { pipelineLog } from "../infra/debug-logger.js";
import type { ChunkItem } from "../types.js";
import type { EnrichmentApplier } from "./applier.js";
import type { ChunkPhase } from "./chunk-phase.js";
import type { EnrichmentMarkerStore } from "./marker-store.js";
import type { ProviderContext } from "./types.js";

interface PendingBatch {
  collectionName: string;
  absolutePath: string;
  items: ChunkItem[];
}

interface FilePhaseState {
  prefetchPromise: Promise<Map<string, FileSignalOverlay>> | null;
  fileMetadata: Map<string, FileSignalOverlay> | null;
  prefetchFailed: boolean;
  pendingBatches: PendingBatch[];
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
    prefetchPromise: null,
    fileMetadata: null,
    prefetchFailed: false,
    pendingBatches: [],
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
   * Bind the ChunkPhase whose readiness lifecycle (markPrefetchPending,
   * markReady, markFailed) FilePhase drives from the prefetch outcome.
   * Optional — ChunkPhase remains drivable directly for unit-level tests.
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

  startPrefetch(changedPaths?: string[]): void {
    for (const ctx of this.contexts.values()) {
      const state = this.states.get(ctx.key);
      if (!state) continue;
      const root = ctx.effectiveRoot;
      if (!root) continue;
      state.prefetchStartTime = Date.now();

      // Hold streaming chunk enrichment until file-side prefetch resolves.
      // markReady (success path) or markFailed (catch path) flips this back.
      this.chunkPhase?.markPrefetchPending(ctx.key);

      pipelineLog.enrichmentPhase("PREFETCH_START", {
        provider: ctx.key,
        path: root,
      });
      state.prefetchPromise = ctx.provider
        .buildFileSignals(root, {
          paths: changedPaths && changedPaths.length > 0 ? changedPaths : undefined,
          // Coordinator threads the active Qdrant collection name in
          // through `init(coll, ...)`. Providers that don't care
          // (git) ignore it; codegraph routes per-collection DuckDB
          // writes on it.
          collectionName: this.coll || undefined,
          // FileScanner ignore filter (BUILTIN_IGNORE_PATTERNS +
          // user .gitignore / .contextignore). Providers that walk
          // the file tree themselves (codegraph) honour it so their
          // file set matches what Qdrant indexed. Providers that
          // don't walk (git) ignore it. Null is normal when the
          // pipeline didn't load a filter for this run.
          ignoreFilter: ctx.ignoreFilter ?? undefined,
        })
        .then((result) => {
          state.prefetchEndTime = Date.now();
          state.prefetchDurationMs = state.prefetchEndTime - state.prefetchStartTime;
          const filtered = this.filterByIgnore(result, ctx.ignoreFilter);
          state.fileMetadata = filtered;
          state.fileMetadataCount = filtered.size;
          pipelineLog.enrichmentPhase("PREFETCH_COMPLETE", {
            provider: ctx.key,
            filesInLog: result.size,
            durationMs: state.prefetchDurationMs,
          });
          pipelineLog.addStageTime("enrichment_prefetch", state.prefetchDurationMs);
          this.flushPending(ctx, state);
          this.chunkPhase?.markReady(ctx.key);
          return result;
        })
        .catch(async (error: unknown) => {
          state.prefetchFailed = true;
          state.prefetchEndTime = Date.now();
          state.prefetchDurationMs = state.prefetchEndTime - state.prefetchStartTime;
          const msg = extractErrorMessage(error);
          console.error(`[Enrichment:${ctx.key}] Prefetch failed:`, msg);
          pipelineLog.enrichmentPhase("PREFETCH_FAILED", {
            provider: ctx.key,
            error: msg,
            durationMs: state.prefetchDurationMs,
          });
          state.pendingBatches = [];
          this.chunkPhase?.markFailed(ctx.key);
          if (this.coll) {
            // Await the marker write so awaitPrefetch() callers observe the
            // failed marker on storage. Internal write swallows its own errors.
            // Propagate the concrete error message so get_index_status
            // surfaces "Codegraph spill write failed at …" instead of
            // a generic in_progress placeholder.
            await this.markerStore.markPrefetchFailed(
              this.coll,
              ctx.key,
              this.runId,
              this.runStartedAt,
              state.prefetchDurationMs,
              msg,
            );
          }
          return new Map();
        });
    }
  }

  onBatch(coll: string, absolutePath: string, items: ChunkItem[]): void {
    for (const ctx of this.contexts.values()) {
      const state = this.states.get(ctx.key);
      if (!state) continue;
      // pipelineFlushTime tracks when chunks first land relative to prefetch —
      // mirrors original coordinator behavior of recording even on failed providers.
      state.pipelineFlushTime = Date.now();
      if (state.prefetchFailed) continue;

      if (state.fileMetadata) {
        const pathBase = ctx.effectiveRoot ?? absolutePath;
        const work = this.applier.applyFileSignals(
          coll,
          ctx.key,
          state.fileMetadata,
          pathBase,
          items,
          ctx.provider.fileSignalTransform,
          this.runStartedAt,
        );
        state.fileWork.push(work);
        state.streamingApplies++;
        pipelineLog.enrichmentPhase("STREAMING_APPLY", {
          provider: ctx.key,
          chunks: items.length,
        });
      } else {
        state.pendingBatches.push({
          collectionName: coll,
          absolutePath,
          items,
        });
      }
    }
  }

  async awaitPrefetch(): Promise<void> {
    const promises = [...this.states.values()]
      .map(async (s) => s.prefetchPromise)
      .filter((p): p is Promise<Map<string, FileSignalOverlay>> => p !== null);
    if (promises.length > 0) await Promise.allSettled(promises);
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

  private flushPending(ctx: ProviderContext, state: FilePhaseState): void {
    if (state.pendingBatches.length === 0) return;
    const batches = state.pendingBatches;
    state.pendingBatches = [];
    pipelineLog.enrichmentPhase("FLUSH_APPLY", {
      provider: ctx.key,
      batches: batches.length,
      chunks: batches.reduce((sum, b) => sum + b.items.length, 0),
    });
    for (const batch of batches) {
      if (!state.fileMetadata) continue;
      const pathBase = ctx.effectiveRoot ?? batch.absolutePath;
      const work = this.applier.applyFileSignals(
        batch.collectionName,
        ctx.key,
        state.fileMetadata,
        pathBase,
        batch.items,
        ctx.provider.fileSignalTransform,
        this.runStartedAt,
      );
      state.fileWork.push(work);
      state.flushApplies++;
    }
  }

  private filterByIgnore(
    input: Map<string, FileSignalOverlay>,
    ignoreFilter: Ignore | null,
  ): Map<string, FileSignalOverlay> {
    if (!ignoreFilter) return input;
    const out = new Map<string, FileSignalOverlay>();
    let filtered = 0;
    for (const [path, value] of input) {
      // Original coordinator's filterByIgnore was invoked without `root`, so
      // map keys (repo-relative paths from the provider) were passed straight
      // to ignoreFilter.ignores(). Preserve that behavior here.
      if (ignoreFilter.ignores(path)) {
        filtered++;
      } else {
        out.set(path, value);
      }
    }
    if (filtered > 0) {
      pipelineLog.enrichmentPhase("PREFETCH_FILTERED", {
        filtered,
        remainingFiles: out.size,
      });
    }
    return out;
  }
}

/**
 * ChunkPhase — streaming, deferred, and post-flush chunk-signal enrichment.
 *
 * Owns Semaphore(10) shared across both entry points so total git-blame
 * parallelism stays bounded. Streaming records files in
 * streamingEnrichedFiles; enrichRemaining consults that set to skip files
 * already enriched.
 *
 * Two provider classes:
 * - Streaming (git): onBatch dispatches buildChunkSignals immediately.
 * - Fully-deferred (codegraph, `defersChunkEnrichment === true`): onBatch only
 *   accumulates the batch's chunkMap into deferredChunkMap; CompletionRunner
 *   drives a single runDeferredChunk pass after the graph is finalized.
 */

import type { EnrichmentExecutor } from "../../../../contracts/types/enrichment-executor.js";
import type { ChunkSignalOverlay } from "../../../../contracts/types/provider.js";
import { Semaphore } from "../../../../infra/semaphore.js";
import type { ChunkLookupEntry } from "../../../../types.js";
import { pipelineLog } from "../infra/debug-logger.js";
import type { ChunkItem } from "../types.js";
import type { EnrichmentApplier } from "./applier.js";
import type { ProviderContext } from "./types.js";

const CHUNK_ENRICHMENT_CONCURRENCY = 10;

interface ChunkPhaseState {
  readonly streamingEnrichedFiles: Set<string>;
  readonly chunkWork: Promise<void>[];
  /**
   * Accumulated full chunkMap for a fully-deferred provider
   * (`defersChunkEnrichment === true`). onBatch appends each batch here instead
   * of dispatching; runDeferredChunk consumes it once the graph is finalized.
   */
  readonly deferredChunkMap: Map<string, ChunkLookupEntry[]>;
  /**
   * True once the provider's file-side stream/finalize errored. Stops streaming
   * and post-flush dispatch — matches the original `if (state.prefetchFailed)
   * continue;` short-circuit. Set by FilePhase via markFailed.
   */
  prefetchFailed: boolean;
  /**
   * Wall-clock start of the first apply in this run (ms since epoch). 0 = no
   * applies have started yet. Set once on the first apply-start; never
   * overwritten so concurrent batches don't shift the origin.
   */
  chunkFirstStartAt: number;
  /**
   * Wall-clock end of the most recently completed apply (ms since epoch). 0 =
   * no applies have completed yet. Updated on every apply-completion
   * (success or error) so the wall-clock span always reflects the last settled
   * batch.
   */
  chunkLastEndAt: number;
  chunkEnrichmentFailed: boolean;
  chunkEnrichmentInvoked: boolean;
}

function createState(): ChunkPhaseState {
  return {
    streamingEnrichedFiles: new Set(),
    chunkWork: [],
    deferredChunkMap: new Map(),
    prefetchFailed: false,
    chunkFirstStartAt: 0,
    chunkLastEndAt: 0,
    chunkEnrichmentFailed: false,
    chunkEnrichmentInvoked: false,
  };
}

export interface ChunkPhaseMetrics {
  totalChunkEnrichmentDurationMs: number;
}

export class ChunkPhase {
  private readonly states = new Map<string, ChunkPhaseState>();
  private readonly semaphore = new Semaphore(CHUNK_ENRICHMENT_CONCURRENCY);
  private contexts: Map<string, ProviderContext> = new Map();
  private runStartedAt = "";
  private onComplete?: (coll: string) => Promise<void>;

  constructor(
    private readonly applier: EnrichmentApplier,
    private readonly executor: EnrichmentExecutor,
  ) {}

  init(contexts: ReadonlyMap<string, ProviderContext>, _coll: string, runStartedAt: string): void {
    this.contexts = new Map(contexts);
    this.runStartedAt = runStartedAt;
    this.states.clear();
    for (const key of contexts.keys()) this.states.set(key, createState());
  }

  setOnComplete(cb: (coll: string) => Promise<void>): void {
    this.onComplete = cb;
  }

  /**
   * Manually invoke the bound onComplete callback. Used by CompletionRunner to
   * fire a second stats-refresh after backfill writes file-level overlays.
   * No-op if no callback is bound. Errors are caught and logged with the same
   * semantics as the streaming-end fire site.
   */
  async fireOnComplete(coll: string): Promise<void> {
    const cb = this.onComplete;
    if (!cb) return;
    try {
      await cb(coll);
    } catch (error) {
      console.error("[Enrichment] onChunkEnrichmentComplete (post-backfill) callback failed:", error);
    }
  }

  /**
   * Mark a provider as permanently failed. Suppresses streaming + post-flush +
   * deferred dispatch — matches old prefetchFailed semantics that stopped
   * chunk enrichment when the file-side stream/finalize errored.
   */
  markFailed(providerKey: string): void {
    const state = this.states.get(providerKey);
    if (!state) return;
    state.prefetchFailed = true;
  }

  /**
   * Streaming entry — fire-and-forget across ALL providers. Retained for
   * unit-level callers that drive every provider at once; the coordinator now
   * drives providers individually via onBatchProvider so each provider's chunk
   * work gates only on its own file work.
   */
  onBatch(coll: string, absolutePath: string, items: ChunkItem[]): void {
    for (const ctx of this.contexts.values()) {
      this.onBatchProvider(ctx.key, coll, absolutePath, items);
    }
  }

  /**
   * Streaming entry for a SINGLE provider — fire-and-forget. The coordinator
   * calls this once per provider, each gated on that provider's own file-work
   * promise, so git chunk never waits on codegraph file extraction (wy5i).
   * Unknown / unregistered keys are a benign no-op.
   */
  onBatchProvider(providerKey: string, coll: string, absolutePath: string, items: ChunkItem[]): void {
    const ctx = this.contexts.get(providerKey);
    if (!ctx) return;
    const state = this.states.get(providerKey);
    if (!state) return;
    // Suppress dispatch when the file-side stream/finalize already failed —
    // FilePhase calls markFailed before this (sequenced after fileDone).
    if (state.prefetchFailed) return;
    const root = ctx.effectiveRoot ?? absolutePath;
    const map = this.extractBatchChunkMap(items, root);
    if (ctx.provider.defersChunkEnrichment) {
      // Fully-deferred provider (codegraph): accumulate the batch's chunkMap;
      // chunk signals are produced by a single runDeferredChunk pass after the
      // graph is finalized. Do NOT dispatch buildChunkSignals here, and do NOT
      // mark these files as streaming-enriched.
      for (const [rel, entries] of map) {
        const existing = state.deferredChunkMap.get(rel) ?? [];
        existing.push(...entries);
        state.deferredChunkMap.set(rel, existing);
      }
      return;
    }
    void this.runChunkSignals(ctx, state, coll, root, map, /* useSemaphore */ true);
  }

  /** Post-flush catch-up entry — applied to files NOT covered by streaming. */
  enrichRemaining(coll: string, absolutePath: string, chunkMap: Map<string, ChunkLookupEntry[]>): void {
    const providerPromises: Promise<boolean>[] = [];

    for (const ctx of this.contexts.values()) {
      const state = this.states.get(ctx.key);
      if (!state) continue;
      // Skip providers whose file-side stream/finalize failed — matches the
      // original `if (state.prefetchFailed) continue;` short-circuit.
      if (state.prefetchFailed) continue;
      // Fully-deferred providers (codegraph) have their chunk signals produced by
      // the deferred pass; the catch-up path doesn't apply to them.
      if (ctx.provider.defersChunkEnrichment) continue;
      state.chunkEnrichmentInvoked = true;

      const root = ctx.effectiveRoot ?? absolutePath;
      const filtered = this.filterByIgnore(chunkMap, ctx.ignoreFilter, root);
      const remaining = new Map<string, ChunkLookupEntry[]>();
      for (const [filePath, entries] of filtered) {
        const rel = filePath.startsWith(root) ? filePath.slice(root.length + 1) : filePath;
        if (!state.streamingEnrichedFiles.has(rel)) {
          remaining.set(filePath, entries);
        }
      }
      if (remaining.size === 0) {
        pipelineLog.enrichmentPhase("CHUNK_ENRICHMENT_SKIPPED", {
          provider: ctx.key,
          reason: "all files enriched via streaming",
          streamingEnrichedFiles: state.streamingEnrichedFiles.size,
        });
        providerPromises.push(Promise.resolve(true));
        continue;
      }

      pipelineLog.enrichmentPhase("CHUNK_ENRICHMENT_START", {
        provider: ctx.key,
        files: remaining.size,
        streamingEnrichedFiles: state.streamingEnrichedFiles.size,
      });

      providerPromises.push(this.runChunkSignals(ctx, state, coll, root, remaining, /* useSemaphore */ false));
    }

    if (providerPromises.length > 0 && this.onComplete) {
      const cb = this.onComplete;
      // Wait for both post-flush providerPromises AND streaming chunkWork in
      // flight. When remaining.size === 0 for all providers (full reindex —
      // streaming covered every file), providerPromises = [Promise.resolve(true)]
      // settles instantly; without this, the callback fires while streaming
      // Qdrant writes are still pending and the bound refreshStatsByCollection
      // caches partial stats.
      const streamingInFlight = [...this.states.values()].flatMap((s) => s.chunkWork);
      void Promise.allSettled([...providerPromises, ...streamingInFlight]).then(async (results) => {
        // The "any succeeded" check applies to providerPromises only —
        // streaming chunkWork resolves to void, not boolean.
        const providerResults = results.slice(0, providerPromises.length);
        if (!providerResults.some((r) => r.status === "fulfilled" && r.value === true)) {
          return;
        }
        try {
          await cb(coll);
        } catch (error) {
          console.error("[Enrichment] onChunkEnrichmentComplete callback failed:", error);
        }
      });
    }
  }

  /** Accumulated deferred chunkMap for a provider (empty map if none / streaming). */
  getDeferredChunkMap(providerKey: string): Map<string, ChunkLookupEntry[]> {
    return this.states.get(providerKey)?.deferredChunkMap ?? new Map<string, ChunkLookupEntry[]>();
  }

  /**
   * Single deferred chunk-signal pass for a fully-deferred provider (codegraph).
   * Runs buildChunkSignals against the now-finalized graph with the full
   * accumulated chunkMap, then applies the overlays. Driven by CompletionRunner
   * after the finalize file pass and the streaming chunk drain.
   *
   * WHY deferred (cannot overlap embedding): codegraph chunk signals
   * (fanIn/fanOut/pageRank) resolve CROSS-FILE call edges, which requires the
   * COMPLETE symbol graph — a call to a symbol defined in a not-yet-extracted
   * file cannot be resolved mid-stream. Edge extraction DOES overlap embedding
   * (provider.streamFileBatch writes nodes/edges per batch); only the resolve +
   * PageRank pass is deferred to finalize. This is the intended two-phase
   * design, not a serialization bug.
   *
   * Ordering note: this pass runs AFTER the streaming chunk drain (git churn).
   * With git chunk enrichment pinned per-collection (collection-affinity) the
   * drain is fast, so the serialization cost is small. FUTURE optimization
   * (tracked separately): an incremental codegraph chunk resolve that streams
   * resolved edges as the graph grows would let part of this overlap embedding.
   */
  async runDeferredChunk(
    coll: string,
    ctx: ProviderContext,
    root: string,
    chunkMap: Map<string, ChunkLookupEntry[]>,
  ): Promise<void> {
    const state = this.states.get(ctx.key);
    if (!state) return;
    if (chunkMap.size === 0) {
      state.deferredChunkMap.clear();
      return;
    }

    const allChunkIds = new Set<string>();
    for (const entries of chunkMap.values()) {
      for (const e of entries) allChunkIds.add(e.chunkId);
    }

    if (state.chunkFirstStartAt === 0) state.chunkFirstStartAt = Date.now();
    try {
      const overlays = await this.executor.runChunkBatch(ctx.provider, root, chunkMap, {
        collectionName: coll,
        skipCache: true,
      });
      const applied = await this.applier.applyChunkSignals(coll, ctx.key, overlays, this.runStartedAt, allChunkIds);
      state.chunkLastEndAt = Date.now();
      pipelineLog.enrichmentPhase("STREAMING_CHUNK_ENRICHMENT_COMPLETE", {
        provider: ctx.key,
        phase: "DEFERRED",
        files: chunkMap.size,
        overlaysApplied: applied,
      });
    } catch (error) {
      state.chunkLastEndAt = Date.now();
      state.chunkEnrichmentFailed = true;
      pipelineLog.enrichmentPhase("STREAMING_CHUNK_ENRICHMENT_FAILED", {
        provider: ctx.key,
        phase: "DEFERRED",
        error: error instanceof Error ? error.message : String(error),
      });
    } finally {
      state.deferredChunkMap.clear();
    }
  }

  /**
   * Await all in-flight streaming chunk-work promises.
   *
   * `onApplyProgress` — called once per settled chunkWork promise (i.e. per
   * completed streaming apply cycle). This fires DURING the drain — not after
   * it resolves — giving the coordinator a per-apply heartbeat seam during the
   * git chunk churn window (which can span hundreds of promises over 500-1000s
   * on large repos). The caller owns throttling (e.g. `maybeHeartbeat` with its
   * 30s gate); the callback is invoked unconditionally on each settle so the
   * throttle logic lives in one place (DRY).
   */
  async drain(onApplyProgress?: () => void): Promise<void> {
    const all = [...this.states.values()].flatMap((s) => s.chunkWork);
    if (all.length === 0) return;
    if (onApplyProgress) {
      await Promise.allSettled(
        all.map(async (p) => {
          try {
            await p;
          } finally {
            onApplyProgress();
          }
        }),
      );
    } else {
      await Promise.allSettled(all);
    }
    for (const state of this.states.values()) state.chunkWork.length = 0;
  }

  hasChunkEnrichmentFailed(providerKey: string): boolean {
    return this.states.get(providerKey)?.chunkEnrichmentFailed ?? false;
  }

  getMetrics(): ChunkPhaseMetrics {
    let firstStartAt = 0;
    let lastEndAt = 0;
    for (const s of this.states.values()) {
      if (s.chunkFirstStartAt > 0 && (firstStartAt === 0 || s.chunkFirstStartAt < firstStartAt)) {
        firstStartAt = s.chunkFirstStartAt;
      }
      if (s.chunkLastEndAt > lastEndAt) lastEndAt = s.chunkLastEndAt;
    }
    const total = firstStartAt > 0 && lastEndAt > 0 ? lastEndAt - firstStartAt : 0;
    return { totalChunkEnrichmentDurationMs: total };
  }

  /** Single skeleton: build chunk signals, apply, log, track work. */
  private async runChunkSignals(
    ctx: ProviderContext,
    state: ChunkPhaseState,
    coll: string,
    root: string,
    chunkMap: Map<string, ChunkLookupEntry[]>,
    useSemaphore: boolean,
  ): Promise<boolean> {
    if (chunkMap.size === 0) return Promise.resolve(true);

    if (useSemaphore) {
      // Mark files as streaming-enriched BEFORE the async work to avoid races
      // with enrichRemaining.
      for (const relPath of chunkMap.keys()) {
        state.streamingEnrichedFiles.add(relPath);
      }
    }

    const allChunkIds = new Set<string>();
    for (const entries of chunkMap.values()) {
      for (const e of entries) allChunkIds.add(e.chunkId);
    }

    // Record wall-clock start: set once on the FIRST apply of this run so
    // concurrent batches don't overwrite the origin timestamp.
    const dispatchAt = Date.now();
    if (state.chunkFirstStartAt === 0) state.chunkFirstStartAt = dispatchAt;

    // Carry the active collection on every chunk-signal call so codegraph
    // routes per-collection DuckDB lookups correctly. `coll` is the
    // ChunkPhase's bound collection name from `init`.
    const opts = useSemaphore
      ? { concurrencySemaphore: this.semaphore, skipCache: true, collectionName: coll }
      : { skipCache: true, collectionName: coll };

    const work = this.executor
      .runChunkBatch(ctx.provider, root, chunkMap, opts)
      .then(async (overlays: Map<string, Map<string, ChunkSignalOverlay>>) => {
        const applied = await this.applier.applyChunkSignals(coll, ctx.key, overlays, this.runStartedAt, allChunkIds);
        state.chunkLastEndAt = Date.now();
        pipelineLog.enrichmentPhase(
          useSemaphore ? "STREAMING_CHUNK_ENRICHMENT_COMPLETE" : "CHUNK_ENRICHMENT_COMPLETE",
          { provider: ctx.key, files: chunkMap.size, overlaysApplied: applied },
        );
        return true;
      })
      .catch((error: unknown) => {
        state.chunkLastEndAt = Date.now();
        if (!useSemaphore) state.chunkEnrichmentFailed = true;
        pipelineLog.enrichmentPhase(useSemaphore ? "STREAMING_CHUNK_ENRICHMENT_FAILED" : "CHUNK_ENRICHMENT_FAILED", {
          provider: ctx.key,
          error: error instanceof Error ? error.message : String(error),
        });
        return false;
      });

    state.chunkWork.push(work.then(() => undefined));
    return work;
  }

  private extractBatchChunkMap(items: ChunkItem[], pathBase: string): Map<string, ChunkLookupEntry[]> {
    const map = new Map<string, ChunkLookupEntry[]>();
    for (const item of items) {
      const fp = item.chunk.metadata.filePath;
      const rel = fp.startsWith(pathBase) ? fp.slice(pathBase.length + 1) : fp;
      const arr = map.get(rel) ?? [];
      arr.push({
        chunkId: item.chunkId,
        startLine: item.chunk.startLine,
        endLine: item.chunk.endLine,
      });
      map.set(rel, arr);
    }
    return map;
  }

  private filterByIgnore(
    map: Map<string, ChunkLookupEntry[]>,
    ignoreFilter: ProviderContext["ignoreFilter"],
    root: string,
  ): Map<string, ChunkLookupEntry[]> {
    if (!ignoreFilter) return map;
    const out = new Map<string, ChunkLookupEntry[]>();
    for (const [filePath, entries] of map) {
      const rel = filePath.startsWith(root) ? filePath.slice(root.length + 1) : filePath;
      if (!ignoreFilter.ignores(rel)) out.set(filePath, entries);
    }
    return out;
  }
}

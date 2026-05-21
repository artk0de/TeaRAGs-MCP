/**
 * ChunkPhase — streaming and post-flush chunk-signal enrichment.
 *
 * Owns Semaphore(10) shared across both entry points so total git-blame
 * parallelism stays bounded. Streaming records files in
 * streamingEnrichedFiles; enrichRemaining consults that set to skip files
 * already enriched.
 */

import type { ChunkSignalOverlay } from "../../../../contracts/types/provider.js";
import { Semaphore } from "../../../../infra/semaphore.js";
import type { ChunkLookupEntry } from "../../../../types.js";
import { pipelineLog } from "../infra/debug-logger.js";
import type { ChunkItem } from "../types.js";
import type { EnrichmentApplier } from "./applier.js";
import type { ProviderContext } from "./types.js";

const CHUNK_ENRICHMENT_CONCURRENCY = 10;

interface PendingBatch {
  coll: string;
  absolutePath: string;
  items: ChunkItem[];
}

interface ChunkPhaseState {
  readonly streamingEnrichedFiles: Set<string>;
  readonly chunkWork: Promise<void>[];
  /** Batches received before provider was marked ready. Drained on markReady. */
  readonly pendingBatches: PendingBatch[];
  /**
   * True once the provider is cleared to run streaming chunk enrichment.
   * Set via markReady() after coordinator's prefetch resolves successfully.
   * When false, onBatch queues into pendingBatches; markFailed() drops them.
   */
  ready: boolean;
  /**
   * True once the provider's file-side prefetch errored. Stops streaming and
   * post-flush dispatch — matches the original `if (state.prefetchFailed)
   * continue;` short-circuit.
   */
  prefetchFailed: boolean;
  chunkEnrichmentDurationMs: number;
  chunkEnrichmentFailed: boolean;
  chunkEnrichmentInvoked: boolean;
}

function createState(): ChunkPhaseState {
  return {
    streamingEnrichedFiles: new Set(),
    chunkWork: [],
    pendingBatches: [],
    // Default to ready so unit-level callers can drive ChunkPhase without
    // mocking a full prefetch lifecycle. Coordinator flips to false via
    // markPrefetchPending() before kicking off provider.buildFileSignals.
    ready: true,
    prefetchFailed: false,
    chunkEnrichmentDurationMs: 0,
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

  constructor(private readonly applier: EnrichmentApplier) {}

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
   * Mark a provider's prefetch as in-flight — onBatch will queue instead of
   * dispatch until markReady() resolves the lifecycle.
   */
  markPrefetchPending(providerKey: string): void {
    const state = this.states.get(providerKey);
    if (state) state.ready = false;
  }

  /**
   * Mark a provider as ready to dispatch streaming work. Drains any batches
   * received before this point (when prefetch was still in flight).
   */
  markReady(providerKey: string): void {
    const state = this.states.get(providerKey);
    if (!state || state.ready) return;
    state.ready = true;
    const ctx = this.contexts.get(providerKey);
    if (!ctx) return;
    const drained = state.pendingBatches.splice(0);
    for (const batch of drained) {
      const root = ctx.effectiveRoot ?? batch.absolutePath;
      const map = this.extractBatchChunkMap(batch.items, root);
      void this.runChunkSignals(ctx, state, batch.coll, root, map, /* useSemaphore */ true);
    }
  }

  /**
   * Mark a provider as permanently failed. Drops queued batches without
   * dispatching them — matches old prefetchFailed semantics that suppressed
   * streaming chunk enrichment when the file-side prefetch errored.
   */
  markFailed(providerKey: string): void {
    const state = this.states.get(providerKey);
    if (!state) return;
    state.ready = false;
    state.prefetchFailed = true;
    state.pendingBatches.length = 0;
  }

  /** Streaming entry — fire-and-forget per provider. */
  onBatch(coll: string, absolutePath: string, items: ChunkItem[]): void {
    for (const ctx of this.contexts.values()) {
      const state = this.states.get(ctx.key);
      if (!state) continue;
      if (!state.ready) {
        state.pendingBatches.push({ coll, absolutePath, items });
        continue;
      }
      const root = ctx.effectiveRoot ?? absolutePath;
      const map = this.extractBatchChunkMap(items, root);
      void this.runChunkSignals(ctx, state, coll, root, map, /* useSemaphore */ true);
    }
  }

  /** Post-flush catch-up entry — applied to files NOT covered by streaming. */
  enrichRemaining(coll: string, absolutePath: string, chunkMap: Map<string, ChunkLookupEntry[]>): void {
    const providerPromises: Promise<boolean>[] = [];

    for (const ctx of this.contexts.values()) {
      const state = this.states.get(ctx.key);
      if (!state) continue;
      // Skip providers whose file-side prefetch failed — matches the original
      // coordinator's `if (state.prefetchFailed) continue;` short-circuit.
      // Pending prefetch is OK: post-flush catch-up doesn't depend on file
      // metadata, and the original code dispatched even before prefetch resolved.
      if (state.prefetchFailed) continue;
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

  async drain(): Promise<void> {
    const all = [...this.states.values()].flatMap((s) => s.chunkWork);
    if (all.length === 0) return;
    await Promise.allSettled(all);
    for (const state of this.states.values()) state.chunkWork.length = 0;
  }

  hasChunkEnrichmentFailed(providerKey: string): boolean {
    return this.states.get(providerKey)?.chunkEnrichmentFailed ?? false;
  }

  getMetrics(): ChunkPhaseMetrics {
    let total = 0;
    for (const s of this.states.values()) total += s.chunkEnrichmentDurationMs;
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

    const start = Date.now();
    // Carry the active collection on every chunk-signal call so codegraph
    // routes per-collection DuckDB lookups correctly. `coll` is the
    // ChunkPhase's bound collection name from `init`.
    const opts = useSemaphore
      ? { concurrencySemaphore: this.semaphore, skipCache: true, collectionName: coll }
      : { skipCache: true, collectionName: coll };

    const work = ctx.provider
      .buildChunkSignals(root, chunkMap, opts)
      .then(async (overlays: Map<string, Map<string, ChunkSignalOverlay>>) => {
        const applied = await this.applier.applyChunkSignals(coll, ctx.key, overlays, this.runStartedAt, allChunkIds);
        state.chunkEnrichmentDurationMs += Date.now() - start;
        pipelineLog.enrichmentPhase(
          useSemaphore ? "STREAMING_CHUNK_ENRICHMENT_COMPLETE" : "CHUNK_ENRICHMENT_COMPLETE",
          { provider: ctx.key, files: chunkMap.size, overlaysApplied: applied },
        );
        return true;
      })
      .catch((error: unknown) => {
        state.chunkEnrichmentDurationMs += Date.now() - start;
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

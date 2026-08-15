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

import type { EnrichmentExecutor } from "../../../../contracts/types/enrichment-executor.js";
import type { FileSignalOverlay } from "../../../../contracts/types/provider.js";
import { pipelineLog } from "../infra/debug-logger.js";
import type { ChunkItem } from "../types.js";
import type { EnrichmentApplier } from "./applier.js";
import type { ChunkPhase } from "./chunk-phase.js";
import type { EnrichmentMarkerStore } from "./marker-store.js";
import { enrichmentScope, enrichmentSkipReason, type EnrichmentSkipReason } from "./policy.js";
import type { ProviderContext } from "./types.js";

interface FilePhaseState {
  prefetchFailed: boolean;
  /** Cause of the prefetch failure — carried into the terminal marker (2nfdm). */
  prefetchError?: string;
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
  private crossPass = false;
  /** Per-file SHA256 for the run — stamped onto provider rows (bd tea-rags-mcp-6goqa). */
  private contentHashes?: ReadonlyMap<string, string>;
  private chunkPhase: ChunkPhase | null = null;

  constructor(
    private readonly applier: EnrichmentApplier,
    private readonly markerStore: EnrichmentMarkerStore,
    private readonly executor: EnrichmentExecutor,
  ) {}

  /**
   * Bind the ChunkPhase that FilePhase signals on a stream/finalize failure
   * (chunkPhase.markFailed) so ChunkPhase skips the failed provider. Optional —
   * ChunkPhase remains drivable directly for unit-level tests.
   */
  bindChunkPhase(chunkPhase: ChunkPhase): void {
    this.chunkPhase = chunkPhase;
  }

  init(
    contexts: ReadonlyMap<string, ProviderContext>,
    coll: string,
    runId: string,
    runStartedAt: string,
    crossPass = false,
    contentHashes?: ReadonlyMap<string, string>,
  ): void {
    this.contexts = new Map(contexts);
    this.coll = coll;
    this.runId = runId;
    this.runStartedAt = runStartedAt;
    this.crossPass = crossPass;
    this.contentHashes = contentHashes;
    this.states.clear();
    for (const key of contexts.keys()) this.states.set(key, createState());
  }

  /**
   * yl9tv Task 5b — whether this run feeds codegraph via the cross-pass input
   * spill. `CompletionRunner` reads it to thread `crossPass` into the finalize
   * `FileSignalOptions` (so the worker drains the spill instead of re-parsing).
   */
  get crossPassEnabled(): boolean {
    return this.crossPass;
  }

  /**
   * The run's per-file SHA256, for `CompletionRunner` to thread into the
   * finalize dispatch (bd tea-rags-mcp-o317j).
   *
   * Finalize is where the codegraph rows are actually written — pass-2 stamps
   * each one from the provider's run state — so it is the ONE dispatch that
   * every ingest path shares. The per-batch attach below cannot cover the
   * cross-pass run: there the batch call no-ops on a worker instance and
   * extraction is deferred to finalize.
   */
  get runContentHashes(): ReadonlyMap<string, string> | undefined {
    return this.contentHashes;
  }

  /**
   * Stream this batch's file signals and apply immediately. Returns a map
   * keyed by provider whose values are that provider's file-work promise for
   * this batch — so the coordinator can gate EACH provider's chunk enrichment
   * on ONLY that same provider's file work, never on another provider's.
   *
   * Previously this awaited Promise.all across all providers, which coupled
   * git's per-batch chunk dispatch to codegraph's per-batch file extraction:
   * a cold codegraph build (serialized DuckDB writes) starved git chunk. The
   * per-provider map decouples them — git.file→git.chunk and
   * codegraph.file→codegraph.chunk proceed concurrently.
   *
   * Fully-deferred providers (codegraph) still DRIVE streamFileBatch here (the
   * run sink extracts into the graph during embedding overlap) but do NOT
   * apply the (empty) result and do NOT miss-track — file overlays are read
   * back once the graph is finalized via finalizeSignals → applyFinalize.
   */
  onBatch(coll: string, absolutePath: string, items: ChunkItem[]): Map<string, Promise<void>> {
    const perProvider = new Map<string, Promise<void>>();
    for (const ctx of this.contexts.values()) {
      const state = this.states.get(ctx.key);
      if (!state) continue;
      // pipelineFlushTime tracks when chunks first land — best-effort overlap
      // metric. Recorded even for failed providers (mirrors original).
      state.pipelineFlushTime = Date.now();
      if (state.prefetchStartTime === 0) state.prefetchStartTime = state.pipelineFlushTime;
      if (state.prefetchFailed) continue;

      const root = ctx.effectiveRoot ?? absolutePath;
      // Settle the batch's file-level declines before anything can return early
      // — every path below drops them silently, and a point that ends the run
      // carrying neither terminal marker is a recovery candidate for the NEXT
      // run (bd tea-rags-mcp-okra9).
      const stampWork = this.stampDeclinedFiles(coll, ctx, items, root);
      if (stampWork) state.fileWork.push(stampWork);

      const enrichPaths = this.enrichablePaths(ctx, items, root);
      if (enrichPaths.length === 0) {
        // Nothing to enrich, but the provider still belongs in the gate map:
        // the coordinator drives ChunkPhase off it, and ChunkPhase has to see
        // this batch to write its own chunk-level stamps. Dropping the provider
        // here left an all-declined batch (a run of `spec/` under a provider
        // that excludes tests) unstamped at chunk level.
        perProvider.set(ctx.key, stampWork ?? Promise.resolve());
        continue;
      }

      const work = ctx.provider.defersChunkEnrichment
        ? this.startDeferredExtraction(ctx, state, root, enrichPaths)
        : this.startStreamingApply(coll, ctx, state, root, items, enrichPaths);
      // Undefined only on the defer-without-streamFileBatch skip — that
      // provider contributes neither file work nor a gate entry.
      if (!work) continue;

      state.fileWork.push(work);
      perProvider.set(ctx.key, work);
    }
    return perProvider;
  }

  /**
   * Per-file enrichment policy: the batch's distinct relative paths minus the
   * ones this provider declines entirely ("none"). "file-only" still enriches
   * file-level here — only chunk-phase skips those. Providers without
   * shouldEnrich get "full" (no-op filter).
   */
  private enrichablePaths(ctx: ProviderContext, items: ChunkItem[], root: string): string[] {
    return this.uniqueRelPaths(items, root).filter((rel) => enrichmentScope(ctx.provider, rel) !== "none");
  }

  /**
   * Fully-deferred providers (codegraph): still DRIVE streamFileBatch so the run
   * sink extracts the batch into the graph during embedding overlap, but do NOT
   * apply the (empty) result and do NOT miss-track — file overlays are read back
   * once the graph is finalized via finalizeSignals → applyFinalize. Skipping the
   * call entirely would leave the graph empty (degraded file signals + zero chunk
   * signals).
   *
   * @returns the extraction promise, or undefined when the provider has no
   *   streamFileBatch — the executor would otherwise transparently fall back to
   *   buildFileSignals({ paths }), which is wrong for defer providers: they want
   *   the extraction side-effects of streamFileBatch, not a pure whole-set read.
   */
  private startDeferredExtraction(
    ctx: ProviderContext,
    state: FilePhaseState,
    root: string,
    enrichPaths: string[],
  ): Promise<void> | undefined {
    if (!ctx.provider.streamFileBatch) return undefined;
    return this.executor
      .runFileBatch(ctx.provider, root, enrichPaths, {
        collectionName: this.coll || undefined,
        ignoreFilter: ctx.ignoreFilter ?? undefined,
        // yl9tv Task 5b — on a cross-pass run the worker no-ops this parse
        // (the input spill is fed from the chunker's single parse); finalize
        // drains the spill. Off cross-pass it keeps the extractOneFile path.
        crossPass: this.crossPass,
        // Off cross-pass THIS call is what extracts the batch, so it carries the
        // hashes the provider stamps at write time. On a cross-pass run it is a
        // no-op the worker returns from immediately, and the map — one entry per
        // file in the repository — would be structured-cloned into every one of
        // those round trips for nothing; the finalize dispatch carries it once
        // instead (bd tea-rags-mcp-o317j).
        contentHashes: this.crossPass ? undefined : this.contentHashes,
      })
      .then(() => undefined)
      .catch(async (error: unknown) => {
        await this.recordPrefetchFailure(ctx, state, error);
      });
  }

  /** Stream this batch's file signals for a non-deferring provider and apply them. */
  private async startStreamingApply(
    coll: string,
    ctx: ProviderContext,
    state: FilePhaseState,
    root: string,
    items: ChunkItem[],
    enrichPaths: string[],
  ): Promise<void> {
    return this.executor
      .runFileBatch(ctx.provider, root, enrichPaths, {
        collectionName: this.coll || undefined,
        ignoreFilter: ctx.ignoreFilter ?? undefined,
        // bd tea-rags-mcp-v2mlw: per-blame-pass telemetry → [GitEnrich] BLAME
        // line + "blame" stage (inline-only dispatch path; never serialized —
        // precedent: chunk-phase onWalkStats).
        onBlameStats: (stats) => {
          pipelineLog.step({ component: "GitEnrich" }, "BLAME", { provider: ctx.key, ...stats });
          pipelineLog.addStageTime("blame", stats.durationMs);
        },
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
          // A file the provider declined at this level is intentionally
          // unenriched — counted as ignored, not missed, and never stamped
          // `enrichedAt` (its terminal marker is the skip stamp).
          (rel, level) => enrichmentSkipReason(ctx.provider, rel, level) !== null,
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
      // bd tea-rags-mcp-yl9tv — classify a missing overlay by POLICY, not by
      // overlay presence: a file the provider declined at this level is
      // ignored, not a silent bare-stamp. Mirrors the streaming applyFileSignals
      // call above so both apply paths agree on ignored vs missed.
      (rel, level) => enrichmentSkipReason(ctx.provider, rel, level) !== null,
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

  /** Cause of a failed prefetch (undefined when the provider did not fail). */
  getPrefetchError(providerKey: string): string | undefined {
    return this.states.get(providerKey)?.prefetchError;
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
    state.prefetchError = msg;
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

  /**
   * Write `<provider>.file.skippedAs` for the batch's policy-declined files.
   *
   * The stamp is the second terminal state of the enrichment decision, and the
   * one nothing used to write at index time: only `EnrichmentRecovery` did, so
   * a freshly indexed declined file (a new spec, a new doc) finished the run
   * carrying neither marker and was settled a run later. This is the drop site,
   * so it is where the decline gets recorded — the applier's ignored branch
   * cannot own it, because a batch whose files are ALL declined never reaches
   * the applier at all.
   *
   * Best-effort: a failed stamp write leaves those points in the next run's
   * recovery scan, which is exactly the pre-fix behaviour, so it degrades
   * instead of breaking the run.
   *
   * @returns the write promise (tracked in `fileWork` so `drain` awaits it), or
   *   undefined when the batch has nothing declined.
   */
  private stampDeclinedFiles(
    coll: string,
    ctx: ProviderContext,
    items: ChunkItem[],
    root: string,
  ): Promise<void> | undefined {
    if (!ctx.provider.shouldEnrich) return undefined;
    const reasonByRel = new Map<string, EnrichmentSkipReason | null>();
    const stamps: { id: string; skippedAs: EnrichmentSkipReason }[] = [];
    for (const item of items) {
      const rel = relative(root, item.chunk.metadata.filePath);
      let reason = reasonByRel.get(rel);
      if (reason === undefined) {
        reason = enrichmentSkipReason(ctx.provider, rel, "file");
        reasonByRel.set(rel, reason);
      }
      if (reason !== null) stamps.push({ id: item.chunkId, skippedAs: reason });
    }
    if (stamps.length === 0) return undefined;
    return this.applier
      .applySkipStamps(coll, ctx.key, "file", stamps)
      .then(() => undefined)
      .catch((error: unknown) => {
        console.error(`[Enrichment:${ctx.key}] file skip-stamp write failed (${stamps.length} points):`, error);
      });
  }

  private uniqueRelPaths(items: ChunkItem[], root: string): string[] {
    const seen = new Set<string>();
    for (const item of items) {
      seen.add(relative(root, item.chunk.metadata.filePath));
    }
    return [...seen];
  }
}

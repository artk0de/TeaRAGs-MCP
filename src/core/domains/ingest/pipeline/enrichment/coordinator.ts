/**
 * EnrichmentCoordinator — generic timing orchestrator for enrichment providers.
 *
 * Coordinates per provider:
 * 1. Per-batch streaming: apply file signals as chunks arrive — owned by FilePhase
 * 2. Streaming + post-flush + deferred chunk overlays — owned by ChunkPhase
 * 3. Finalize: deferred whole-repo file overlays + deferred chunk pass — driven
 *    by CompletionRunner.
 *
 * Per-run state is bounded inside a `RunState` container. Each `beginRun()`
 * builds a fresh RunState; old promise closures from previous runs mutate
 * their own (now-orphaned) RunState and have zero effect on the current run.
 */

import { randomUUID } from "node:crypto";

import type { Ignore } from "ignore";

import type { QdrantManager } from "../../../../adapters/qdrant/client.js";
import type { EnrichmentExecutor } from "../../../../contracts/types/enrichment-executor.js";
import type { ChunkLookupEntry, EnrichmentMetrics } from "../../../../types.js";
import { pipelineLog } from "../infra/debug-logger.js";
import type { ChunkItem } from "../types.js";
import { EnrichmentApplier } from "./applier.js";
import { EnrichmentBackfiller } from "./backfiller.js";
import { ChunkPhase } from "./chunk-phase.js";
import { CompletionRunner } from "./completion-runner.js";
import { InlineEnrichmentExecutor } from "./executor/index.js";
import { FilePhase } from "./file-phase.js";
import { EnrichmentMarkerStore } from "./marker-store.js";
import type { EnrichmentRecovery } from "./recovery.js";
import type { EnrichmentProvider, ProviderContext } from "./types.js";

const EMPTY_METRICS: EnrichmentMetrics = {
  prefetchDurationMs: 0,
  overlapMs: 0,
  overlapRatio: 0,
  streamingApplies: 0,
  flushApplies: 0,
  chunkChurnDurationMs: 0,
  totalDurationMs: 0,
  matchedFiles: 0,
  missedFiles: 0,
  missedPathSamples: [],
  gitLogFileCount: 0,
  estimatedSavedMs: 0,
};

interface RunState {
  runId: string;
  startTime: number;
  startedAt: string;
  applier: EnrichmentApplier;
  filePhase: FilePhase;
  chunkPhase: ChunkPhase;
  backfiller: EnrichmentBackfiller;
  completion: CompletionRunner;
  contexts: Map<string, ProviderContext>;
  donePromise: Promise<EnrichmentMetrics>;
  resolveDone: (m: EnrichmentMetrics) => void;
  rejectDone: (e: unknown) => void;
  /**
   * Fire-and-forget initial-marker write set in `prefetch()`. The
   * CompletionRunner awaits it before step 4/7 finalize writes so the
   * read-modify-write snapshot inside markStart can never clobber
   * subsequently-written "completed" markers.
   */
  markStartPromise: Promise<void>;
}

export class EnrichmentCoordinator {
  private readonly markerStore: EnrichmentMarkerStore;
  private currentRun: RunState | null = null;
  private readonly providers: EnrichmentProvider[];
  /**
   * Dispatch seam between the enrichment phases and provider execution.
   * Default: `InlineEnrichmentExecutor` (today's main-thread behavior). A
   * worker-pool executor can be injected (Phase 2 of the worker-pool spec)
   * without any other coordinator/phase changes.
   */
  private readonly executor: EnrichmentExecutor;

  /**
   * Optional callback fired after enrichment milestones. Invoked at most twice
   * per run:
   * 1. After ChunkPhase streaming + initial chunk enrichment settles.
   * 2. After CompletionRunner finishes file backfill + chunk backfill (only
   *    when backfill produced overlays).
   *
   * Both fires receive the collectionName. Errors in the callback are caught
   * and logged — they do not affect enrichment. Listeners must be idempotent
   * (e.g. IngestFacade.refreshStatsByCollection overwrites stats cache, so a
   * second call simply supersedes the first).
   *
   * Bound to the current RunState's chunkPhase on assignment; subsequent
   * prefetch() calls re-bind to the new run's chunkPhase. The 896f343c
   * contract is preserved: the first fire still awaits streaming work inside
   * ChunkPhase before invoking the callback.
   */
  private _onChunkEnrichmentComplete?: (collectionName: string) => Promise<void>;
  get onChunkEnrichmentComplete(): ((collectionName: string) => Promise<void>) | undefined {
    return this._onChunkEnrichmentComplete;
  }
  set onChunkEnrichmentComplete(cb: ((collectionName: string) => Promise<void>) | undefined) {
    this._onChunkEnrichmentComplete = cb;
    if (cb && this.currentRun) this.currentRun.chunkPhase.setOnComplete(cb);
  }

  /** All provider keys managed by this coordinator. */
  get providerKeys(): string[] {
    return this.providers.map((p) => p.key);
  }

  constructor(
    private readonly qdrant: QdrantManager,
    providers: EnrichmentProvider | EnrichmentProvider[],
    private readonly recovery?: EnrichmentRecovery,
    executor?: EnrichmentExecutor,
  ) {
    this.markerStore = new EnrichmentMarkerStore(qdrant);
    this.providers = Array.isArray(providers) ? providers : [providers];
    this.executor = executor ?? new InlineEnrichmentExecutor();
  }

  /**
   * Notify all providers that a set of files has been removed from the
   * project. Fans out to every provider implementing `handleDeletedPaths`;
   * providers without the hook are silently skipped. Errors from one
   * provider don't block others — failures are caught + logged so that
   * a single provider's cleanup glitch doesn't strand the rest of the
   * delete pipeline.
   *
   * Called by the sync layer BEFORE qdrant.deletePoints so provider-owned
   * state (codegraph edges, symbol-table entries, etc.) is consistent
   * even if Qdrant deletion itself fails. Orphan graph edges are silent
   * corruption; orphan Qdrant points are just clutter — better the
   * latter than the former.
   */
  async notifyDeletions(paths: string[], collectionName?: string): Promise<void> {
    if (paths.length === 0) return;
    await Promise.all(
      this.providers.map(async (provider) => {
        if (!provider.handleDeletedPaths) return;
        try {
          // Forward the active collection name so collection-scoped
          // providers (codegraph) prune the right per-collection DB.
          // Falls back to undefined when the caller (legacy test
          // fixture, or a flow that never had a collection in hand)
          // doesn't supply one — provider is responsible for failing
          // loud in pool mode.
          await provider.handleDeletedPaths(paths, collectionName ? { collectionName } : undefined);
        } catch (err) {
          pipelineLog.enrichmentPhase("DELETE_HOOK_FAILED", {
            provider: provider.key,
            count: paths.length,
            error: (err as Error).message,
          });
        }
      }),
    );
  }

  /**
   * Run recovery + migration before the main enrichment pipeline.
   * Migration is one-time and idempotent. Recovery re-enriches chunks missing enrichedAt.
   * No-op when recovery was not provided at construction time.
   */
  async runRecovery(collectionName: string, absolutePath: string): Promise<void> {
    if (!this.recovery) return;
    // Recovery uses a transient context map seeded from providers — no
    // persistent RunState needed (recovery completes synchronously per
    // collection, before any prefetch).
    const contexts = new Map<string, ProviderContext>(
      this.providers.map((p) => [p.key, { key: p.key, provider: p, effectiveRoot: null, ignoreFilter: null }]),
    );
    await this.recovery.recoverAll(collectionName, absolutePath, contexts, this.markerStore);
  }

  /**
   * Begin a new enrichment run. Non-blocking. Call before pipeline.start().
   *
   * There is no whole-repo prefetch anymore — file enrichment streams per batch
   * via onChunksStored. beginRun only builds a fresh RunState, inits the phases,
   * and writes the initial markStart marker. Per-run RunState isolation
   * guarantees old promise closures from a previous run mutate their orphaned
   * RunState, never the current one (FIFO isolation preserved).
   *
   * `changedPaths` is accepted for caller compatibility but no longer drives a
   * scoped prefetch — streaming naturally scopes to the batches actually stored.
   */
  beginRun(absolutePath: string, collectionName?: string, ignoreFilter?: Ignore, _changedPaths?: string[]): void {
    // Build a fresh RunState. Per-run instances guarantee old promise closures
    // mutate their orphaned RunState, never the current one.
    const runState = this.createRunState();
    this.currentRun = runState;

    if (this._onChunkEnrichmentComplete) {
      runState.chunkPhase.setOnComplete(this._onChunkEnrichmentComplete);
    }

    runState.contexts = new Map(
      this.providers.map((provider) => {
        const effectiveRoot = provider.resolveRoot(absolutePath);
        if (effectiveRoot !== absolutePath) {
          pipelineLog.enrichmentPhase("REPO_ROOT_DIFFERS", {
            provider: provider.key,
            absolutePath,
            effectiveRoot,
          });
        }
        return [
          provider.key,
          {
            key: provider.key,
            provider,
            effectiveRoot,
            ignoreFilter: ignoreFilter ?? null,
          },
        ];
      }),
    );

    runState.filePhase.init(runState.contexts, collectionName ?? "", runState.runId, runState.startedAt);
    runState.chunkPhase.init(runState.contexts, collectionName ?? "", runState.startedAt);

    // markStart writes the initial { file: in_progress, chunk: pending }
    // marker via read-modify-write on the qdrant metadata point. It MUST
    // persist BEFORE the CompletionRunner finalization writes (step 4 /
    // step 7) land — otherwise the fire-and-forget markStart can race
    // and clobber freshly-written "completed" markers with its stale
    // snapshot (read before final writes). The fix tracks the promise
    // on the run and CompletionRunner awaits it before writing
    // finalizers.
    runState.markStartPromise = collectionName
      ? this.markerStore
          .markStart(collectionName, [...runState.contexts.keys()], runState.runId, runState.startedAt)
          .catch(() => undefined)
      : Promise.resolve();
  }

  /**
   * Called per-batch by pipeline callback after chunks are stored in Qdrant.
   * Applies file-level signals and also triggers streaming chunk-level
   * enrichment so git blame runs overlapped with embedding/upsert of later
   * batches — instead of waiting for a single post-flush catch-up.
   */
  onChunksStored(collectionName: string, absolutePath: string, items: ChunkItem[]): void {
    if (!this.currentRun) return;
    const run = this.currentRun;
    // Sequence file→chunk per batch: git buildChunkSignals reads the batch's
    // blame/lastFileResult that streamFileBatch populates. Per-batch ordering
    // replaces the removed whole-repo gate; cheap (one batch's files).
    const fileDone = run.filePhase.onBatch(collectionName, absolutePath, items);
    void Promise.resolve(fileDone).then(() => {
      run.chunkPhase.onBatch(collectionName, absolutePath, items);
    });
  }

  /**
   * Start chunk-level enrichment (Phase 2b). Fire-and-forget, tracked internally.
   * Each provider runs independently.
   */
  startChunkEnrichment(collectionName: string, absolutePath: string, chunkMap: Map<string, ChunkLookupEntry[]>): void {
    if (!this.currentRun) return;
    this.currentRun.chunkPhase.enrichRemaining(collectionName, absolutePath, chunkMap);
  }

  /**
   * Wait for all in-flight enrichment work to complete across all providers.
   */
  async awaitCompletion(collectionName: string): Promise<EnrichmentMetrics> {
    const run = this.currentRun;
    if (!run || run.contexts.size === 0) return EMPTY_METRICS;
    // Block until the run's initial markStart has persisted. Without
    // this gate the fire-and-forget markStart can race past the final
    // marker writes and clobber them with its stale snapshot — leaving
    // get_index_status reporting "in_progress" for completed runs.
    await run.markStartPromise;
    try {
      const metrics = await run.completion.run(
        collectionName,
        run.contexts,
        run.startTime,
        async (coll, providerKey, level) => this.countSettledUnenriched(coll, providerKey, level),
        run.startedAt,
      );
      run.resolveDone(metrics);
      return metrics;
    } catch (error) {
      run.rejectDone(error);
      throw error;
    }
  }

  private createRunState(): RunState {
    const applier = new EnrichmentApplier(this.qdrant);
    const chunkPhase = new ChunkPhase(applier, this.executor);
    const filePhase = new FilePhase(applier, this.markerStore, this.executor);
    filePhase.bindChunkPhase(chunkPhase);
    const backfiller = new EnrichmentBackfiller(applier, this.qdrant, this.executor);
    const completion = new CompletionRunner({
      filePhase,
      chunkPhase,
      backfiller,
      applier,
      markerStore: this.markerStore,
      executor: this.executor,
    });

    let resolveDone!: (m: EnrichmentMetrics) => void;
    let rejectDone!: (e: unknown) => void;
    const donePromise = new Promise<EnrichmentMetrics>((resolve, reject) => {
      resolveDone = resolve;
      rejectDone = reject;
    });

    return {
      runId: randomUUID().slice(0, 8),
      startTime: Date.now(),
      startedAt: new Date().toISOString(),
      applier,
      filePhase,
      chunkPhase,
      backfiller,
      completion,
      contexts: new Map(),
      donePromise,
      resolveDone,
      rejectDone,
      markStartPromise: Promise.resolve(),
    };
  }

  /**
   * Count chunks missing enrichedAt for the marker. Re-polls once after a brief
   * grace period when the first count is non-zero — `batchSetPayload` writes
   * during enrichment use `wait: false`, so Qdrant's payload-filter index can
   * lag the actual point payloads by a few hundred milliseconds. The first
   * snapshot may report stale "unenriched" chunks that have already been
   * written but not yet indexed; the re-poll catches up to ground truth and
   * keeps the persisted marker honest.
   */
  private async countSettledUnenriched(
    collectionName: string,
    providerKey: string,
    level: "file" | "chunk",
  ): Promise<number> {
    if (!this.recovery) return 0;
    const first = await this.recovery.countUnenriched(collectionName, providerKey, level).catch(() => 0);
    if (first === 0) return 0;
    await new Promise((resolve) => setTimeout(resolve, 500));
    return await this.recovery.countUnenriched(collectionName, providerKey, level).catch(() => first);
  }
}

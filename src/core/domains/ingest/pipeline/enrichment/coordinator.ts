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
import type {
  EnrichmentExecutor,
  IndexRunDaemonGuard,
  IndexRunDaemonRelease,
} from "../../../../contracts/types/enrichment-executor.js";
import type { ChunkLookupEntry, EnrichmentMetrics } from "../../../../types.js";
import { pipelineLog } from "../infra/debug-logger.js";
import type { ChunkItem } from "../types.js";
import { EnrichmentApplier } from "./applier.js";
import { EnrichmentBackfiller } from "./backfiller.js";
import { ChunkPhase, type BlobReaderFactory } from "./chunk-phase.js";
import { CompletionRunner } from "./completion-runner.js";
import { InlineEnrichmentExecutor } from "./executor/index.js";
import { FilePhase } from "./file-phase.js";
import { EnrichmentMarkerStore } from "./marker-store.js";
import type { EnrichmentRecovery } from "./recovery.js";
import type { EnrichmentProvider, ProviderContext } from "./types.js";

const EMPTY_METRICS: EnrichmentMetrics = {
  prefetchDurationMs: 0,
  streamingApplies: 0,
  flushApplies: 0,
  chunkChurnDurationMs: 0,
  totalDurationMs: 0,
  matchedFiles: 0,
  missedFiles: 0,
  missedPathSamples: [],
};

/** No-op keep-alive guard: used when codegraph is disabled or in tests. */
const NOOP_RELEASE: IndexRunDaemonRelease = async () => {};
const NOOP_DAEMON_GUARD: IndexRunDaemonGuard = { begin: async () => NOOP_RELEASE };

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
   * Fire-and-forget `_run`-pointer write set in `beginRun()`. `awaitCompletion`
   * awaits it before the terminal writes so the run-pointer is present when the
   * health mapper compares per-kind marker runIds against `_run.runId`.
   */
  markRunStartPromise: Promise<void>;
  /** Epoch ms of the last heartbeat write — throttles `_run.lastProgressAt` updates. */
  lastHeartbeatAt: number;
  /**
   * Fire-and-forget keep-alive acquired in `beginRun`. Holds the codegraph
   * daemon alive across chunk-write + enrichment (the daemon idle-dies after
   * 30s, but chunk-write can exceed that). `awaitCompletion` awaits this and
   * calls the release in its finally so the daemon resumes idle shutdown.
   * Resolves to a no-op release when codegraph is off or the keep-alive failed.
   */
  daemonReleasePromise: Promise<IndexRunDaemonRelease>;
}

export class EnrichmentCoordinator {
  /** Min interval between `_run.lastProgressAt` heartbeat writes. */
  private static readonly HEARTBEAT_THROTTLE_MS = 30_000;
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
   * Keep-alive guard for the stateful codegraph daemon. `begin` at run start,
   * release in `awaitCompletion` finally — spans chunk-write + enrichment so
   * the daemon never idle-dies mid-run. No-op when codegraph is disabled.
   */
  private readonly daemonGuard: IndexRunDaemonGuard;

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
    daemonGuard?: IndexRunDaemonGuard,
    private readonly blobReaderFactory?: BlobReaderFactory,
  ) {
    this.markerStore = new EnrichmentMarkerStore(qdrant);
    this.providers = Array.isArray(providers) ? providers : [providers];
    this.executor = executor ?? new InlineEnrichmentExecutor();
    this.daemonGuard = daemonGuard ?? NOOP_DAEMON_GUARD;
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

    // Wire the applier-site heartbeat: every apply batch (file, chunk, finalize,
    // backfill) calls onApply → maybeHeartbeat. This covers ALL apply paths —
    // streaming, post-flush enrichRemaining, deferred codegraph, recovery — from
    // the single chokepoint. The coordinator owns the 30s throttle (DRY).
    if (collectionName) {
      runState.applier.onApply = () => {
        this.maybeHeartbeat(collectionName, runState);
      };
    }

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

    // markRunStart writes ONLY the `_run` pointer ({runId, startedAt,
    // lastProgressAt, providers}) — the single pre-completion write. No
    // per-level in_progress/pending is persisted (terminal-only model). The
    // promise is tracked on the run so awaitCompletion gates on it before the
    // terminal writes, keeping `_run` present before they land.
    runState.markRunStartPromise = collectionName
      ? this.markerStore
          .markRunStart(collectionName, [...runState.contexts.keys()], runState.runId, runState.startedAt)
          .catch(() => undefined)
      : Promise.resolve();

    // Hold the codegraph daemon alive for the whole run. Fire-and-forget here
    // (non-blocking begin); `awaitCompletion` awaits the release and calls it
    // in its finally. Gated on having providers + a collection — a provider-
    // less or anonymous run has nothing to keep alive. begin never rejects
    // (guard contract), but .catch keeps a stray rejection from going unhandled.
    runState.daemonReleasePromise =
      collectionName && this.providers.length > 0
        ? this.daemonGuard.begin(collectionName).catch(() => NOOP_RELEASE)
        : Promise.resolve(NOOP_RELEASE);
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
    // Sequence file→chunk PER PROVIDER: a provider's buildChunkSignals reads the
    // batch's file result its own streamFileBatch populated (git blame needs
    // this), so each chunk dispatch must wait for the SAME provider's file work.
    // It must NOT wait on other providers — gating git chunk on codegraph's
    // (cold, serialized-DuckDB) file extraction starved git chunk (wy5i). The
    // per-provider map keeps git.file→git.chunk and codegraph.file→codegraph.chunk
    // fully concurrent across providers.
    const fileWorkByProvider = run.filePhase.onBatch(collectionName, absolutePath, items);
    for (const [providerKey, fileDone] of fileWorkByProvider) {
      void fileDone.then(() => {
        run.chunkPhase.onBatchProvider(providerKey, collectionName, absolutePath, items);
      });
    }
    // Advance the run-pointer heartbeat on real apply progress (throttled). A
    // hung run stops producing batches → lastProgressAt freezes → the health
    // mapper derives stalled/crashed instead of a stuck in_progress.
    this.maybeHeartbeat(collectionName, run);
  }

  /**
   * Throttled `_run.lastProgressAt` heartbeat. Fires at most once per
   * HEARTBEAT_THROTTLE_MS and only for the CURRENTLY-active run (RunState
   * isolation: a stale closure's run is no longer `this.currentRun`, so it
   * never rewrites the live `_run` with an old runId). Fire-and-forget.
   */
  private maybeHeartbeat(collectionName: string, run: RunState): void {
    if (!collectionName || this.currentRun !== run) return;
    const now = Date.now();
    if (now - run.lastHeartbeatAt < EnrichmentCoordinator.HEARTBEAT_THROTTLE_MS) return;
    run.lastHeartbeatAt = now;
    void this.markerStore
      .heartbeat(collectionName, [...run.contexts.keys()], run.runId, run.startedAt, new Date().toISOString())
      .catch(() => undefined);
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
    // Block until the run's `_run` pointer has persisted, so the terminal
    // writes (which carry this run's runId) land against a present run-pointer
    // and the health mapper's runId comparison is meaningful.
    await run.markRunStartPromise;
    try {
      const metrics = await run.completion.run(
        collectionName,
        run.contexts,
        run.startTime,
        async (coll, providerKey, level) => this.countSettledUnenriched(coll, providerKey, level),
        run.startedAt,
        run.runId,
      );
      // Phase 2 of unified-enrichment-worker-pool plan: signal the executor
      // to release any per-collection state it cached. For Inline executor
      // this is a no-op (shared provider, can't safely call onRelease across
      // concurrent runs). For WorkerPoolEnrichmentExecutor this fans out a
      // `release` envelope per worker-descriptor provider and drops the
      // ThreadPool affinity binding. Failures are swallowed inside the
      // executor — release MUST NOT regress an otherwise-successful run.
      const providers = Array.from(run.contexts.values()).map((ctx) => ctx.provider);
      await this.executor.releaseCollection(providers, collectionName);
      run.resolveDone(metrics);
      return metrics;
    } catch (error) {
      run.rejectDone(error);
      throw error;
    } finally {
      // Release the daemon keep-alive on EVERY path (success, error, crash).
      // Skipping this would pin the daemon's refcount > 0 forever and defeat
      // its idle shutdown. The release is idempotent and swallows its own
      // errors so it never masks the run's real outcome.
      const release = await run.daemonReleasePromise.catch(() => NOOP_RELEASE);
      await release().catch(() => undefined);
    }
  }

  private createRunState(): RunState {
    const applier = new EnrichmentApplier(this.qdrant);
    const chunkPhase = new ChunkPhase(applier, this.executor, this.blobReaderFactory);
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
      markRunStartPromise: Promise.resolve(),
      lastHeartbeatAt: 0,
      daemonReleasePromise: Promise.resolve(NOOP_RELEASE),
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

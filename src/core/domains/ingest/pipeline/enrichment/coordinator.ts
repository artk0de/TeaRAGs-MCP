/**
 * EnrichmentCoordinator — generic timing orchestrator for enrichment providers.
 *
 * Coordinates three phases per provider:
 * 1. Prefetch: provider.buildFileSignals (fire-and-forget at T=0) — owned by FilePhase
 * 2. Per-batch: apply file signals as chunks arrive — owned by FilePhase
 * 3. Streaming + post-flush chunk overlays — owned by ChunkPhase
 *
 * Per-run state is bounded inside a `RunState` container. Each `prefetch()`
 * builds a fresh RunState; old promise closures from previous runs mutate
 * their own (now-orphaned) RunState and have zero effect on the current run.
 */

import { randomUUID } from "node:crypto";

import type { Ignore } from "ignore";

import type { QdrantManager } from "../../../../adapters/qdrant/client.js";
import type { ChunkLookupEntry, EnrichmentMetrics } from "../../../../types.js";
import { pipelineLog } from "../infra/debug-logger.js";
import type { ChunkItem } from "../types.js";
import { EnrichmentApplier } from "./applier.js";
import { EnrichmentBackfiller } from "./backfiller.js";
import { ChunkPhase } from "./chunk-phase.js";
import { CompletionRunner } from "./completion-runner.js";
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
}

export class EnrichmentCoordinator {
  private readonly markerStore: EnrichmentMarkerStore;
  private currentRun: RunState | null = null;
  private readonly providers: EnrichmentProvider[];

  /**
   * Optional callback fired after ALL providers complete chunk enrichment.
   * Receives the collectionName. Only fires if at least one provider succeeded.
   * Errors in the callback are caught and logged — they do not affect enrichment.
   * Bound to the current RunState's chunkPhase on assignment; subsequent
   * prefetch() calls re-bind to the new run's chunkPhase.
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
  ) {
    this.markerStore = new EnrichmentMarkerStore(qdrant);
    this.providers = Array.isArray(providers) ? providers : [providers];
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
   * Start file-level metadata prefetch at T=0. Non-blocking.
   * Call before pipeline.start() to maximize overlap.
   * All providers prefetch in parallel.
   */
  prefetch(absolutePath: string, collectionName?: string, ignoreFilter?: Ignore, changedPaths?: string[]): void {
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

    if (collectionName) {
      void this.markerStore.markStart(
        collectionName,
        [...runState.contexts.keys()],
        runState.runId,
        runState.startedAt,
      );
    }

    runState.filePhase.startPrefetch(changedPaths);
  }

  /**
   * Called per-batch by pipeline callback after chunks are stored in Qdrant.
   * Applies file-level signals and also triggers streaming chunk-level
   * enrichment so git blame runs overlapped with embedding/upsert of later
   * batches — instead of waiting for a single post-flush catch-up.
   */
  onChunksStored(collectionName: string, absolutePath: string, items: ChunkItem[]): void {
    if (!this.currentRun) return;
    this.currentRun.filePhase.onBatch(collectionName, absolutePath, items);
    this.currentRun.chunkPhase.onBatch(collectionName, absolutePath, items);
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
    const chunkPhase = new ChunkPhase(applier);
    const filePhase = new FilePhase(applier, this.markerStore);
    filePhase.bindChunkPhase(chunkPhase);
    const backfiller = new EnrichmentBackfiller(applier, this.qdrant);
    const completion = new CompletionRunner({
      filePhase,
      chunkPhase,
      backfiller,
      applier,
      markerStore: this.markerStore,
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

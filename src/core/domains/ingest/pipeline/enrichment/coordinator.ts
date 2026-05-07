/**
 * EnrichmentCoordinator — generic timing orchestrator for enrichment providers.
 *
 * Coordinates three phases per provider:
 * 1. Prefetch: provider.buildFileSignals (fire-and-forget at T=0) — owned by FilePhase
 * 2. Per-batch: apply file signals as chunks arrive — owned by FilePhase
 * 3. Streaming + post-flush chunk overlays — owned by ChunkPhase
 *
 * Supports multiple providers in parallel — each with independent state.
 * Provider-agnostic — works with any EnrichmentProvider implementation.
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

/**
 * Post-Task-6 ProviderState is reduced to just the provider reference. Kept as
 * its own type so iteration over providers stays explicit; Tasks 7-8 collapse
 * this further.
 */
interface ProviderState {
  provider: EnrichmentProvider;
}

function createProviderState(provider: EnrichmentProvider): ProviderState {
  return { provider };
}

export class EnrichmentCoordinator {
  private readonly states: Map<string, ProviderState>;
  private contexts: Map<string, ProviderContext>;
  private startTime = 0;
  private runId = "";
  private runStartedAt = "";

  // Delegates
  private readonly applier: EnrichmentApplier;
  private readonly markerStore: EnrichmentMarkerStore;
  private readonly backfiller: EnrichmentBackfiller;
  private readonly filePhase: FilePhase;
  private readonly chunkPhase: ChunkPhase;
  private readonly completion: CompletionRunner;

  /**
   * Optional callback fired after ALL providers complete chunk enrichment.
   * Receives the collectionName. Only fires if at least one provider succeeded.
   * Errors in the callback are caught and logged — they do not affect enrichment.
   * Backed by ChunkPhase.setOnComplete; getter exposes the stored callback for
   * tests and external assertions.
   */
  private _onChunkEnrichmentComplete?: (collectionName: string) => Promise<void>;
  get onChunkEnrichmentComplete(): ((collectionName: string) => Promise<void>) | undefined {
    return this._onChunkEnrichmentComplete;
  }
  set onChunkEnrichmentComplete(cb: ((collectionName: string) => Promise<void>) | undefined) {
    this._onChunkEnrichmentComplete = cb;
    if (cb) this.chunkPhase.setOnComplete(cb);
  }

  /** All provider keys managed by this coordinator. */
  get providerKeys(): string[] {
    return [...this.states.keys()];
  }

  /** @deprecated Use providerKeys instead. Returns the first provider key for backward compat. */
  get providerKey(): string {
    const first = this.states.keys().next();
    return first.done ? "" : first.value;
  }

  constructor(
    private readonly qdrant: QdrantManager,
    providers: EnrichmentProvider | EnrichmentProvider[],
    private readonly recovery?: EnrichmentRecovery,
  ) {
    this.applier = new EnrichmentApplier(qdrant);
    this.markerStore = new EnrichmentMarkerStore(qdrant);
    this.backfiller = new EnrichmentBackfiller(this.applier, qdrant);
    this.chunkPhase = new ChunkPhase(this.applier);
    this.filePhase = new FilePhase(this.applier, this.markerStore);
    this.filePhase.bindChunkPhase(this.chunkPhase);
    this.completion = new CompletionRunner({
      filePhase: this.filePhase,
      chunkPhase: this.chunkPhase,
      backfiller: this.backfiller,
      applier: this.applier,
      markerStore: this.markerStore,
    });
    const list = Array.isArray(providers) ? providers : [providers];
    this.states = new Map(list.map((p) => [p.key, createProviderState(p)]));
    // Seed contexts with provider entries so runRecovery works when invoked
    // before prefetch (e.g. recovery-only paths). prefetch() overwrites with
    // resolved effectiveRoot + ignoreFilter for the actual run.
    this.contexts = new Map(
      list.map((provider) => [provider.key, { key: provider.key, provider, effectiveRoot: null, ignoreFilter: null }]),
    );
  }

  /**
   * Run recovery + migration before the main enrichment pipeline.
   * Migration is one-time and idempotent. Recovery re-enriches chunks missing enrichedAt.
   * No-op when recovery was not provided at construction time.
   */
  async runRecovery(collectionName: string, absolutePath: string): Promise<void> {
    if (!this.recovery) return;
    await this.recovery.recoverAll(collectionName, absolutePath, this.contexts, this.markerStore);
  }

  /**
   * Start file-level metadata prefetch at T=0. Non-blocking.
   * Call before pipeline.start() to maximize overlap.
   * All providers prefetch in parallel.
   */
  prefetch(absolutePath: string, collectionName?: string, ignoreFilter?: Ignore, changedPaths?: string[]): void {
    this.startTime = Date.now();
    this.runId = randomUUID().slice(0, 8);
    this.runStartedAt = new Date().toISOString();

    this.contexts = new Map(
      [...this.states.values()].map((state) => {
        const effectiveRoot = state.provider.resolveRoot(absolutePath);
        if (effectiveRoot !== absolutePath) {
          pipelineLog.enrichmentPhase("REPO_ROOT_DIFFERS", {
            provider: state.provider.key,
            absolutePath,
            effectiveRoot,
          });
        }
        return [
          state.provider.key,
          {
            key: state.provider.key,
            provider: state.provider,
            effectiveRoot,
            ignoreFilter: ignoreFilter ?? null,
          },
        ];
      }),
    );

    this.filePhase.init(this.contexts, collectionName ?? "", this.runId, this.runStartedAt);
    this.chunkPhase.init(this.contexts, collectionName ?? "", this.runStartedAt);

    // Write per-provider initial marker: file=in_progress, chunk=pending
    if (collectionName) {
      void this.markerStore.markStart(collectionName, [...this.states.keys()], this.runId, this.runStartedAt);
    }

    this.filePhase.startPrefetch(changedPaths);
  }

  /**
   * Called per-batch by pipeline callback after chunks are stored in Qdrant.
   * Applies file-level signals and also triggers streaming chunk-level
   * enrichment so git blame runs overlapped with embedding/upsert of later
   * batches — instead of waiting for a single post-flush catch-up.
   */
  onChunksStored(collectionName: string, absolutePath: string, items: ChunkItem[]): void {
    this.filePhase.onBatch(collectionName, absolutePath, items);
    this.chunkPhase.onBatch(collectionName, absolutePath, items);
  }

  /**
   * Start chunk-level enrichment (Phase 2b). Fire-and-forget, tracked internally.
   * Each provider runs independently.
   */
  startChunkEnrichment(collectionName: string, absolutePath: string, chunkMap: Map<string, ChunkLookupEntry[]>): void {
    this.chunkPhase.enrichRemaining(collectionName, absolutePath, chunkMap);
  }

  /**
   * Wait for all in-flight enrichment work to complete across all providers.
   */
  async awaitCompletion(collectionName: string): Promise<EnrichmentMetrics> {
    if (this.states.size === 0) return EMPTY_METRICS;
    return this.completion.run(
      collectionName,
      this.contexts,
      this.startTime,
      async (coll, providerKey, level) => this.countSettledUnenriched(coll, providerKey, level),
      this.runStartedAt,
    );
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

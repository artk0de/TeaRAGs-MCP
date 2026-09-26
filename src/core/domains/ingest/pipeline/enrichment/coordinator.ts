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
 * builds a fresh RunState and hands back its `EnrichmentRunHandle`; every
 * per-run entry takes that handle, so a call — or a promise closure — of one
 * run reaches that run's state and never another's (bd tea-rags-mcp-39xca.3).
 */

import { randomUUID } from "node:crypto";

import type { QdrantManager } from "../../../../adapters/qdrant/client.js";
import { servicePointExclusions } from "../../../../adapters/qdrant/service-points.js";
import { selectProviderKeys } from "../../../../contracts/provider-selector.js";
import type { FileExtraction } from "../../../../contracts/types/codegraph.js";
import type { PhysicalCollectionName } from "../../../../contracts/types/collection-identity.js";
import type {
  EnrichmentExecutor,
  EnrichmentRunHandle,
  IndexRunDaemonGuard,
  IndexRunDaemonRelease,
} from "../../../../contracts/types/enrichment-executor.js";
import type { EnrichmentRunCoverage } from "../../../../contracts/types/provider.js";
import type { ChunkLookupEntry, EnrichmentMetrics, EnrichmentProgressCallback } from "../../../../types.js";
import { pipelineLog } from "../infra/debug-logger.js";
import type { ChunkItem } from "../types.js";
import { EnrichmentApplier, type EnrichmentApplyEvent } from "./applier.js";
import { EnrichmentBackfiller } from "./backfiller.js";
import { ChunkPhase, type BlobReaderFactory } from "./chunk-phase.js";
import type { CodegraphPayloadHealRunner } from "./codegraph-payload-heal.js";
import { CompletionRunner, type CodegraphStorageCompactionRunner } from "./completion-runner.js";
import { InlineEnrichmentExecutor } from "./executor/index.js";
import { computeExtractionRepair, type ExtractionRepair } from "./extraction-repair.js";
import { FilePhase } from "./file-phase.js";
import { EnrichmentMarkerStore } from "./marker-store.js";
import { filterFileEnrichPaths } from "./policy.js";
import type { DeferredChunkRecoveryHandoff, EnrichmentRecovery } from "./recovery.js";
import {
  ALL_LANGUAGES,
  finalizeOnlyRunSpec,
  recomputeRunSpec,
  runCoverageOf,
  type EnrichmentRunSpec,
} from "./run-spec.js";
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

/**
 * File-phase dispatch size for a whole-index recompute. Matches the live
 * pipeline's batching intent: a repo-sized single dispatch would blow worker
 * memory and delay every payload write to the very end of the pass.
 */
const RECOMPUTE_BATCH_SIZE = 500;

/** Runaway backstop for the recompute scroll — not a working cap. */
const RECOMPUTE_SCROLL_HARD_CAP = 1_000_000;

/** No-op keep-alive guard: used when codegraph is disabled or in tests. */
const NOOP_RELEASE: IndexRunDaemonRelease = async () => {};
const NOOP_DAEMON_GUARD: IndexRunDaemonGuard = { begin: async () => NOOP_RELEASE };

/**
 * Delay before each successive re-read of the unenriched count, in ms (bd
 * tea-rags-mcp-9dg6s). Reads = `length + 1`; total sleep = the sum (3.75s).
 *
 * `batchSetPayload` writes with `wait: false`, so Qdrant's payload-filter index
 * lags the points and a first count can include points already written. The wait
 * is therefore a CONDITION — read until two consecutive reads agree — and this
 * schedule only bounds it:
 *
 * - 250ms first: a count that is NOT moving converges on the second read, so
 *   genuine damage costs one short delay, not the whole budget.
 * - Growing delays give a swapping Qdrant more room per attempt without charging
 *   a host that does not need it.
 * - The sum is a hard ceiling: this runs on EVERY run's completion, per
 *   (provider, level), and must terminate whatever Qdrant does.
 */
export const SETTLE_POLL_DELAYS_MS: readonly number[] = [250, 500, 1000, 2000];

interface RunState {
  runId: string;
  /** What callers hold for this run; resolves back to this state through `runStates`. */
  handle: EnrichmentRunHandle;
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
   * Fire-and-forget keep-alive acquired in `beginRun`, holding the codegraph
   * daemon (30s idle exit) alive across chunk-write + enrichment. Released in
   * `awaitCompletion`'s finally; a no-op release when codegraph is off or the
   * keep-alive failed.
   */
  daemonReleasePromise: Promise<IndexRunDaemonRelease>;
  /**
   * yl9tv Task 5b — true on the full-index path, where the chunk pass feeds each
   * file's codegraph `FileExtraction` into the provider input spill. Threaded
   * into every `FileSignalOptions` via `FilePhase`, so the worker's
   * `streamFileBatch` skips the re-parse and `finalizeSignals` drains the spill.
   * `reindex_changes` always leaves it false.
   */
  crossPass: boolean;
  /**
   * Languages this run was restricted to, empty when it spans the whole
   * collection (bd tea-rags-mcp-9dg6s). A restricted run is JUDGED on the same
   * set it processed: the terminal unenriched count must not include languages it
   * was told to skip, which the unrestricted working-tree sync keeps re-dirtying.
   * Per-run, so a stale closure cannot widen or narrow the count.
   */
  languages: readonly string[];
  /**
   * Whether this run resolves the whole corpus of the languages it walks (bd
   * tea-rags-mcp-xpmwg). Threaded into every finalize through `FilePhase`, where
   * codegraph decides what its persisted resolve breakdown may claim. Derived
   * from the spec's scope, never set beside it.
   */
  runCoverage: EnrichmentRunCoverage;
  /**
   * Settles when this run's completion finishes — executor release and daemon
   * release included — and never rejects (bd tea-rags-mcp-71n0p / u3e77). Set
   * synchronously on entry to `awaitCompletion`, cleared when it returns;
   * undefined for a run whose completion never started, which has nothing
   * running to overlap with. `recomputeEnrichments` awaits it so its run cannot
   * overlap the tail of the one before.
   */
  inFlightCompletion?: Promise<void>;
  /**
   * CLI progress bookkeeping, per run so a late batch or extraction of a
   * replaced run cannot move the current run's bars (bd tea-rags-mcp-39xca.3).
   *
   * `grandFileCount` is the file-level denominator (the spec's `fileCount`).
   * `chunkTotalAccumulated` sums stored chunks, the chunk-level fallback
   * denominator. `chunkTotal` is the embedding chunk total pushed through
   * `setChunkTotal` — the SAME denominator the embeddings bar uses, so git chunk
   * tracks embeddings instead of its own lagging stored count; 0 until the first
   * push. `deferredStartEmitted` guards the one-time indeterminate start bars of
   * deferred providers. `codegraphSymbolsApplied` counts accepted cross-pass
   * `FileExtraction`s (yl9tv Task 3). `progress` is the last emitted applied
   * value per `${providerKey}:${level}`; the applier already emits cumulative values.
   */
  grandFileCount: number;
  chunkTotalAccumulated: number;
  chunkTotal: number;
  deferredStartEmitted: boolean;
  codegraphSymbolsApplied: number;
  progress: Map<string, { applied: number; total: number }>;
}

export class EnrichmentCoordinator {
  /** Min interval between `_run.lastProgressAt` heartbeat writes. */
  private static readonly HEARTBEAT_THROTTLE_MS = 30_000;
  private readonly markerStore: EnrichmentMarkerStore;
  private currentRun: RunState | null = null;
  /**
   * Every run this coordinator opened, by the handle it handed out (bd
   * tea-rags-mcp-39xca.3). Per-run entries resolve their state here, never
   * through `currentRun`; a handle this coordinator did not issue resolves to
   * nothing, and the call is a no-op.
   */
  private readonly runStates = new WeakMap<EnrichmentRunHandle, RunState>();
  /**
   * Completions in flight, keyed by the collection each one closes (bd
   * tea-rags-mcp-62pgi). Unlike `currentRun`, a newer run does not hide an older
   * run's completion here, and a run whose completion never started is never in
   * it — so `whenCompletionsSettled` can neither miss work nor wait forever.
   */
  private readonly inFlightCompletionsByCollection = new Map<string, Set<Promise<void>>>();
  private readonly providers: EnrichmentProvider[];
  /**
   * Dispatch seam between the enrichment phases and provider execution.
   * Default: `InlineEnrichmentExecutor` (main-thread); a worker-pool executor is
   * injected without any other coordinator/phase change.
   */
  private readonly executor: EnrichmentExecutor;

  /**
   * Keep-alive guard for the stateful codegraph daemon. `begin` at run start,
   * release in `awaitCompletion` finally — spans chunk-write + enrichment so
   * the daemon never idle-dies mid-run. No-op when codegraph is disabled.
   */
  private readonly daemonGuard: IndexRunDaemonGuard;

  /**
   * Per-file SHA256 for the current run, reused by the normal file phase (bd
   * tea-rags-mcp-6goqa). Every path that writes provider rows must stamp it, or
   * that path keeps resetting rows to NULL and the repair set never converges.
   * Two suppliers: `runRepairPass` projects them off its incremental scan, and
   * `beginRun` takes them from the caller on the streaming path (first index /
   * `--force`), which has no scan of its own (bd tea-rags-mcp-o317j).
   */
  private runContentHashes?: ReadonlyMap<string, string>;

  /**
   * Diagnostic-only `CODEGRAPH_FORCE_RESOLVE=1|true`: treat every eligible file
   * as drifted in the repair pass, so a run resolves the whole corpus (read once
   * per coordinator). It lives here because pass-2 resolves every spilled line,
   * so which files reach pass-1 — decided by `computeExtractionRepair` — is the
   * only lever on WHAT resolves. It exists so `ENRICHMENT_WORKER_CPU_PROFILE_DIR`
   * can sample a full resolve on demand (bd tea-rags-mcp-bij2m), and rewrites
   * nothing a normal resolve of those files would not: same `runFileBatch` seam,
   * same run hashes, so the next ordinary run sees a converged store.
   */
  private readonly forceResolveAll =
    process.env.CODEGRAPH_FORCE_RESOLVE === "1" || process.env.CODEGRAPH_FORCE_RESOLVE === "true";

  /**
   * Per-run enrichment progress sink (CLI only). When set, every apply batch
   * (via `applier.onApply`) accumulates a cumulative per-(provider, level)
   * numerator and forwards an {@link EnrichmentProgressEvent}. Undefined on the
   * MCP path — no emission, zero overhead. Set per run by `IndexingOps.run`.
   */
  private progressCb?: EnrichmentProgressCallback;

  /**
   * Optional callback fired after enrichment milestones, at most twice per run:
   * after ChunkPhase streaming + initial chunk enrichment settles, and after
   * CompletionRunner's backfill when it produced overlays. Receives the
   * collectionName; errors are caught and logged, and listeners must be
   * idempotent. Bound to the current run's chunkPhase on assignment and re-bound
   * by every `beginRun`; the first fire still awaits ChunkPhase's streaming work.
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

  /**
   * yl9tv — true iff any provider consumes chunk-pass `FileExtraction`s (the
   * codegraph provider). The file-processor uses this to decide whether to flip
   * the chunker worker's `emitExtraction` on: when no provider accepts them,
   * computing the extraction is pure waste.
   */
  acceptsExtractions(): boolean {
    return this.providers.some((p) => p.acceptExtraction !== undefined);
  }

  constructor(
    private readonly qdrant: QdrantManager,
    providers: EnrichmentProvider | EnrichmentProvider[],
    private readonly recovery?: EnrichmentRecovery,
    executor?: EnrichmentExecutor,
    daemonGuard?: IndexRunDaemonGuard,
    private readonly blobReaderFactory?: BlobReaderFactory,
    /**
     * Rewrites `codegraph.symbols.*` on points this run never reaches but whose
     * derived signals moved anyway (bd tea-rags-mcp-a2ddb). Built by the
     * composition root, where the graph client and Qdrant are both in scope;
     * undefined when codegraph is off, and the completion tail then skips the
     * step rather than running a stub.
     */
    private readonly codegraphHeal?: CodegraphPayloadHealRunner,
    /**
     * Reclaims the dead row versions a run leaves in the collection's graph
     * file (bd tea-rags-mcp-dvzdm). Built beside `codegraphHeal`, by the same
     * root, under the same condition.
     */
    private readonly codegraphCompaction?: CodegraphStorageCompactionRunner,
  ) {
    this.markerStore = new EnrichmentMarkerStore(qdrant);
    this.providers = Array.isArray(providers) ? providers : [providers];
    this.executor = executor ?? new InlineEnrichmentExecutor();
    this.daemonGuard = daemonGuard ?? NOOP_DAEMON_GUARD;
  }

  /**
   * Bring each provider's per-file store back in line with the code before the
   * run's own enrichment starts (bd tea-rags-mcp-6goqa).
   *
   * A file only heals when it is itself re-extracted, so stale rows outlive every
   * reindex once their file stops changing. Each provider that can report what it
   * persisted is diffed against the run's eligible files: drifted or missing files
   * are re-extracted through the SAME `runFileBatch` seam the live file phase uses
   * (inside this run, sharing its sink), and rows for no-longer-eligible files are
   * pruned. Silent by design; one read per provider when the store already
   * matches. Providers with no per-file store (git) are skipped, not assumed clean.
   *
   * Returns how many files were re-extracted: a run with no file changes would
   * otherwise take its early return and skip the finalize that recomputes the
   * derived tables, so a repair-only run has to be recognised as real work.
   *
   * A DRIFT check on every ordinary path — but the recompute path
   * (`--force-enrichments`) NOW forces this repair for its selected store
   * providers (bd tea-rags-mcp-cneu7), via `forceProviders` below. The
   * recompute's own writes to a provider's per-file store are ADDITIVE, so
   * they can never retire a stale edge row on an unchanged file; this leg's
   * diffing per-file write is the only path that can. That reinstates the
   * duplicate pass-1 + pass-2 bd tea-rags-mcp-6aytq removed — its premise
   * ("the recompute re-extracts everything, no hash gate") held for Qdrant
   * payload, not for the persisted DuckDB edge rows. `CODEGRAPH_FORCE_RESOLVE`
   * remains the env knob widening the repair for profiling on ANY run.
   *
   * The compare is sound (bd tea-rags-mcp-sz1y0): both legs carry ONE hash, the
   * synchronizer's sha256 (`ParallelFileSynchronizer#hashFile`) — the scan hands
   * it in as `scanned` and the write leg stamps `runState.contentHashes` off that
   * map — so a mismatch means a changed file or no row. A converged store repairs
   * 0 files, except files past `MAX_EDGES_PER_FILE`, which never get a row (bd
   * tea-rags-mcp-ihq7y). Pass-2 runs inside THIS run's finalize with the root
   * bound, so TypeScript Program admission follows the live count rule
   * (`CallEdgeResolutionRunner#prepareResolvePass`): a repair is slower per file
   * when small, never less precise.
   */
  async runRepairPass(
    physicalCollectionName: PhysicalCollectionName,
    root: string,
    scanned: ReadonlyMap<string, string>,
    /**
     * Per-provider paths to re-extract even when their persisted hash matches:
     * the files whose chunks pre-reindex recovery handed to this run (bd
     * tea-rags-mcp-fxio5). The deferred chunk pass resolves a chunk's symbol
     * only through the line map a walk writes, so a handed-off chunk whose file
     * the run never walks is stamped `enrichedAt` over an empty overlay. Narrowed
     * by the same eligibility as the drift set, and walked even when the store
     * cannot be read, which is the set `narrowDeferredChunkHandoff` promises.
     */
    forcedPaths?: ReadonlyMap<string, ReadonlySet<string>>,
    /**
     * Providers whose repair the RECOMPUTE path forces for its selectors (bd
     * tea-rags-mcp-cneu7): every eligible file re-extracts for them even when
     * the persisted hash matches, so their edge rows are rewritten through the
     * store's diffing write path. Distinct from `CODEGRAPH_FORCE_RESOLVE`,
     * which forces every provider from outside; and scoped to the caller's
     * eligibility — a selector-forced leg NEVER prunes orphans, because its
     * eligible set is the run's stored-chunk scope (language-restricted under
     * `--languages`), not the file universe the orphan diff needs.
     */
    forceProviders?: ReadonlySet<string>,
  ): Promise<number> {
    let repaired = 0;
    this.runContentHashes = scanned;
    for (const provider of this.providers) {
      const readPersisted = provider.readPersistedFileHashes;
      if (!readPersisted) continue;

      const providerEligible = this.repairEligibleFiles(provider, scanned);
      const forced = [...(forcedPaths?.get(provider.key) ?? [])].filter((path) => providerEligible.has(path));
      const forcedBySelector = forceProviders?.has(provider.key) ?? false;

      let persisted: Map<string, string | null> | undefined;
      try {
        persisted = await readPersisted.call(provider, physicalCollectionName);
      } catch (err) {
        // An unreadable store does not abort the run (the next one retries), but
        // a permanently broken provider must not stay silent: pipeline log.
        pipelineLog.enrichmentPhase("REPAIR_READ_FAILED", {
          provider: provider.key,
          collection: physicalCollectionName,
          error: err instanceof Error ? err.message : String(err),
        });
        // The drift check needs the store; the forced walk does not, and the
        // run has already been promised those files' chunks.
        if (forced.length === 0) continue;
      }

      const { repair, orphans }: ExtractionRepair = persisted
        ? computeExtractionRepair(providerEligible, persisted, this.forceResolveAll || forcedBySelector)
        : { repair: [], orphans: [] };
      const drifted = new Set(repair);
      const handedOff = forced.filter((path) => !drifted.has(path));
      repair.push(...handedOff);
      // Selector-forced eligibility is the run's stored-chunk scope, not the
      // file universe: rows outside it are the unselected languages' live
      // rows, and pruning them would delete the graph this run was told not
      // to touch. The env knob keeps pruning — its eligibility is the full
      // working-tree scan, where an out-of-set row really is an orphan.
      if (!forcedBySelector && orphans.length > 0) {
        await provider.handleDeletedPaths?.(orphans, { collectionName: physicalCollectionName });
      }
      if (repair.length > 0) {
        pipelineLog.enrichmentPhase("REPAIR_PASS", {
          provider: provider.key,
          collection: physicalCollectionName,
          repaired: repair.length,
          orphaned: forcedBySelector ? 0 : orphans.length,
          // Attributes a profile to a forced run; omitted when off, keeping the
          // ordinary run's log line byte-identical.
          ...(this.forceResolveAll || forcedBySelector
            ? { forcedResolve: true, forcedBy: this.forceResolveAll ? "env" : "selector" }
            : {}),
          // Files walked only because recovery handed their chunks to this run
          // (bd tea-rags-mcp-fxio5). Omitted when none, for the same reason.
          ...(handedOff.length > 0 ? { handedOff: handedOff.length } : {}),
        });
        // `runFileBatch`, NOT `runFileSignalsRecovery`: repair runs INSIDE the live
        // run and must share its `runBatchChains`-serialized sink, so a repaired
        // file that also reaches the run another way is deduped, not resolved
        // twice. The recovery path is isolated by design (enrichment-executor.ts)
        // and would pay a whole-graph overlay read per file this caller discards.
        await this.executor.runFileBatch(provider, root, repair, {
          collectionName: physicalCollectionName,
          contentHashes: scanned,
        });
        repaired += repair.length;
      }
    }
    return repaired;
  }

  /**
   * Whether any provider's derived state was pruned by a deletion and not yet
   * recomputed (bd tea-rags-mcp-dy852) — the other reason, besides a repair, a
   * reindex with nothing to chunk still owes `runFinalizeOnly`. A provider whose
   * store cannot be read counts as not stale.
   */
  async hasStaleDerivedState(physicalCollectionName: PhysicalCollectionName): Promise<boolean> {
    for (const provider of this.providers) {
      if (!provider.hasStaleDerivedState) continue;
      try {
        if (await provider.hasStaleDerivedState(physicalCollectionName)) return true;
      } catch (err) {
        // An unreadable store must not turn every later no-op reindex into a
        // finalize; the run that can reach it again asks again.
        pipelineLog.enrichmentPhase("STALE_DERIVED_READ_FAILED", {
          provider: provider.key,
          collection: physicalCollectionName,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
    return false;
  }

  /**
   * The whole-collection work a finalize ends with, for a reindex that
   * finalized nothing (bd tea-rags-mcp-l1ot.2) — `ReindexPipeline`'s
   * deletion-only and no-change returns, unless their repair finalize ran.
   * Codegraph rebuilds its co-change sub-graph here; without it a committed
   * deletion kept the deleted file's pairs until some later run chunked a file.
   *
   * Every declaring provider is asked once, in order, on its main-thread
   * instance (like `hasStaleDerivedState`). One that throws is logged and never
   * fails the reindex, and the next one still runs.
   *
   * A run that DID finalize reaches the same work through `completeRun` (bd
   * tea-rags-mcp-vtuu4), never through the provider's finalize.
   */
  async runCollectionCompletion(absolutePath: string, physicalCollectionName: PhysicalCollectionName): Promise<void> {
    await this.completeCollectionOf(this.providers, absolutePath, physicalCollectionName);
  }

  /**
   * Ask each of `providers` for its whole-collection work, on the MAIN thread.
   * Best-effort per provider: a throw is logged and the next one still runs.
   *
   * Each call reports its wall clock and main-thread heap delta as
   * `COLLECTION_COMPLETION` (bd tea-rags-mcp-vtuu4) — codegraph's co-change
   * build loads months of history and builds pair maps here, and this line is
   * how a live run shows what that costs.
   */
  private async completeCollectionOf(
    providers: readonly EnrichmentProvider[],
    absolutePath: string,
    physicalCollectionName: PhysicalCollectionName,
  ): Promise<void> {
    for (const provider of providers) {
      if (!provider.completeCollection) continue;
      const startedAt = Date.now();
      const heapUsedBefore = process.memoryUsage().heapUsed;
      try {
        await provider.completeCollection(provider.resolveRoot(absolutePath), {
          collectionName: physicalCollectionName,
        });
      } catch (err) {
        process.stderr.write(
          `[tea-rags] ${provider.key} collection completion failed: ${err instanceof Error ? err.message : String(err)}\n`,
        );
      } finally {
        pipelineLog.enrichmentPhase("COLLECTION_COMPLETION", {
          provider: provider.key,
          collection: physicalCollectionName,
          durationMs: Date.now() - startedAt,
          heapUsedDeltaBytes: process.memoryUsage().heapUsed - heapUsedBefore,
        });
      }
    }
  }

  /**
   * Drive the completion sequence for a pass that never opened a chunk pipeline
   * (bd tea-rags-mcp-gvw8h).
   *
   * A repair OPENS a run on every provider it touches (run-global resolution
   * state, counters, markers); a reindex that takes an early return has no chunk
   * pass to close it. So: begin a run, run the same `CompletionRunner` sequence,
   * let it settle. Steps keyed off stored chunks read an empty map and no-op —
   * except a recovery handoff, whose chunks are seeded and computed.
   *
   * Callers gate this on the repair having found work, or on a provider's
   * derived state being stale (`hasStaleDerivedState`). An untouched repository
   * must not pay for a completion pass it has no use for.
   */
  async runFinalizeOnly(
    absolutePath: string,
    physicalCollectionName: PhysicalCollectionName,
    /**
     * Chunks pre-reindex recovery handed to this run, already narrowed by
     * `narrowDeferredChunkHandoff`, so their files are ones the repair walked
     * (bd tea-rags-mcp-fxio5). Seeded right after `beginRun`, before completion
     * reads the deferred chunk map.
     */
    deferredChunkHandoff?: DeferredChunkRecoveryHandoff,
  ): Promise<EnrichmentMetrics> {
    const run = this.beginRun(finalizeOnlyRunSpec({ absolutePath, collection: physicalCollectionName }));
    if (deferredChunkHandoff) this.seedDeferredChunks(run, deferredChunkHandoff);
    return this.awaitCompletion(run);
  }

  /**
   * The part of a recovery handoff this coordinator's repair pass walks (bd
   * tea-rags-mcp-fxio5): providers that defer chunk enrichment and keep a
   * per-file store, restricted to paths eligible for that store's repair.
   *
   * Hand its paths to `runRepairPass` as forced paths and seed exactly this
   * handoff. A seeded chunk whose file the run never walks has no line-map
   * entry, so the deferred pass finds no symbol and the applier stamps
   * `enrichedAt` over an empty overlay — the defect the handoff removes.
   */
  narrowDeferredChunkHandoff(
    handoff: DeferredChunkRecoveryHandoff,
    scanned: ReadonlyMap<string, string>,
  ): DeferredChunkRecoveryHandoff {
    const narrowed = new Map<string, ReadonlyMap<string, ChunkLookupEntry[]>>();
    for (const provider of this.providers) {
      const entriesByPath = handoff.get(provider.key);
      if (!entriesByPath || !provider.defersChunkEnrichment || !provider.readPersistedFileHashes) continue;
      const eligible = this.repairEligibleFiles(provider, scanned);
      const kept = new Map([...entriesByPath].filter(([relPath]) => eligible.has(relPath)));
      if (kept.size > 0) narrowed.set(provider.key, kept);
    }
    return narrowed;
  }

  /**
   * Append a recovery handoff to `run`'s deferred chunk maps (bd
   * tea-rags-mcp-fxio5). Call right after `beginRun` and before completion:
   * completion step 2 applies file overlays through that map and step 7
   * computes chunk signals from it. Appends — chunks the pipeline accumulates
   * for the same provider keep their entries. Pass a handoff narrowed by
   * `narrowDeferredChunkHandoff`.
   */
  seedDeferredChunks(run: EnrichmentRunHandle, handoff: DeferredChunkRecoveryHandoff): void {
    const state = this.runStates.get(run);
    if (!state) return;
    for (const [providerKey, entriesByPath] of handoff) {
      state.chunkPhase.appendDeferredChunks(providerKey, entriesByPath);
    }
  }

  /**
   * The files a provider's repair may re-extract, keyed to their run hash.
   * Narrowed per provider HERE — one pre-filtered set would make each provider's
   * orphan list wrong for the others (codegraph declines tests, git takes them).
   *
   * Two narrowings answering different questions: `shouldEnrich` says whether a
   * POINT is owed a payload block; `filterExtractablePaths` says whether the
   * provider's STORE can ever hold a row for the file. Without the second, every
   * JSON/Markdown/YAML file codegraph answers "full" for is re-listed forever (bd
   * tea-rags-mcp-65bkl). A provider that persists whatever it is asked for omits
   * the hook and keeps the wider set.
   */
  private repairEligibleFiles(provider: EnrichmentProvider, scanned: ReadonlyMap<string, string>): Map<string, string> {
    const eligible = new Map<string, string>();
    const enrichable = filterFileEnrichPaths(provider, [...scanned.keys()]);
    for (const path of provider.filterExtractablePaths?.(enrichable) ?? enrichable) {
      eligible.set(path, scanned.get(path) as string);
    }
    return eligible;
  }

  /**
   * Notify every provider implementing `handleDeletedPaths` that files were
   * removed. One provider's failure is logged and never blocks the others.
   * Called by the sync layer BEFORE `qdrant.deletePoints`: orphan graph edges are
   * silent corruption, orphan Qdrant points only clutter.
   */
  async notifyDeletions(paths: string[], physicalCollectionName?: PhysicalCollectionName): Promise<void> {
    if (paths.length === 0) return;
    await Promise.all(
      this.providers.map(async (provider) => {
        if (!provider.handleDeletedPaths) return;
        try {
          // Forward the collection so collection-scoped providers (codegraph)
          // prune the right per-collection DB; without one, a pool-mode provider
          // fails loud.
          await provider.handleDeletedPaths(
            paths,
            physicalCollectionName ? { collectionName: physicalCollectionName } : undefined,
          );
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
   *
   * Returns the chunks recovery handed to the reindex run instead of healing
   * them: a deferring provider's, whose signals need the run's own walk (bd
   * tea-rags-mcp-fxio5). Undefined when recovery was not provided at
   * construction time.
   */
  async runRecovery(
    physicalCollectionName: PhysicalCollectionName,
    absolutePath: string,
  ): Promise<DeferredChunkRecoveryHandoff | undefined> {
    if (!this.recovery) return undefined;
    // Recovery needs its OWN keep-alive: it runs before `beginRun`, and its
    // batches reach the codegraph daemon through a connect-only worker that
    // cannot spawn a daemon that idle-exited — the provider would report `failed`.
    // begin never rejects per the guard contract; the catch keeps a stray
    // rejection from going unhandled.
    const release = await this.daemonGuard.begin(physicalCollectionName).catch(() => NOOP_RELEASE);
    try {
      // A transient context map suffices: recovery completes per collection
      // before any run opens, so no RunState is needed.
      const contexts = new Map<string, ProviderContext>(
        this.providers.map((p) => [p.key, { key: p.key, provider: p, effectiveRoot: null, ignoreFilter: null }]),
      );
      return await this.recovery.recoverAll(physicalCollectionName, absolutePath, contexts, this.markerStore);
    } finally {
      // Never let a failing release mask the recovery outcome.
      await release().catch(() => undefined);
    }
  }

  /**
   * Rebuild enrichment payload for EVERY point of the selected providers.
   *
   * A full enrichment RUN, not a repair: recovery heals MISSED points outside any
   * run window, while a recompute rebuilds stale payload, so it must go through
   * the run lifecycle — otherwise `finalizeSignals` never fires (no
   * `cg_run_stats`) and RunState metrics report zero work. It takes the streamed
   * path with the chunk set read back from the index: begin a run, feed stored
   * chunks through the file phase in batches, run the chunk phase, complete.
   *
   * Selectors resolve through the shared provider-selector rules, so
   * `codegraph` reaches every provider under that namespace. A selector
   * matching nothing does nothing: callers validate up front and this is only
   * the last line.
   */
  async recomputeEnrichments(
    physicalCollectionName: PhysicalCollectionName,
    absolutePath: string,
    selectors: readonly string[],
    /**
     * Restrict the recompute to points of these languages. Omitted (or empty)
     * means the whole index. Validation against the languages actually present
     * happens in the facade — by here the list is already known-good.
     */
    languages?: readonly string[],
  ): Promise<EnrichmentMetrics> {
    const { matched } = selectProviderKeys(this.providerKeys, selectors);
    if (matched.length === 0) return EMPTY_METRICS;

    // Neither read the chunk set nor open this run while the previous run is
    // still completing (bd tea-rags-mcp-71n0p / u3e77) — on `--force-enrichments`,
    // the sync leg's. Its release would evict the worker-side provider state this
    // run's deferred chunk pass reads, and its terminal chunk marker would land
    // under this run's `_run` pointer. A run whose completion never started has
    // nothing to wait for.
    const previousCompletion = this.currentRun?.inFlightCompletion;
    if (previousCompletion) {
      const waitStartedAt = Date.now();
      await previousCompletion;
      pipelineLog.enrichmentPhase("RECOMPUTE_AWAIT_PREVIOUS_RUN", {
        collection: physicalCollectionName,
        durationMs: Date.now() - waitStartedAt,
      });
    }

    // Re-derive the chunk set from the index: the points are stored, this pass
    // rewrites their payload. Timed and reported because it is one blocking read
    // of the whole selected corpus, and a silent phase that long reads as a hang
    // (bd tea-rags-mcp-6aytq).
    const scrollStartedAt = Date.now();
    const stored = await this.scrollStoredChunks(physicalCollectionName, absolutePath, languages);
    pipelineLog.enrichmentPhase("RECOMPUTE_SCROLL", {
      collection: physicalCollectionName,
      chunks: stored.items.length,
      files: stored.fileCount,
      durationMs: Date.now() - scrollStartedAt,
      ...(languages && languages.length > 0 ? { languages: [...languages] } : {}),
    });
    if (stored.items.length === 0) return EMPTY_METRICS;

    // The recompute's own writes to a provider's per-file store are ADDITIVE —
    // only the repair leg's diffing per-file write (`applyScopedRowDiff`)
    // retires rows — so stale edge rows written by older resolver code survive
    // every recompute on unchanged files (bd tea-rags-mcp-cneu7: phantom
    // cross-language method edges lived through two `--force-enrichments
    // codegraph` runs on taxdome, 2026-09-21). Route the selected STORE
    // providers through a forced repair first, scoped to this run's stored
    // corpus; the scroll/heal/chunk phases below then rebuild payload from the
    // now-fresh edges exactly as before. Git-only selections skip this
    // silently — a provider without a per-file store has nothing to reconcile.
    const forceProviderSet = new Set(
      this.providers.filter((p) => matched.includes(p.key) && p.readPersistedFileHashes).map((p) => p.key),
    );
    if (forceProviderSet.size > 0) {
      // Membership drives the forced repair set; hash values keep the drift
      // check sound for any store provider the selectors did not force, using
      // the hashes the sync leg's repair captured. Unknown files carry "" —
      // under force the value is never compared.
      const hashesBeforeForcedRepair = this.runContentHashes;
      const eligibilityMap = new Map(
        [...stored.chunkMap.keys()].map((relPath) => [relPath, hashesBeforeForcedRepair?.get(relPath) ?? ""]),
      );
      pipelineLog.enrichmentPhase("RECOMPUTE_FORCED_PROVIDER_REPAIR", {
        providers: [...forceProviderSet],
        files: eligibilityMap.size,
      });
      await this.runRepairPass(physicalCollectionName, absolutePath, eligibilityMap, undefined, forceProviderSet);
      // The synthetic eligibility map must not DISPLACE the run's hash stamp:
      // `runRepairPass` captures its `scanned` as `runContentHashes`, and this
      // run's finalize stamps that map onto every `cg_symbols_files` row — a
      // `""` stamp never converges and the next incremental repairs the whole
      // corpus (the o317j defect class). Restore what the sync leg captured.
      // With NO prior map (a direct recompute call, no sync leg), keep the
      // eligibility map instead of restoring `undefined`: the provider keeps
      // the LAST map it was handed (`bindRunState` assigns only on a truthy
      // one), so an undefined restore would leave the synthetic map as the
      // sole stamp on whatever worker the repair pinned — and none on the
      // others, which is exactly the partition-vs-single asymmetry the
      // language-affinity parity test catches. A defined map rebinds every
      // dispatch, keeping all workers symmetric.
      this.runContentHashes = hashesBeforeForcedRepair ?? eligibilityMap;
    }

    // `languages` reaches the run itself, not just the scroll: the terminal
    // marker is judged on the run's own scope (bd tea-rags-mcp-9dg6s). Every
    // stored point of those languages is fed below, so the run resolves their
    // whole corpus (bd tea-rags-mcp-xpmwg).
    const run = this.beginRun(
      recomputeRunSpec({
        absolutePath,
        collection: physicalCollectionName,
        fileCount: stored.fileCount,
        onlyProviderKeys: matched,
        languages: languages ?? ALL_LANGUAGES,
        // Known before the first batch — the one run that can say so, which is
        // what lets the executor split it by language (bd tea-rags-mcp-sgo8v).
        runRelPaths: [...stored.chunkMap.keys()],
      }),
    );
    // File phase, in the same bounded batches the live pipeline uses, so a
    // whole-repo recompute cannot hand a provider one enormous dispatch.
    for (let i = 0; i < stored.items.length; i += RECOMPUTE_BATCH_SIZE) {
      this.onChunksStored(run, stored.items.slice(i, i + RECOMPUTE_BATCH_SIZE));
    }
    // Chunk phase, then the same completion sequence a normal run ends with —
    // which is what makes `finalizeSignals` (and codegraph's `cg_run_stats`
    // write) fire, and what fills the RunState metrics the CLI reports.
    this.startChunkEnrichment(run, stored.chunkMap);
    return this.awaitCompletion(run);
  }

  /**
   * Read every enrichable point of the collection back as chunk items.
   *
   * Mirrors what the chunk pipeline would have handed the coordinator during a
   * normal run: one `ChunkItem` per point for the file phase, plus the
   * path-keyed lookup the chunk phase consumes. `content` stays empty — no
   * enrichment provider reads it, and shipping it would pull the whole corpus
   * through memory for nothing.
   *
   * `metadata.filePath` is ABSOLUTE, matching what the chunk pipeline emits:
   * the file phase re-derives the repo-relative path against the provider's
   * effective root, so handing it an already-relative path yields `../…`.
   */
  private async scrollStoredChunks(
    collectionName: string,
    absolutePath: string,
    languages?: readonly string[],
  ): Promise<{ items: ChunkItem[]; chunkMap: Map<string, ChunkLookupEntry[]>; fileCount: number }> {
    const root = absolutePath.endsWith("/") ? absolutePath.slice(0, -1) : absolutePath;
    // Narrowing here rather than after the read is the point of the flag: a
    // post-filter would still pull every point of the corpus through memory.
    // An EMPTY list means "no restriction" — `match: { any: [] }` selects
    // nothing in Qdrant, which would turn the run into a silent no-op that
    // still reports success.
    const languageFilter =
      languages && languages.length > 0 ? { must: [{ key: "language", match: { any: [...languages] } }] } : {};
    const points = await this.qdrant.scrollFiltered(
      collectionName,
      {
        ...languageFilter,
        must_not: [...servicePointExclusions(), { is_empty: { key: "relativePath" } }],
      },
      RECOMPUTE_SCROLL_HARD_CAP,
      undefined,
      ["relativePath", "startLine", "endLine", "symbolId"],
    );

    const items: ChunkItem[] = [];
    const chunkMap = new Map<string, ChunkLookupEntry[]>();
    for (const point of points) {
      const relativePath = typeof point.payload?.relativePath === "string" ? point.payload.relativePath : null;
      if (!relativePath) continue;
      const startLine = typeof point.payload?.startLine === "number" ? point.payload.startLine : 0;
      const endLine = typeof point.payload?.endLine === "number" ? point.payload.endLine : 0;
      const chunkId = String(point.id);
      // The chunker's symbolId is the codegraph chunk-owner rule's anchor (bd
      // tea-rags-mcp-9i2ow); a block chunk has none.
      const symbolIdField = typeof point.payload?.symbolId === "string" ? { symbolId: point.payload.symbolId } : {};

      items.push({
        type: "upsert",
        chunkId,
        chunk: { content: "", startLine, endLine, metadata: { filePath: `${root}/${relativePath}`, ...symbolIdField } },
      } as unknown as ChunkItem);

      const entries = chunkMap.get(relativePath) ?? [];
      entries.push({ chunkId, startLine, endLine, ...symbolIdField });
      chunkMap.set(relativePath, entries);
    }

    return { items, chunkMap, fileCount: chunkMap.size };
  }

  /**
   * Begin a new enrichment run and hand back its handle. Non-blocking; call
   * before pipeline.start(). Builds a fresh RunState, inits the phases and writes
   * the `_run` pointer — there is no whole-repo prefetch, file enrichment streams
   * per batch via onChunksStored. The handle is the run's only address: a call
   * made for this run reaches it even after a newer `beginRun` (bd
   * tea-rags-mcp-39xca.3); `whenComplete` alone still speaks for the latest run.
   *
   * What the run is asked to do comes from `spec`; build it with the factory
   * for the entry point that opens the run (`run-spec.ts`).
   */
  beginRun(spec: EnrichmentRunSpec): EnrichmentRunHandle {
    const {
      absolutePath,
      collection: physicalCollectionName,
      crossPass,
      fileCount,
      onlyProviderKeys,
      ignoreFilter,
    } = spec;
    // Never CLEARS the hashes: omitted keeps what `runRepairPass` captured, or
    // the incremental path would lose its own stamp (bd tea-rags-mcp-o317j).
    if (spec.contentHashes) this.runContentHashes = spec.contentHashes;

    // Build a fresh RunState. Per-run instances guarantee old promise closures
    // mutate their orphaned RunState, never the current one.
    const runState = this.createRunState(spec);
    const { runCoverage } = runState;
    this.currentRun = runState;
    this.runStates.set(runState.handle, runState);

    // Wire the applier-site chokepoint: every apply batch (file, chunk, finalize,
    // backfill) calls onApply. This covers ALL apply paths — streaming, post-flush
    // enrichRemaining, deferred codegraph, recovery — from one place. Two
    // consumers: the throttled `_run` heartbeat and the per-run progress sink.
    runState.applier.onApply = (event) => {
      if (physicalCollectionName) this.maybeHeartbeat(physicalCollectionName, runState);
      this.emitProgress(runState, event);
    };

    if (this._onChunkEnrichmentComplete) {
      runState.chunkPhase.setOnComplete(this._onChunkEnrichmentComplete);
    }

    const runProviders =
      onlyProviderKeys === undefined ? this.providers : this.providers.filter((p) => onlyProviderKeys.includes(p.key));
    runState.contexts = new Map(
      runProviders.map((provider) => {
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

    // yl9tv Task 5b — on a cross-pass run, truncate each provider's input spill
    // + reset its dedup set BEFORE the chunk pass starts feeding extractions.
    // Runs on the MAIN-thread provider instances (same instances `onFileExtraction`
    // calls `acceptExtraction` on); only the codegraph provider implements it.
    if (crossPass && physicalCollectionName) {
      for (const provider of this.providers) provider.beginExtractionRun?.(physicalCollectionName);
    }

    // The executor's run-start seam, mirror of the provider reset above: the
    // worker-pool executor drops the pass-1 fan-out's per-run extracted-path set,
    // so a previous run that never released cannot make this one skip files.
    // `fileCount` travels with it because the fan-out WIDTH is a property of the run,
    // and a declared file set because the language partitions are too.
    this.executor.beginRun?.(runState.handle, fileCount, spec.runRelPaths);

    runState.filePhase.init(
      runState.contexts,
      physicalCollectionName,
      runState.runId,
      runState.startedAt,
      crossPass,
      this.runContentHashes,
      runCoverage,
      runState.languages,
    );
    runState.chunkPhase.init(runState.contexts, physicalCollectionName, runState.startedAt);

    // markRunStart writes ONLY the `_run` pointer ({runId, startedAt,
    // lastProgressAt, providers}) — the single pre-completion write. No
    // per-level in_progress/pending is persisted (terminal-only model). The
    // promise is tracked on the run so awaitCompletion gates on it before the
    // terminal writes, keeping `_run` present before they land.
    runState.markRunStartPromise = physicalCollectionName
      ? this.markerStore
          .markRunStart(physicalCollectionName, [...runState.contexts.keys()], runState.runId, runState.startedAt)
          .catch(() => undefined)
      : Promise.resolve();

    // Hold the codegraph daemon alive for the whole run. Fire-and-forget here
    // (non-blocking begin); `awaitCompletion` awaits the release and calls it
    // in its finally. Gated on having providers + a collection — a provider-
    // less or anonymous run has nothing to keep alive. begin never rejects
    // (guard contract), but .catch keeps a stray rejection from going unhandled.
    runState.daemonReleasePromise =
      physicalCollectionName && this.providers.length > 0
        ? this.daemonGuard.begin(physicalCollectionName).catch(() => NOOP_RELEASE)
        : Promise.resolve(NOOP_RELEASE);
    return runState.handle;
  }

  /**
   * Called per-batch by pipeline callback after chunks are stored in Qdrant,
   * for the run `handle` names. Applies file-level signals and also triggers
   * streaming chunk-level enrichment so git blame runs overlapped with
   * embedding/upsert of later batches — instead of waiting for a single
   * post-flush catch-up.
   */
  onChunksStored(handle: EnrichmentRunHandle, items: ChunkItem[]): void {
    const run = this.runStates.get(handle);
    if (!run) return;
    const { collection: physicalCollectionName, absolutePath } = handle;

    // Accumulate the chunk-level denominator from this batch's chunk count.
    // File-level denominator is grandFileCount (the spec's fileCount — known up
    // front). Chunk total keeps growing per batch.
    if (items.length > 0) {
      run.chunkTotalAccumulated += items.length;
    }

    // One-time per run, only when a deferred provider is present: create every
    // enrichment bar up front in a STABLE order — streaming providers (git) as
    // determinate 0% bars, then deferred ones (codegraph) as indeterminate
    // glyphs, which otherwise pop in at 100% right before completion. Two passes
    // keep streaming-before-deferred regardless of registration order; with
    // streaming providers alone the event stream stays untouched.
    const hasDeferred = [...run.contexts.values()].some((ctx) => ctx.provider.defersChunkEnrichment);
    if (!run.deferredStartEmitted && this.progressCb && hasDeferred) {
      run.deferredStartEmitted = true;
      const cb = this.progressCb;
      const emitStartBars = (providerKey: string, deferred: boolean): void => {
        const totalFinal = !deferred;
        cb({ providerKey, level: "file", applied: 0, total: run.grandFileCount, totalFinal });
        cb({ providerKey, level: "chunk", applied: 0, total: run.chunkTotal, totalFinal });
      };
      for (const [providerKey, ctx] of run.contexts) {
        if (!ctx.provider.defersChunkEnrichment) emitStartBars(providerKey, false);
      }
      for (const [providerKey, ctx] of run.contexts) {
        if (ctx.provider.defersChunkEnrichment) emitStartBars(providerKey, true);
      }
    }

    // Sequence file→chunk PER PROVIDER: a provider's chunk dispatch waits for its
    // OWN file work (git chunk reads the batch's blame), never for another
    // provider's — gating git chunk on codegraph's file extraction starved it (wy5i).
    //
    // bd tea-rags-mcp-7gnre: hand the batch to the chunk dispatcher AT ARRIVAL,
    // with the file work as the dispatch gate. ChunkPhase marks streaming coverage
    // synchronously (so the post-flush snapshot excludes this batch) and defers
    // only the walk; deferring the whole call left late batches walked twice.
    const fileWorkByProvider = run.filePhase.onBatch(physicalCollectionName, absolutePath, items);
    for (const [providerKey, fileDone] of fileWorkByProvider) {
      run.chunkPhase.onBatchProvider(providerKey, physicalCollectionName, absolutePath, items, fileDone);
    }
    // Advance the run-pointer heartbeat on real apply progress (throttled). A
    // hung run stops producing batches → lastProgressAt freezes → the health
    // mapper derives stalled/crashed instead of a stuck in_progress.
    this.maybeHeartbeat(physicalCollectionName, run);
  }

  /**
   * yl9tv cross-pass — called per file by the chunk pass (the file-processor's
   * `onFileExtraction` hook) with the `FileExtraction` of the chunker worker's
   * SINGLE parse. Fans it out to every accepting provider (codegraph), which
   * spills it so its `streamFileBatch` skips the re-parse. Fire-and-forget:
   * writes are serialized and failures swallowed inside the provider.
   *
   * yl9tv Task 3 — on a cross-pass run with an accepting provider, also bumps
   * `codegraphSymbolsApplied` and emits a `codegraph.symbols:symbols` event through
   * the same `progressCb`. Always `totalFinal: false`: the eager node write has no
   * fixed denominator until the cross-pass finishes.
   */
  onFileExtraction(handle: EnrichmentRunHandle, extraction: FileExtraction): void {
    const run = this.runStates.get(handle);
    if (!run) return;
    const physicalCollectionName = handle.collection;
    for (const ctx of run.contexts.values()) {
      ctx.provider.acceptExtraction?.(extraction, { collectionName: physicalCollectionName });
    }
    if (run.crossPass && this.progressCb && this.acceptsExtractions()) {
      run.codegraphSymbolsApplied += 1;
      this.progressCb({
        providerKey: "codegraph.symbols",
        level: "symbols",
        applied: run.codegraphSymbolsApplied,
        total: run.grandFileCount || run.codegraphSymbolsApplied,
        totalFinal: false,
      });
    }
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
  startChunkEnrichment(handle: EnrichmentRunHandle, chunkMap: Map<string, ChunkLookupEntry[]>): void {
    const run = this.runStates.get(handle);
    if (!run) return;
    run.chunkPhase.enrichRemaining(handle.collection, handle.absolutePath, chunkMap);
  }

  /**
   * Register the per-run enrichment progress sink (CLI). Pass `undefined` to
   * disable (MCP path). Must be called before the first batch is stored so the
   * `onApply` wiring (set in `beginRun`) sees it. Idempotent per run.
   */
  setEnrichmentProgress(cb: EnrichmentProgressCallback | undefined): void {
    this.progressCb = cb;
  }

  /**
   * Push the embedding chunk total (`chunksQueued`) for the run `handle` names.
   * The indexing layer calls this as chunking discovers chunks, so git chunk
   * progress divides by the SAME total the embeddings bar uses — a real
   * determinate bar that tracks embeddings, instead of its own lagging stored
   * count. Monotonic in practice (chunksQueued only grows); every run starts at 0.
   */
  setChunkTotal(handle: EnrichmentRunHandle, total: number): void {
    const run = this.runStates.get(handle);
    if (run) run.chunkTotal = total;
  }

  /**
   * Resolve once the current run's background enrichment has settled. Reuses the
   * single in-flight `awaitCompletion` (via the run's donePromise) — does NOT
   * start a second completion pass. Resolves immediately when there is no active
   * run or the run has no providers (donePromise is never resolved in that case).
   * Never rejects: a failed enrichment is reported through the terminal markers,
   * not by throwing here.
   */
  async whenComplete(): Promise<void> {
    const run = this.currentRun;
    if (!run || run.contexts.size === 0) return;
    await run.donePromise.catch(() => undefined);
  }

  /**
   * Forward an apply event from the applier as an enrichment-progress callback
   * invocation. The applier now emits CUMULATIVE applied values per
   * (providerKey, level):
   * - file level: distinct files processed (Set-deduped) → total = grandFileCount,
   *   always final (the scan knows the file count up front).
   * - chunk level: running chunk overlay sum → total = the pushed embedding chunk
   *   total (`chunkTotal`, the same denominator embeddings uses), falling back to
   *   the accumulated stored count before the first push. Determinate as soon as
   *   there is a non-zero total — git chunk is a real bar, not glyphs.
   *
   * We SET (not accumulate) applied — the applier already did the accumulation.
   */
  private emitProgress(run: RunState, event: EnrichmentApplyEvent): void {
    if (!this.progressCb) return;
    const key = `${event.providerKey}:${event.level}`;
    const isFile = event.level === "file";
    // chunkTotal (chunksQueued) leads the stored count; max keeps the denominator
    // honest if a stored batch races ahead of the latest push.
    const total = isFile ? run.grandFileCount : Math.max(run.chunkTotal, run.chunkTotalAccumulated);
    const totalFinal = isFile ? true : total > 0;
    run.progress.set(key, { applied: event.applied, total });
    this.progressCb({ providerKey: event.providerKey, level: event.level, applied: event.applied, total, totalFinal });
  }

  /**
   * Wait for all in-flight enrichment work of the run `handle` names to complete
   * across all providers, then close that run — even when a newer run has begun.
   *
   * The completion is recorded on the run BEFORE the first await, so a caller
   * that fires this and moves on — the pipeline does — has already made it
   * visible to `recomputeEnrichments` by the time control returns.
   */
  async awaitCompletion(handle: EnrichmentRunHandle): Promise<EnrichmentMetrics> {
    const run = this.runStates.get(handle);
    if (!run || run.contexts.size === 0) return EMPTY_METRICS;
    const physicalCollectionName = handle.collection;
    const completion = this.completeRun(run, physicalCollectionName);
    const inFlight = completion.then(
      () => undefined,
      () => undefined,
    );
    run.inFlightCompletion = inFlight;
    this.trackInFlightCompletion(physicalCollectionName, inFlight);
    try {
      return await completion;
    } finally {
      if (run.inFlightCompletion === inFlight) run.inFlightCompletion = undefined;
    }
  }

  /**
   * Resolve once every completion in flight on `collectionName` has settled —
   * executor and daemon releases included. Never rejects, and resolves at once
   * when none is in flight, including for a run whose completion never started
   * (bd tea-rags-mcp-62pgi). An index operation holds its collection until this
   * settles for the collection it wrote.
   */
  async whenCompletionsSettled(physicalCollectionName: PhysicalCollectionName): Promise<void> {
    const inFlight = this.inFlightCompletionsByCollection.get(physicalCollectionName);
    if (inFlight) await Promise.all([...inFlight]);
  }

  private trackInFlightCompletion(collectionName: string, inFlight: Promise<void>): void {
    const completions = this.inFlightCompletionsByCollection.get(collectionName) ?? new Set<Promise<void>>();
    completions.add(inFlight);
    this.inFlightCompletionsByCollection.set(collectionName, completions);
    void inFlight.then(() => {
      completions.delete(inFlight);
      if (completions.size === 0 && this.inFlightCompletionsByCollection.get(collectionName) === completions) {
        this.inFlightCompletionsByCollection.delete(collectionName);
      }
    });
  }

  /** The completion sequence proper for `run`, ending with the executor and daemon releases. */
  private async completeRun(run: RunState, physicalCollectionName: PhysicalCollectionName): Promise<EnrichmentMetrics> {
    // Block until the run's `_run` pointer has persisted, so the terminal
    // writes (which carry this run's runId) land against a present run-pointer
    // and the health mapper's runId comparison is meaningful.
    await run.markRunStartPromise;
    try {
      const metrics = await run.completion.run(
        physicalCollectionName,
        run.contexts,
        run.startTime,
        // `run.languages`, not `this.currentRun` — the terminal count is scoped
        // by the run being closed out, even if a newer run has already begun.
        async (targetPhysicalCollectionName, provider, level) =>
          this.countSettledUnenriched(targetPhysicalCollectionName, provider, level, run.languages),
        run.startedAt,
        run.runId,
      );
      // Release per-collection executor state: a no-op inline (one shared
      // provider across concurrent runs); the worker pool fans out `release` and
      // drops the affinity binding — unless a newer run on the collection has
      // begun, which still reads that state (bd tea-rags-mcp-39xca.3). Failures
      // are swallowed inside the executor: release MUST NOT regress a good run.
      const providers = Array.from(run.contexts.values()).map((ctx) => ctx.provider);
      await this.executor.releaseRun(providers, run.handle);
      // The run's whole-collection work (bd tea-rags-mcp-vtuu4): on the MAIN
      // thread, once, after every provider finished writing and the executor
      // released the worker's run state — the codegraph worker's whole-project
      // `ts.Program` included. It used to run inside the codegraph finalize, in
      // the worker, beside that Program, and the co-change build on top of it
      // ran a 17k-file TypeScript repository's worker out of heap right after
      // the file finalize. Only the run's own providers: a recompute that did
      // not open codegraph owes it nothing, as its finalize never ran either.
      await this.completeCollectionOf(providers, run.handle.absolutePath, physicalCollectionName);
      run.resolveDone(metrics);
      return metrics;
    } catch (error) {
      run.rejectDone(error);
      throw error;
    } finally {
      // The cross-pass input spill lives for ONE run, but it is named after the
      // physical generation, so a run that never reached the worker's drain (a
      // failed completion, a provider whose prefetch failed and was skipped)
      // leaves it where no later run truncates it once the alias moves on —
      // one full-corpus NDJSON per abandoned generation. Discard it on every
      // path; after a successful drain it is already gone. Mirrors the
      // `beginExtractionRun` call in `beginRun`, on the same instances.
      if (run.crossPass) {
        for (const provider of this.providers) provider.discardExtractionRun?.(physicalCollectionName);
      }
      // Release the daemon keep-alive on EVERY path (success, error, crash).
      // Skipping this would pin the daemon's refcount > 0 forever and defeat
      // its idle shutdown. The release is idempotent and swallows its own
      // errors so it never masks the run's real outcome.
      const release = await run.daemonReleasePromise.catch(() => NOOP_RELEASE);
      await release().catch(() => undefined);
    }
  }

  private createRunState(spec: EnrichmentRunSpec): RunState {
    const applier = new EnrichmentApplier(this.qdrant, undefined, this.providers);
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
      codegraphHeal: this.codegraphHeal,
      codegraphCompaction: this.codegraphCompaction,
    });

    let resolveDone!: (m: EnrichmentMetrics) => void;
    let rejectDone!: (e: unknown) => void;
    const donePromise = new Promise<EnrichmentMetrics>((resolve, reject) => {
      resolveDone = resolve;
      rejectDone = reject;
    });
    // Handled at creation (bd tea-rags-mcp-qiu3o): a failed run reports through its
    // terminal markers, and `whenComplete` attaches only to the CURRENT run, so a
    // superseded run's rejection would otherwise be unhandled (CLI exit 1).
    void donePromise.catch(() => undefined);

    const runId = randomUUID().slice(0, 8);
    return {
      runId,
      handle: Object.freeze({ runId, collection: spec.collection, absolutePath: spec.absolutePath }),
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
      crossPass: spec.crossPass,
      languages: spec.scope.languages,
      runCoverage: runCoverageOf(spec.scope),
      grandFileCount: spec.fileCount,
      chunkTotalAccumulated: 0,
      chunkTotal: 0,
      deferredStartEmitted: false,
      codegraphSymbolsApplied: 0,
      progress: new Map(),
    };
  }

  /**
   * Count chunks the marker should call unenriched, waiting for the count to
   * SETTLE rather than for a fixed grace period (bd tea-rags-mcp-9dg6s).
   *
   * Reads until two consecutive reads agree (or one reads 0, already ground
   * truth), bounded by {@link SETTLE_POLL_DELAYS_MS}, which carries the schedule
   * and its rationale. A count that is not moving costs one extra read.
   *
   * A read that throws degrades rather than aborts: it yields the last good
   * value, which also ends the loop (the values agree). Completion must not
   * fail because a count failed — the run's work is already written.
   *
   * @param languages Restrict the count to these languages; empty = whole
   * collection. A language-restricted run must not be judged on chunks it was
   * explicitly told to skip.
   */
  private async countSettledUnenriched(
    collectionName: string,
    provider: EnrichmentProvider,
    level: "file" | "chunk",
    languages: readonly string[] = [],
  ): Promise<number> {
    const { recovery } = this;
    if (!recovery) return 0;

    const read = async (fallback: number): Promise<number> =>
      recovery.countUnenriched(collectionName, provider, level, languages).catch(() => fallback);

    let settled = await read(0);
    // The overwhelming common case: a healthy run reads 0 first and pays no
    // sleep at all.
    if (settled === 0) return 0;

    for (const delayMs of SETTLE_POLL_DELAYS_MS) {
      await new Promise((resolve) => setTimeout(resolve, delayMs));
      const next = await read(settled);
      if (next === 0) return 0;
      if (next === settled) return next;
      settled = next;
    }
    return settled;
  }
}

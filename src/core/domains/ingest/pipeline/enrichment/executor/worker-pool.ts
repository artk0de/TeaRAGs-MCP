/**
 * WorkerPoolEnrichmentExecutor — Phase 2 of the unified-enrichment-worker-pool
 * plan. Routes provider method invocations through a `WorkerDispatchPool` backed
 * by a `ThreadTransport` (`worker_threads`), with collection-affinity routing for stateful providers
 * (codegraph) and graceful inline fallback for providers that have no
 * `workerDescriptor` declared.
 *
 * Threading model:
 *
 *   - Each request maps to ONE worker via the descriptor's `dispatch` field:
 *     * "stateless" → no routingKey → any free thread (round-robin). For
 *       truly stateless providers only; never use for providers that share
 *       in-process state across file/chunk/finalize batches.
 *     * "collection-affinity" (codegraph) → routingKey = collectionName →
 *       all calls for the same collection pin to the same thread. The
 *       worker's per-thread provider cache then maintains the in-memory
 *       symbolTable / chunkSymbolByLine across streamFileBatch →
 *       finalizeSignals → deferred buildChunkSignals.
 *     * …or, for a provider declaring `languageAffinity` and a run that
 *       declared its files, routingKey = `<collection>::<language partition>`:
 *       one pinned worker per partition, each absorbing every record and owning
 *       its own (bd tea-rags-mcp-sgo8v). The plan is `language-affinity-plan.ts`,
 *       the finalize barrier and the chunk split `language-affinity-dispatch.ts`.
 *   - Providers WITHOUT `workerDescriptor` (git) are dispatched inline via an
 *     internal `InlineEnrichmentExecutor`. Git's FILE/BLAME phases run
 *     in-process on the composition-root instance: blame cache reuse is
 *     automatic (same instance), postMessage serialization overhead is zero.
 *     The chunk-churn WALK itself, however, now runs on a DEDICATED walk
 *     worker thread owned by ChunkPhase via the provider's
 *     createChunkChurnWalkThread hook (bd tea-rags-mcp-iqpuu) — the walk is
 *     stateless/repo-scoped per batch and needs no collection affinity.
 *     Historical note stands: live taxdome evidence showed collection-affinity
 *     made git enrichment ~4x SLOWER by pinning to 1 worker (removing
 *     parallelism) while per-batch cost is dominated by walkCommits
 *     (git log + cat-file + structuredPatch), not blame.
 *
 * Release path:
 *
 *   `releaseRun(providers, run)` fans out a `release` envelope per
 *   worker-descriptor provider, then drops the WorkerDispatchPool's affinity
 *   binding so the next collection assigned to that routingKey can land on any
 *   free thread — unless a newer run on the same collection has begun since,
 *   in which case that run owns the state and releasing is its job
 *   (bd tea-rags-mcp-39xca.3). Inline-fallback providers are no-ops here
 *   (the inline executor itself does no-op release per spec section 5 —
 *   one shared provider instance across collections, can't safely call
 *   onRelease without wiping state for concurrent runs).
 */
import type {
  ChunkSignalOptions,
  ChunkSignalOverlay,
  EnrichmentExecutor,
  EnrichmentProvider,
  EnrichmentRunHandle,
  FileSignalOptions,
  FileSignalOverlay,
  WorkerEnrichmentDescriptor,
} from "../../../../../contracts/index.js";
import { isDebug } from "../../../../../infra/runtime.js";
import type { ChunkLookupEntry } from "../../../../../types.js";
import { pipelineLog } from "../../infra/debug-logger.js";
import {
  defaultEnrichmentFilesPerThread,
  defaultEnrichmentWorkerCpuProfileDir,
  defaultEnrichmentWorkerHeapSnapshotDir,
  defaultEnrichmentWorkerMemoryLimitMb,
  defaultEnrichmentWorkerStackSizeMb,
  defaultExtractionFanoutEnabled,
  defaultExtractionFanoutShardSize,
  defaultExtractionFanoutWorkers,
  defaultLanguageAffinityEnabled,
} from "../../infra/pool-defaults.js";
import { ThreadTransport } from "../../infra/thread-transport.js";
import { WorkerDispatchPool } from "../../infra/worker-dispatch-pool.js";
import type {
  EnrichmentCallRequest,
  EnrichmentMethod,
  EnrichmentReleaseRequest,
  EnrichmentWorkerRequest,
  EnrichmentWorkerResponse,
} from "../infra/worker-protocol.js";
import { ExtractionFanoutDispatcher } from "./extraction-fanout.js";
import { InlineEnrichmentExecutor } from "./inline.js";
import { LanguageAffinityDispatcher } from "./language-affinity-dispatch.js";
import { planLanguageAffinity, type LanguageAffinityPlan } from "./language-affinity-plan.js";

/**
 * Batches smaller than this go to the affinity worker whole. Splitting a handful
 * of files buys less than the round trips cost, and the incremental reindex
 * path — where a batch IS a handful — is exactly where that matters.
 */
const MIN_PATHS_TO_FAN_OUT = 16;

/**
 * Batches whose extraction records may be resident at once. The file phase fires
 * batches without awaiting them, so this is what stands between a whole-repo
 * recompute and every batch's records being in memory simultaneously. Two, so
 * one batch extracts while the previous one absorbs.
 */
const MAX_IN_FLIGHT_EXTRACTION_BATCHES = 2;

/**
 * Language partitions one collection may be split into (bd tea-rags-mcp-sgo8v):
 * the largest language alone, everything else together. Every partition holds
 * a full copy of the run's pass-1 state, and the window it buys is bounded by
 * the largest language's pass-2 either way — a third partition would split
 * only the side that already finishes first.
 *
 * Two pinned threads do not cost pass-1 a thread at the default pool of 4: a
 * partition worker is idle between its absorbs, and the pool hands an
 * extraction shard to a free PINNED thread when no unpinned one is free
 * (`findFreeStatelessThread`). Measured on a mastodon checkout (1.3k Ruby, 655
 * TypeScript, 181 JavaScript files) on a quiet machine: batch phase 6.2 s with
 * one worker, 5.4 s with two partitions — so the pool default stays 4.
 */
const MAX_LANGUAGE_AFFINITY_PARTITIONS = 2;

/** Compute the routingKey for a provider based on its dispatch mode. */
export function routingKeyFor(descriptor: WorkerEnrichmentDescriptor, collectionName?: string): string | undefined {
  if (descriptor.dispatch === "collection-affinity") return collectionName;
  return undefined;
}

/** Build the per-method call envelope; one helper keeps the four method paths consistent. */
function buildCallRequest(
  descriptor: WorkerEnrichmentDescriptor,
  method: EnrichmentMethod,
  root: string,
  collectionName: string | undefined,
  payload: {
    paths?: string[];
    chunkMap?: Map<string, ChunkLookupEntry[]>;
    options?: FileSignalOptions | ChunkSignalOptions;
  },
): EnrichmentCallRequest {
  const base: EnrichmentCallRequest = {
    type: "call",
    providerModulePath: descriptor.providerModulePath,
    providerFactoryExport: descriptor.providerFactoryExport,
    serializableConfig: descriptor.serializableConfig,
    method,
    root,
  };
  if (collectionName !== undefined) base.collectionName = collectionName;
  if (payload.paths !== undefined) base.paths = payload.paths;
  if (payload.chunkMap !== undefined) base.chunkMap = payload.chunkMap;
  if (payload.options !== undefined) base.options = payload.options;
  return base;
}

export class WorkerPoolEnrichmentExecutor implements EnrichmentExecutor {
  private readonly pool: WorkerDispatchPool<EnrichmentWorkerRequest, EnrichmentWorkerResponse>;
  private readonly inlineFallback = new InlineEnrichmentExecutor();
  /**
   * Pass-1 extraction fan-out, or `null` when it cannot help: the kill-switch is
   * set, or the pool has no worker to spare beyond the pinned one.
   */
  private readonly extractionFanout: ExtractionFanoutDispatcher | null;
  /**
   * The latest run begun on each collection (bd tea-rags-mcp-39xca.3). Worker
   * provider state is cached per collection, not per run, so it is shared by
   * every run on that collection; only the latest run's release may evict it.
   */
  private readonly latestRunIdByCollection = new Map<string, string>();
  /**
   * Per-language affinity (bd tea-rags-mcp-sgo8v): the finalize barrier, the
   * chunk-pass split and the partition releases. File batches go through the
   * fan-out's partitioned mode.
   */
  private readonly languageAffinity: LanguageAffinityDispatcher;
  /** `CODEGRAPH_LANGUAGE_AFFINITY`, read once like the fan-out's own switch. */
  private readonly languageAffinityEnabled = defaultLanguageAffinityEnabled();
  /** The file set a run declared at `beginRun`, per collection — the plan's only input. */
  private readonly runRelPathsByCollection = new Map<string, readonly string[]>();
  /**
   * The plan the collection's current run was given, decided on its FIRST
   * dispatch and kept for the run: a run that began partitioned must finalize,
   * chunk and release partitioned. `null` = collection affinity.
   */
  private readonly languagePlanByCollection = new Map<string, LanguageAffinityPlan | null>();

  constructor(
    private readonly poolSize: number,
    workerPath: string,
    /**
     * Files the run must have per extraction thread before the fan-out spins
     * one up (`INGEST_TUNE_ENRICHMENT_FILES_PER_THREAD`). `poolSize` stays the
     * ceiling; this only says how much work has to exist to reach it.
     */
    private readonly filesPerThread: number = defaultEnrichmentFilesPerThread(),
  ) {
    this.pool = new WorkerDispatchPool<EnrichmentWorkerRequest, EnrichmentWorkerResponse>(
      poolSize,
      // Heap ceiling per worker. This pool disables the liveness timeout below,
      // so the ceiling is the ONLY bound standing between a runaway provider
      // and the machine's memory (bd tea-rags-mcp-8qf86).
      new ThreadTransport<EnrichmentWorkerRequest, EnrichmentWorkerResponse>(
        workerPath,
        defaultEnrichmentWorkerMemoryLimitMb(),
        defaultEnrichmentWorkerCpuProfileDir(),
        // Node's own 4 MB worker default overflows on ts.createProgram's
        // recursive resolution walk at real-corpus scale (bd tea-rags-mcp-2j8s1
        // follow-up) — see defaultEnrichmentWorkerStackSizeMb.
        defaultEnrichmentWorkerStackSizeMb(),
        // Post-mortem for the ceiling above: an OOM kill raises nothing and
        // takes the thread's buffered stdout with it, so a snapshot written on
        // the way down is the only evidence that survives (bd tea-rags-mcp-6aytq).
        defaultEnrichmentWorkerHeapSnapshotDir(),
      ),
      // Worker threads get a fresh module registry, so the debug flag does not
      // survive the boundary on its own — ship it in the init payload or every
      // marker the thread emits (the entire codegraph pass-2 phase) is dropped.
      { debug: isDebug() },
      "EnrichmentPool",
      // Liveness timeout DISABLED (0 = unbounded) for enrichment. A single
      // collection-affinity finalize (codegraph streaming SCC + PageRank) can
      // legitimately run for minutes on a large repo, and recycling that worker
      // mid-build would discard the per-thread symbolTable and corrupt the graph.
      // The per-dispatch hang-guard targets the CHUNKER's tree-sitter NAPI crash
      // (yl9tv), not enrichment, so the enrichment pool opts out explicitly.
      0,
      // Workers ON DEMAND. A collection-affinity provider pins every dispatch to
      // one thread and only the pass-1 fan-out ever leaves it, so on a run too
      // small to fan out the other slots would boot an isolate each and sit
      // there: measured 115-245 MB on ugnest (bd tea-rags-mcp-1v12o.2).
      true,
    );

    const fanoutWorkers = defaultExtractionFanoutWorkers(poolSize);
    this.extractionFanout =
      defaultExtractionFanoutEnabled() && fanoutWorkers >= 1
        ? new ExtractionFanoutDispatcher(async (request, routingKey) => this.pool.dispatch(request, routingKey), {
            workerCount: fanoutWorkers,
            shardSize: defaultExtractionFanoutShardSize(),
            filesPerThread: this.filesPerThread,
            maxInFlightBatches: MAX_IN_FLIGHT_EXTRACTION_BATCHES,
            minPathsToFanOut: MIN_PATHS_TO_FAN_OUT,
          })
        : null;
    this.languageAffinity = new LanguageAffinityDispatcher(async (request, routingKey) =>
      this.pool.dispatch(request, routingKey),
    );
  }

  /**
   * Run-start seam (`EnrichmentCoordinator.beginRun`). Only the fan-out keeps
   * cross-batch state, and only per run: which paths it has already handed to an
   * extraction worker. Clearing it HERE rather than at release means an aborted
   * run cannot leave a set behind that would make the next run skip files.
   */
  beginRun(run: EnrichmentRunHandle, fileCount?: number, runRelPaths?: readonly string[]): void {
    this.latestRunIdByCollection.set(run.collection, run.runId);
    this.extractionFanout?.beginRun(run.collection, fileCount);
    // A new run plans afresh: the partitions are a property of ITS file set.
    this.languagePlanByCollection.delete(run.collection);
    if (runRelPaths) this.runRelPathsByCollection.set(run.collection, runRelPaths);
    else this.runRelPathsByCollection.delete(run.collection);
  }

  async runFileBatch(
    provider: EnrichmentProvider,
    root: string,
    paths: string[],
    options?: FileSignalOptions,
  ): Promise<Map<string, FileSignalOverlay>> {
    if (!provider.workerDescriptor) {
      return this.inlineFallback.runFileBatch(provider, root, paths, options);
    }
    const collectionName = options?.collectionName;
    const request = buildCallRequest(provider.workerDescriptor, "runFileBatch", root, collectionName, {
      paths,
      options,
    });
    const plan = this.languagePlanFor(provider.workerDescriptor, options);
    const routingKey = routingKeyFor(provider.workerDescriptor, collectionName);
    const fanout = this.canFanOutExtraction(provider.workerDescriptor, options) ? this.extractionFanout : null;
    let response: EnrichmentWorkerResponse;
    if (plan && fanout) response = await fanout.runPartitionedFileBatch(request, plan);
    else if (fanout) response = await fanout.runFileBatch(request, routingKey);
    else response = await this.pool.dispatch(request, routingKey);
    this.throwIfErr(response);
    return response.fileOverlay ?? new Map();
  }

  /**
   * The language-affinity plan for this call's collection, or `null` for
   * collection affinity (bd tea-rags-mcp-sgo8v). Decided on the run's FIRST
   * dispatch and cached for the rest of it, so the finalize, the chunk pass and
   * the release of a run that absorbed partitioned are partitioned too.
   *
   * Partitioned only when everything lines up: the kill-switch is off; the
   * provider declared `languageAffinity` on top of a usable extraction fan-out
   * (the partitions are fed by its records); the call is not cross-pass (the
   * chunker already parsed, there are no records); the run declared its files;
   * and the plan finds two sides worth a worker each.
   */
  private languagePlanFor(
    descriptor: WorkerEnrichmentDescriptor,
    options?: FileSignalOptions | ChunkSignalOptions,
  ): LanguageAffinityPlan | null {
    const collectionName = options?.collectionName;
    const affinity = descriptor.languageAffinity;
    // The cache is per collection, so a provider that never declared language
    // affinity must not pick up the plan another provider's first call made.
    if (collectionName === undefined || affinity === undefined) return null;
    const cached = this.languagePlanByCollection.get(collectionName);
    if (cached !== undefined) return cached;
    const runRelPaths = this.runRelPathsByCollection.get(collectionName);
    const eligible =
      this.languageAffinityEnabled && runRelPaths !== undefined && this.canFanOutExtraction(descriptor, options);
    const plan =
      eligible && runRelPaths
        ? planLanguageAffinity({
            collectionName,
            runRelPaths,
            partitionByExtension: affinity.partitionByExtension,
            minFilesPerPartition: this.filesPerThread,
            maxPartitions: Math.min(MAX_LANGUAGE_AFFINITY_PARTITIONS, this.poolSize),
          })
        : null;
    this.languagePlanByCollection.set(collectionName, plan);
    if (eligible) {
      pipelineLog.enrichmentPhase("CODEGRAPH_LANGUAGE_AFFINITY", {
        collection: collectionName,
        partitions: plan
          ? plan.partitions.map((p) => ({
              label: p.label,
              files: p.fileCount,
              completionOwner: p === plan.completionOwner,
            }))
          : [],
      });
    }
    return plan;
  }

  /**
   * Whether THIS batch may have its parse spread over the idle workers.
   *
   * Three conditions, all of them narrow on purpose:
   *  - the provider declared `extractionFanout`, i.e. its `extractFileBatch` is
   *    pure and its `absorbExtractedFiles` owns the stateful half;
   *  - dispatch is `collection-affinity` — a stateless provider already spreads,
   *    and there would be no pinned worker to absorb on;
   *  - the run is NOT cross-pass. There the extraction already happened once, in
   *    the chunker workers, and the provider's batch call is a deliberate no-op;
   *    fanning out would re-parse the whole corpus for nothing.
   */
  private canFanOutExtraction(descriptor: WorkerEnrichmentDescriptor, options?: FileSignalOptions): boolean {
    return (
      this.extractionFanout !== null &&
      descriptor.extractionFanout === true &&
      descriptor.dispatch === "collection-affinity" &&
      options?.crossPass !== true
    );
  }

  async runFileSignalsRecovery(
    provider: EnrichmentProvider,
    root: string,
    paths: string[],
    options?: FileSignalOptions,
  ): Promise<Map<string, FileSignalOverlay>> {
    if (!provider.workerDescriptor) {
      return this.inlineFallback.runFileSignalsRecovery(provider, root, paths, options);
    }
    const collectionName = options?.collectionName;
    const request = buildCallRequest(provider.workerDescriptor, "runFileSignalsRecovery", root, collectionName, {
      paths,
      options,
    });
    const routingKey = routingKeyFor(provider.workerDescriptor, collectionName);
    const response = await this.pool.dispatch(request, routingKey);
    this.throwIfErr(response);
    return response.fileOverlay ?? new Map();
  }

  async runChunkBatch(
    provider: EnrichmentProvider,
    root: string,
    chunkMap: Map<string, ChunkLookupEntry[]>,
    options?: ChunkSignalOptions,
  ): Promise<Map<string, Map<string, ChunkSignalOverlay>>> {
    if (!provider.workerDescriptor) {
      return this.inlineFallback.runChunkBatch(provider, root, chunkMap, options);
    }
    const collectionName = options?.collectionName;
    const request = buildCallRequest(provider.workerDescriptor, "runChunkBatch", root, collectionName, {
      chunkMap,
      options,
    });
    const plan = this.languagePlanFor(provider.workerDescriptor, options);
    const response = plan
      ? await this.languageAffinity.runChunkBatch(request, plan)
      : await this.pool.dispatch(request, routingKeyFor(provider.workerDescriptor, collectionName));
    this.throwIfErr(response);
    return response.chunkOverlay ?? new Map();
  }

  async runFinalize(
    provider: EnrichmentProvider,
    root: string,
    options?: FileSignalOptions,
  ): Promise<Map<string, FileSignalOverlay>> {
    if (!provider.workerDescriptor) {
      return this.inlineFallback.runFinalize(provider, root, options);
    }
    const collectionName = options?.collectionName;
    const request = buildCallRequest(provider.workerDescriptor, "runFinalize", root, collectionName, { options });
    const plan = this.languagePlanFor(provider.workerDescriptor, options);
    const response = plan
      ? await this.languageAffinity.runFinalize(request, plan)
      : await this.pool.dispatch(request, routingKeyFor(provider.workerDescriptor, collectionName));
    this.throwIfErr(response);
    return response.fileOverlay ?? new Map();
  }

  async releaseRun(providers: EnrichmentProvider[], run: EnrichmentRunHandle): Promise<void> {
    const { collection } = run;
    const latestRunId = this.latestRunIdByCollection.get(collection);
    // A newer run on this collection is still reading the pinned provider state;
    // evicting it now would hand that run an empty symbol table mid-flight.
    if (latestRunId !== undefined && latestRunId !== run.runId) return;
    this.latestRunIdByCollection.delete(collection);
    const plan = this.languagePlanByCollection.get(collection) ?? null;
    this.languagePlanByCollection.delete(collection);
    this.runRelPathsByCollection.delete(collection);
    await Promise.all(
      providers.map(async (provider) => {
        const descriptor = provider.workerDescriptor;
        // Inline-fallback providers don't have worker-side state to release.
        // Calling provider.onRelease here would mirror the inline executor's
        // no-op rationale (shared instance across collections — wiping
        // state would break concurrent runs). Skip entirely.
        if (!descriptor) return;
        // A partitioned run pinned one worker per partition and never the
        // collection key itself, so it releases exactly those — dispatching a
        // release to the unbound collection key would pin (and spawn) a worker
        // only to evict nothing.
        if (plan && descriptor.languageAffinity) {
          await this.languageAffinity.release(descriptor.providerModulePath, collection, plan);
          for (const partition of plan.partitions) this.pool.releaseAffinity(partition.routingKey);
          return;
        }
        const request: EnrichmentReleaseRequest = {
          type: "release",
          providerModulePath: descriptor.providerModulePath,
          collectionName: collection,
        };
        const routingKey = routingKeyFor(descriptor, collection);
        try {
          await this.pool.dispatch(request, routingKey);
        } catch (err) {
          // Release failures are non-fatal — bounded memory wins over
          // perfect cleanup (spec section 5). The next index pass rebuilds
          // the provider from scratch.
          process.stderr.write(
            `[WorkerPoolEnrichmentExecutor] release failed for ${descriptor.providerModulePath}: ${
              (err as Error).message
            }\n`,
          );
        }
        // Drop the affinity binding so the next collection assigned to
        // this routingKey can land on any free thread. No-op when routingKey
        // is undefined (stateless dispatch).
        if (routingKey !== undefined) this.pool.releaseAffinity(routingKey);
      }),
    );
    // Drop the fan-out's per-collection bookkeeping with the binding it belongs
    // to. `beginRun` is what guarantees a fresh run starts clean; this is the
    // memory half of the same lifecycle.
    this.extractionFanout?.releaseCollection(collection);
  }

  async shutdown(): Promise<void> {
    await this.pool.shutdown();
  }

  private throwIfErr(response: EnrichmentWorkerResponse): void {
    if (response.error) {
      throw new Error(`enrichment worker error: ${response.error}`);
    }
  }
}

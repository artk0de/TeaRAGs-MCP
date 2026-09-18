/**
 * ExtractionFanoutDispatcher — spreads a collection-affinity provider's pass-1
 * extraction over the workers its affinity binding leaves idle.
 *
 * The problem it solves is measured, not theoretical. A codegraph recompute
 * pins every dispatch for one collection to ONE enrichment worker (routingKey =
 * collectionName), and on taxdome the other three sat 99.96% idle while that
 * one worker parsed 8,811 Ruby files (18.8s) and 10,476 TypeScript files
 * (29.4s) one after another. Parse + walk is per-file independent work with no
 * dependency on anything the pinned worker accumulates, so it is the one stage
 * of the run that can legitimately leave that thread.
 *
 * What moves and what does not:
 *
 *   - MOVES: `extractFileBatch` — parse + walk, dispatched with NO routingKey
 *     so the pool's `findFreeStatelessThread` prefers an UNPINNED worker.
 *   - STAYS: `absorbExtractedFiles` — symbol table, durable node defs,
 *     run-global merge, spill append — dispatched with the provider's normal
 *     affinity key. Every DuckDB write and every piece of run state therefore
 *     still happens on exactly one thread, which is the invariant the affinity
 *     binding exists for.
 *
 * Three things the pool cannot do for us, and so live here:
 *
 *   1. **Per-run dedup.** The file phase batches CHUNKS, and a recompute reads
 *      them back in Qdrant scroll (≈ point-id) order, so one file's chunks are
 *      scattered across many batches. The provider's own `extracted` set used
 *      to absorb that redundancy AFTER the parse; once the parse happens
 *      elsewhere the filtering has to happen BEFORE dispatch or the same file
 *      is parsed once per batch it appears in.
 *   2. **Bounded in-flight units.** Batches are fired without being awaited, so
 *      without a bound every batch's records would be resident at once — the
 *      exact memory the on-disk spill exists to avoid. A unit holds its permit
 *      until its absorb resolves, so extraction of the next batch overlaps the
 *      absorb of the current one and no more.
 *   3. **Admission-ordered absorb.** Shards finish out of order. The run-global
 *      maps the absorb feeds are last-write-wins, so the absorb sequence is
 *      chained in the order batches were ADMITTED, reproducing exactly the
 *      order the single-threaded path had.
 */
import type { FileExtraction } from "../../../../../contracts/types/codegraph.js";
import type { FileExtractionPass1Telemetry } from "../../../../../contracts/types/provider.js";
import { Semaphore } from "../../../../../infra/semaphore.js";
import type {
  EnrichmentCallRequest,
  EnrichmentWorkerRequest,
  EnrichmentWorkerResponse,
} from "../infra/worker-protocol.js";
import type { LanguageAffinityPartition, LanguageAffinityPlan } from "./language-affinity-plan.js";

/** The pool dispatch the fan-out drives. Injected so the split logic is testable without threads. */
export type ExtractionFanoutDispatch = (
  request: EnrichmentWorkerRequest,
  routingKey?: string,
) => Promise<EnrichmentWorkerResponse>;

export interface ExtractionFanoutOptions {
  /**
   * CEILING on the workers a single batch may be spread over. Zero (or less)
   * disables the fan-out entirely — every batch goes to the affinity worker as
   * before. The width a given run actually uses is this ceiling bounded by that
   * run's own file count (see `filesPerThread`).
   */
  workerCount: number;
  /**
   * Files the run must have per extraction thread before that thread is worth
   * spinning up. Omitted (or non-positive) leaves the width at `workerCount`
   * for every run — the pre-bound behaviour.
   */
  filesPerThread?: number;
  /** Upper bound on paths per extract message, so one frame stays bounded. */
  shardSize: number;
  /** Batches whose records may be resident at once. */
  maxInFlightBatches: number;
  /** Below this many NEW paths a batch is not worth splitting. */
  minPathsToFanOut: number;
}

/** Sentinel for a dispatch with no collection (direct/test callers). */
const NO_COLLECTION = "__direct__";

/**
 * Cut `paths` into shards: at most one per worker while that keeps shards under
 * `shardSize`, otherwise as many `shardSize` shards as it takes. Concatenating
 * the shards in index order reproduces `paths` exactly — that is what keeps the
 * absorb order equal to the batch's own path order.
 */
export function splitExtractionShards(paths: string[], workerCount: number, shardSize: number): string[][] {
  const perShard = Math.max(1, Math.min(shardSize, Math.ceil(paths.length / Math.max(1, workerCount))));
  const shards: string[][] = [];
  for (let start = 0; start < paths.length; start += perShard) {
    shards.push(paths.slice(start, start + perShard));
  }
  return shards;
}

/**
 * Extraction threads a run of `fileCount` files earns, beyond the affinity
 * worker it already has.
 *
 * `clamp(ceil(fileCount / filesPerThread), 1, maxWorkerCount + 1)` threads in
 * total, minus the pinned one. So a run below a single thread's share keeps its
 * parse where the absorb already is, and a run large enough reaches the
 * configured ceiling exactly as before. An UNKNOWN size (0/undefined — callers
 * that never counted, e.g. `runFinalizeOnly`) is not evidence of a small run,
 * so it keeps the full configured width rather than silently narrowing.
 */
export function extractionFanoutWorkerCount(
  fileCount: number | undefined,
  filesPerThread: number,
  maxWorkerCount: number,
): number {
  const ceiling = Math.max(0, maxWorkerCount);
  if (ceiling === 0) return 0;
  if (filesPerThread <= 0) return ceiling;
  if (fileCount === undefined || fileCount <= 0) return ceiling;
  const threads = Math.min(Math.max(1, Math.ceil(fileCount / filesPerThread)), ceiling + 1);
  return threads - 1;
}

/**
 * Fold one unit's per-language attribution into the batch total: `ms` by MAX
 * (the units ran concurrently, so their walls overlap — summing would report
 * several workers' seconds as if one worker had spent them), `files` by SUM
 * (each file is parsed by exactly one unit, so the count stays exact).
 */
export function mergePass1Telemetry(
  into: Record<string, FileExtractionPass1Telemetry>,
  from: Record<string, FileExtractionPass1Telemetry> | undefined,
): void {
  for (const [language, unit] of Object.entries(from ?? {})) {
    const total = into[language];
    if (!total) {
      into[language] = { ms: unit.ms, files: unit.files };
      continue;
    }
    total.ms = Math.max(total.ms, unit.ms);
    total.files += unit.files;
  }
}

export class ExtractionFanoutDispatcher {
  /** Paths already handed out for extraction this run, per collection. */
  private readonly dispatchedPaths = new Map<string, Set<string>>();
  /**
   * Tail of each absorb chain, per collection — reserved at call time, not at
   * completion. A collection-affinity run has one chain, keyed by the
   * collection; a language-partitioned run has one per partition, keyed by the
   * partition's routing key, so a partition never waits on another's absorb.
   */
  private readonly absorbChains = new Map<string, Map<string, Promise<void>>>();
  private readonly slots: Semaphore;
  /**
   * Extraction workers the CURRENT run may use — the configured ceiling bounded
   * by the run's file count at `beginRun`. Starts at the ceiling so a caller
   * that never begins a run behaves as it did before the bound existed.
   */
  private runWorkerCount: number;

  constructor(
    private readonly dispatch: ExtractionFanoutDispatch,
    private readonly options: ExtractionFanoutOptions,
  ) {
    this.slots = new Semaphore(Math.max(1, options.maxInFlightBatches));
    this.runWorkerCount = Math.max(0, options.workerCount);
  }

  /**
   * Run-start seam: forget which paths were extracted for this collection.
   *
   * The set is per RUN, not per process — a second recompute of the same
   * collection must parse everything again. Resetting here (the coordinator's
   * `beginRun`) rather than at release means an aborted run cannot leave a
   * stale set behind that would silently skip files on the next one.
   *
   * The run's file count sizes the fan-out with it: width is a property of the
   * RUN, not of the process, so a small recompute does not inherit the width a
   * whole-repo index earned.
   */
  beginRun(collectionName?: string, fileCount?: number): void {
    this.dispatchedPaths.delete(keyOf(collectionName));
    this.runWorkerCount = extractionFanoutWorkerCount(
      fileCount,
      this.options.filesPerThread ?? 0,
      this.options.workerCount,
    );
  }

  /** Drop a finished collection's bookkeeping. */
  releaseCollection(collectionName?: string): void {
    const key = keyOf(collectionName);
    this.dispatchedPaths.delete(key);
    this.absorbChains.delete(key);
  }

  /**
   * Fan a file batch out, or pass it through unchanged when it is not worth
   * splitting. Either way the paths are recorded as dispatched, so a later
   * batch never re-parses them.
   *
   * A path whose extraction FAILED is recorded too: the worker swallows a
   * per-file parse error (one bad file must not fail the run), and retrying it
   * on the next batch would only fail again at the cost of another parse.
   */
  async runFileBatch(request: EnrichmentCallRequest, routingKey?: string): Promise<EnrichmentWorkerResponse> {
    const fresh = this.takeFreshPaths(request.collectionName, request.paths ?? []);
    // Every path in this batch was already handed out — nothing to parse, and
    // the pinned worker has nothing to do with an empty list.
    if (fresh.length === 0) return {};
    if (this.runWorkerCount < 1 || fresh.length < this.options.minPathsToFanOut) {
      return this.dispatch({ ...request, paths: fresh }, routingKey);
    }

    const chainKey = routingKey ?? keyOf(request.collectionName);
    const prior = this.chainTail(request.collectionName, chainKey);
    const unit = this.runFanoutUnit(request, fresh, routingKey, prior);
    // Reserve this unit's place in the absorb order NOW, before any await, so
    // the sequence follows admission order rather than whichever shard set
    // happens to finish first. A failed unit must not poison the chain — the
    // next batch still absorbs.
    this.reserveChain(
      request.collectionName,
      chainKey,
      unit.then(
        () => undefined,
        () => undefined,
      ),
    );
    return unit;
  }

  /**
   * A file batch of a LANGUAGE-PARTITIONED run (bd tea-rags-mcp-sgo8v): parse on
   * any free worker as above, then absorb the records on EVERY partition of the
   * plan — each partition owns its own files and mirrors the rest, which is
   * what keeps its symbol table and run-global maps equal to a single worker's.
   *
   * Never passed through unsplit, however small the batch: the records are the
   * one thing every partition needs, and a `runFileBatch` would parse the batch
   * on one partition only. Each partition keeps its own admission-ordered absorb
   * chain, so a partition busy with one unit never holds back another's.
   */
  async runPartitionedFileBatch(
    request: EnrichmentCallRequest,
    plan: LanguageAffinityPlan,
  ): Promise<EnrichmentWorkerResponse> {
    const fresh = this.takeFreshPaths(request.collectionName, request.paths ?? []);
    if (fresh.length === 0) return {};
    // Every partition's place in ITS absorb order is reserved now, before any
    // await — admission order, as on the single-worker path.
    const absorbed: SettledSignal[] = [];
    const priors: Promise<void>[] = [];
    for (const partition of plan.partitions) {
      const signal = settledSignal();
      priors.push(this.chainTail(request.collectionName, partition.routingKey));
      this.reserveChain(request.collectionName, partition.routingKey, signal.settled);
      absorbed.push(signal);
    }
    return this.runPartitionedUnit(request, fresh, plan, priors, absorbed);
  }

  /** Extract in parallel, then absorb once the prior unit's absorb has landed. */
  private async runFanoutUnit(
    request: EnrichmentCallRequest,
    fresh: string[],
    routingKey: string | undefined,
    prior: Promise<void>,
  ): Promise<EnrichmentWorkerResponse> {
    const release = await this.slots.acquire();
    try {
      const { extractions, pass1ByLanguage } = await this.extractShards(request, fresh);
      await prior;
      return await this.dispatch(
        { ...request, method: "absorbExtractedFiles", paths: fresh, extractions, pass1ByLanguage },
        routingKey,
      );
    } finally {
      release();
    }
  }

  /**
   * One partitioned unit: extract once, then absorb on every partition in
   * parallel, each after that partition's previous unit. The slot is held until
   * the LAST partition absorbed, so the records resident at once stay bounded
   * by `maxInFlightBatches` exactly as on the single-worker path.
   */
  private async runPartitionedUnit(
    request: EnrichmentCallRequest,
    fresh: string[],
    plan: LanguageAffinityPlan,
    priors: Promise<void>[],
    absorbed: SettledSignal[],
  ): Promise<EnrichmentWorkerResponse> {
    const release = await this.slots.acquire();
    try {
      const { extractions, pass1ByLanguage } = await this.extractShards(request, fresh);
      const responses = await Promise.all(
        plan.partitions.map(async (partition, index) => {
          try {
            await priors[index];
            return await this.dispatch(
              {
                ...request,
                method: "absorbExtractedFiles",
                affinityPartition: partition.label,
                paths: fresh,
                extractions,
                absorbRoles: extractions.map((e) => (plan.partitionOfPath(e.relPath) === partition ? "own" : "mirror")),
                pass1ByLanguage: telemetryOwnedBy(pass1ByLanguage, partition, plan),
              },
              partition.routingKey,
            );
          } finally {
            absorbed[index].settle();
          }
        }),
      );
      return responses.find((response) => response.error !== undefined) ?? {};
    } finally {
      // An extraction failure never reaches the absorbs above, so the chains are
      // released here too — a doomed unit must not strand the units behind it.
      for (const signal of absorbed) signal.settle();
      release();
    }
  }

  /**
   * Parse `fresh` over the run's extraction width and gather the records, in
   * the batch's own path order, with their merged pass-1 attribution.
   */
  private async extractShards(
    request: EnrichmentCallRequest,
    fresh: string[],
  ): Promise<{ extractions: FileExtraction[]; pass1ByLanguage: Record<string, FileExtractionPass1Telemetry> }> {
    // `options` is deliberately NOT forwarded to the extraction shards. It is
    // absorb-side data — `contentHashes` alone is one entry per file in the
    // repository, and structured-cloning that map into every shard of every
    // batch would cost more than the parse it accompanies (the same reason
    // o317j stopped attaching it to cross-pass batch calls). Extraction reads
    // nothing from it; `collectionName` it does need is a top-level field.
    const { options: _absorbOnly, ...extractBase } = request;
    const shards = splitExtractionShards(fresh, Math.max(1, this.runWorkerCount), this.options.shardSize);
    const responses = await Promise.all(
      shards.map(async (shard) =>
        // No routingKey: this is the whole point — the pool hands it to a
        // worker the affinity binding has NOT pinned.
        this.dispatch({ ...extractBase, method: "extractFileBatch", paths: shard }, undefined),
      ),
    );

    const extractions: FileExtraction[] = [];
    const pass1ByLanguage: Record<string, FileExtractionPass1Telemetry> = {};
    for (const response of responses) {
      if (response.error) throw new Error(`extraction fan-out: ${response.error}`);
      const batch = response.extractionBatch;
      if (!batch) continue;
      extractions.push(...batch.extractions);
      mergePass1Telemetry(pass1ByLanguage, batch.pass1ByLanguage);
    }
    return { extractions, pass1ByLanguage };
  }

  private async chainTail(collectionName: string | undefined, chainKey: string): Promise<void> {
    return this.absorbChains.get(keyOf(collectionName))?.get(chainKey) ?? Promise.resolve();
  }

  private reserveChain(collectionName: string | undefined, chainKey: string, tail: Promise<void>): void {
    const key = keyOf(collectionName);
    let chains = this.absorbChains.get(key);
    if (!chains) {
      chains = new Map();
      this.absorbChains.set(key, chains);
    }
    chains.set(chainKey, tail);
  }

  /** Paths of this batch not yet handed out this run, marking them as handed out. */
  private takeFreshPaths(collectionName: string | undefined, paths: string[]): string[] {
    const key = keyOf(collectionName);
    let dispatched = this.dispatchedPaths.get(key);
    if (!dispatched) {
      dispatched = new Set();
      this.dispatchedPaths.set(key, dispatched);
    }
    const fresh: string[] = [];
    for (const path of paths) {
      if (dispatched.has(path)) continue;
      dispatched.add(path);
      fresh.push(path);
    }
    return fresh;
  }
}

function keyOf(collectionName?: string): string {
  return collectionName ?? NO_COLLECTION;
}

/** A promise that only ever resolves, settled explicitly — an absorb chain link. */
interface SettledSignal {
  settled: Promise<void>;
  settle: () => void;
}

function settledSignal(): SettledSignal {
  let settle!: () => void;
  const settled = new Promise<void>((resolveSettled) => {
    settle = resolveSettled;
  });
  return { settled, settle };
}

/**
 * The share of a unit's pass-1 attribution a partition reports: its own
 * languages, plus — for the completion owner — any language no partition
 * claims. Each language is then reported by exactly one partition, the way a
 * single worker reported all of them.
 */
function telemetryOwnedBy(
  pass1ByLanguage: Record<string, FileExtractionPass1Telemetry>,
  partition: LanguageAffinityPartition,
  plan: LanguageAffinityPlan,
): Record<string, FileExtractionPass1Telemetry> {
  const owned: Record<string, FileExtractionPass1Telemetry> = {};
  for (const [language, telemetry] of Object.entries(pass1ByLanguage)) {
    if (plan.partitionOfLanguage(language) === partition) owned[language] = telemetry;
  }
  return owned;
}

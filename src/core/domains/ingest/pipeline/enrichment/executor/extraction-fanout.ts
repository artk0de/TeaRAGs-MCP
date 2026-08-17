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
import type { FileExtractionPass1Telemetry } from "../../../../../contracts/types/provider.js";
import { Semaphore } from "../../../../../infra/semaphore.js";
import type {
  EnrichmentCallRequest,
  EnrichmentWorkerRequest,
  EnrichmentWorkerResponse,
} from "../infra/worker-protocol.js";

/** The pool dispatch the fan-out drives. Injected so the split logic is testable without threads. */
export type ExtractionFanoutDispatch = (
  request: EnrichmentWorkerRequest,
  routingKey?: string,
) => Promise<EnrichmentWorkerResponse>;

export interface ExtractionFanoutOptions {
  /**
   * Workers a single batch may be spread over. Zero (or less) disables the
   * fan-out entirely — every batch goes to the affinity worker as before.
   */
  workerCount: number;
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
  /** Tail of the per-collection absorb chain — reserved at call time, not at completion. */
  private readonly absorbChains = new Map<string, Promise<void>>();
  private readonly slots: Semaphore;

  constructor(
    private readonly dispatch: ExtractionFanoutDispatch,
    private readonly options: ExtractionFanoutOptions,
  ) {
    this.slots = new Semaphore(Math.max(1, options.maxInFlightBatches));
  }

  /**
   * Run-start seam: forget which paths were extracted for this collection.
   *
   * The set is per RUN, not per process — a second recompute of the same
   * collection must parse everything again. Resetting here (the coordinator's
   * `beginRun`) rather than at release means an aborted run cannot leave a
   * stale set behind that would silently skip files on the next one.
   */
  beginRun(collectionName?: string): void {
    this.dispatchedPaths.delete(keyOf(collectionName));
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
    if (this.options.workerCount < 1 || fresh.length < this.options.minPathsToFanOut) {
      return this.dispatch({ ...request, paths: fresh }, routingKey);
    }

    const prior = this.absorbChains.get(keyOf(request.collectionName)) ?? Promise.resolve();
    const unit = this.runFanoutUnit(request, fresh, routingKey, prior);
    // Reserve this unit's place in the absorb order NOW, before any await, so
    // the sequence follows admission order rather than whichever shard set
    // happens to finish first. A failed unit must not poison the chain — the
    // next batch still absorbs.
    this.absorbChains.set(
      keyOf(request.collectionName),
      unit.then(
        () => undefined,
        () => undefined,
      ),
    );
    return unit;
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
      // `options` is deliberately NOT forwarded to the extraction shards. It is
      // absorb-side data — `contentHashes` alone is one entry per file in the
      // repository, and structured-cloning that map into every shard of every
      // batch would cost more than the parse it accompanies (the same reason
      // o317j stopped attaching it to cross-pass batch calls). Extraction reads
      // nothing from it; `collectionName` it does need is a top-level field.
      const { options: _absorbOnly, ...extractBase } = request;
      const shards = splitExtractionShards(fresh, this.options.workerCount, this.options.shardSize);
      const responses = await Promise.all(
        shards.map(async (shard) =>
          // No routingKey: this is the whole point — the pool hands it to a
          // worker the affinity binding has NOT pinned.
          this.dispatch({ ...extractBase, method: "extractFileBatch", paths: shard }, undefined),
        ),
      );

      const extractions = [];
      const pass1ByLanguage: Record<string, FileExtractionPass1Telemetry> = {};
      for (const response of responses) {
        if (response.error) throw new Error(`extraction fan-out: ${response.error}`);
        const batch = response.extractionBatch;
        if (!batch) continue;
        extractions.push(...batch.extractions);
        mergePass1Telemetry(pass1ByLanguage, batch.pass1ByLanguage);
      }

      await prior;
      return await this.dispatch(
        { ...request, method: "absorbExtractedFiles", paths: fresh, extractions, pass1ByLanguage },
        routingKey,
      );
    } finally {
      release();
    }
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

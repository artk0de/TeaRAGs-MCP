/**
 * Dispatch seam between the enrichment phases and provider execution.
 *
 * The phases (file-phase, chunk-phase, backfiller, recovery, completion-runner)
 * depend on this interface, never on `node:worker_threads` and never on
 * `provider.*` method names directly. Implementations:
 *
 *  - `InlineEnrichmentExecutor` — runs provider methods on the main thread
 *    (today's behavior, what existed before the seam).
 *  - `WorkerPoolEnrichmentExecutor` (Phase 2 of the worker-pool spec) —
 *    dispatches to a `ThreadPool` of `node:worker_threads`, with collection
 *    affinity for stateful providers like codegraph.
 *
 * Signatures mirror `EnrichmentProvider` exactly so swapping the impl is
 * transparent. Return/argument shapes are all plain structured-clone-safe
 * data (Maps of overlays, path arrays, options objects) so they cross the
 * `postMessage` boundary unchanged when the worker-pool impl is wired in.
 *
 * There are TWO file-level methods on purpose:
 *
 *  - `runFileBatch` — the streaming per-batch call site (file-phase). Prefers
 *    `streamFileBatch` when the provider declares it, falls back to
 *    `buildFileSignals({ ...options, paths: batchPaths })`. Mirrors what
 *    `file-phase.ts` did inline before the seam.
 *  - `runFileSignalsRecovery` — the explicit whole-set call site (backfiller,
 *    recovery). Always calls `buildFileSignals({ ...options, paths })`,
 *    bypassing `streamFileBatch`. Backfill/recovery must NOT trigger the
 *    streaming side-effects (codegraph extraction, run sink accumulation)
 *    that `streamFileBatch` runs — they want the pure whole-set semantics.
 */

import type { ChunkLookupEntry } from "./chunker.js";
import type { PhysicalCollectionName } from "./collection-identity.js";
import type {
  ChunkSignalOptions,
  ChunkSignalOverlay,
  EnrichmentProvider,
  FileSignalOptions,
  FileSignalOverlay,
} from "./provider.js";

/**
 * The identity of one enrichment run, handed out by `EnrichmentCoordinator#beginRun`
 * (bd tea-rags-mcp-39xca.3). Every per-run entry takes it, so a call reaches the
 * run that issued it and no other — two runs on one collection can overlap.
 */
export interface EnrichmentRunHandle {
  readonly runId: string;
  /** The PHYSICAL collection the run writes — its markers, heartbeat and per-generation stores. */
  readonly collection: PhysicalCollectionName;
  /** The project root the run resolves provider roots against. */
  readonly absolutePath: string;
}

export interface EnrichmentExecutor {
  /**
   * Run-start seam, called by `EnrichmentCoordinator.beginRun` before any
   * dispatch. Optional: an executor that keeps no cross-batch state omits it.
   *
   * The worker-pool executor uses it to drop the pass-1 fan-out's per-run set of
   * already-extracted paths. That reset belongs at run START, not at release: a
   * run that dies before releasing would otherwise leave a set behind, and the
   * next run would silently skip every file the dead one had claimed.
   *
   * `fileCount` is the run's scanned file count — the same denominator the
   * coordinator's progress events use. The worker-pool executor sizes the
   * fan-out with it, so a run too small to keep extra threads busy never spins
   * them up. Zero/undefined means "not counted", which is NOT the same as small.
   *
   * The run's handle travels with it so the executor knows which run on a
   * collection is the latest — the only one whose `releaseRun` may evict that
   * collection's worker-side state (bd tea-rags-mcp-39xca.3).
   */
  beginRun?: (run: EnrichmentRunHandle, fileCount?: number) => void;

  /**
   * Per-batch file enrichment for the streaming file phase.
   * Prefers `provider.streamFileBatch` when present; otherwise falls back to
   * `provider.buildFileSignals({ ...options, paths })`.
   */
  runFileBatch: (
    provider: EnrichmentProvider,
    root: string,
    paths: string[],
    options?: FileSignalOptions,
  ) => Promise<Map<string, FileSignalOverlay>>;

  /**
   * Whole-set file enrichment with explicit paths (backfiller, recovery).
   * Always calls `provider.buildFileSignals({ ...options, paths })`; never
   * routes through `streamFileBatch` even when the provider declares it.
   */
  runFileSignalsRecovery: (
    provider: EnrichmentProvider,
    root: string,
    paths: string[],
    options?: FileSignalOptions,
  ) => Promise<Map<string, FileSignalOverlay>>;

  /**
   * Chunk enrichment — nested `file → chunkId → overlay`, mirrors
   * `provider.buildChunkSignals`.
   */
  runChunkBatch: (
    provider: EnrichmentProvider,
    root: string,
    chunkMap: Map<string, ChunkLookupEntry[]>,
    options?: ChunkSignalOptions,
  ) => Promise<Map<string, Map<string, ChunkSignalOverlay>>>;

  /**
   * Deferred whole-repo FILE finalize. Empty map when the provider has no
   * `finalizeSignals` method (executor smooths over the optional method).
   */
  runFinalize: (
    provider: EnrichmentProvider,
    root: string,
    options?: FileSignalOptions,
  ) => Promise<Map<string, FileSignalOverlay>>;

  /**
   * Release per-collection in-memory state held on cached worker provider
   * instances, at the end of `run`. Emitted by `EnrichmentCoordinator` once the
   * run's completion sequence has written its terminal markers.
   *
   * Worker-pool executor: a NO-OP when a newer run on the same collection has
   * begun since — that run still reads the same pinned provider state, and its
   * own completion releases it (bd tea-rags-mcp-39xca.3). Otherwise it
   * dispatches `{ type: "release", collectionName }` to the pinned worker for
   * each provider that declared a workerDescriptor. The worker calls
   * `provider.onRelease?.()` on the cached instance and evicts it from
   * `Map<collectionName, providerInstance>`. The pool drops the routingKey →
   * workerIndex affinity binding.
   *
   * Inline executor: NO-OP. The inline path shares one long-lived provider
   * instance across all collections (no per-collection cache). Calling
   * `provider.onRelease?.()` here would wipe state for every concurrent
   * in-flight run on the same provider. The worker-pool executor is the
   * sole place bounded-memory semantics are enforced; inline relies on
   * process lifetime for cleanup.
   */
  releaseRun: (providers: EnrichmentProvider[], run: EnrichmentRunHandle) => Promise<void>;

  /** Release executor resources (worker pool shutdown); no-op for inline. */
  shutdown: () => Promise<void>;
}

/** Release handle returned by `IndexRunDaemonGuard.begin`. Idempotent; never throws. */
export type IndexRunDaemonRelease = () => Promise<void>;

/**
 * Keeps a stateful enrichment backend (codegraph DuckDB daemon) alive for the
 * full duration of one enrichment run — chunk-write AND background enrichment.
 *
 * Why this exists: the codegraph daemon self-terminates after 30s idle, but a
 * force-reindex's chunk-write phase can exceed that window with no daemon
 * socket held, so the daemon idle-dies before worker enrichment connects. The
 * enrichment worker can only CONNECT to the daemon (it rebuilds the provider
 * from a serializable descriptor with no spawn capability), so nothing on the
 * enrichment path revives a dead daemon. `begin` ensures the daemon is alive
 * and holds ONE real keep-alive socket (refs ≥ 1 suppresses idle shutdown);
 * the returned release closes it so the daemon resumes its normal idle
 * lifecycle.
 *
 * Owned by `EnrichmentCoordinator`: `begin` at `beginRun`, release in
 * `awaitCompletion`'s finally — that span is exactly chunk-write + enrichment.
 *
 * No-op implementation is used when codegraph is disabled or in tests.
 */
export interface IndexRunDaemonGuard {
  /**
   * Ensure the daemon is alive and hold a keep-alive connection for the run.
   * MUST resolve (never reject) — a failed keep-alive returns a no-op release
   * and logs, so it never blocks indexing. The returned release MUST be called
   * when the run ends (success, error, or crash) or the daemon never idle-dies.
   */
  begin: (collectionName: PhysicalCollectionName) => Promise<IndexRunDaemonRelease>;
}

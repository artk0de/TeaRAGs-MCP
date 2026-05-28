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
 *  - `runFileSignals` — the explicit whole-set call site (backfiller,
 *    recovery). Always calls `buildFileSignals({ ...options, paths })`,
 *    bypassing `streamFileBatch`. Backfill/recovery must NOT trigger the
 *    streaming side-effects (codegraph extraction, run sink accumulation)
 *    that `streamFileBatch` runs — they want the pure whole-set semantics.
 */

import type { ChunkLookupEntry } from "../../types.js";
import type {
  ChunkSignalOptions,
  ChunkSignalOverlay,
  EnrichmentProvider,
  FileSignalOptions,
  FileSignalOverlay,
} from "./provider.js";

export interface EnrichmentExecutor {
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
  runFileSignals: (
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

  /** Release executor resources (worker pool shutdown); no-op for inline. */
  shutdown: () => Promise<void>;
}

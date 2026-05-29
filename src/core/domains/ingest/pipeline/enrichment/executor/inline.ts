import type {
  ChunkSignalOptions,
  ChunkSignalOverlay,
  EnrichmentExecutor,
  EnrichmentProvider,
  FileSignalOptions,
  FileSignalOverlay,
} from "../../../../../contracts/index.js";
import type { ChunkLookupEntry } from "../../../../../types.js";

/**
 * Main-thread executor: calls provider methods directly.
 *
 * This is the behavior the enrichment phases had before the executor seam
 * existed — extracting it behind the interface is a pure refactor (no
 * behavior change). Used by:
 *
 *  - All unit tests of enrichment phases (deterministic, no worker spawn).
 *  - The `enrichmentExecutor: "inline"` config mode (default until the
 *    worker-pool impl is live-validated).
 *  - As a graceful fallback by the (future) worker-pool executor for
 *    providers that declare no worker descriptor.
 */
export class InlineEnrichmentExecutor implements EnrichmentExecutor {
  async runFileBatch(
    provider: EnrichmentProvider,
    root: string,
    paths: string[],
    options?: FileSignalOptions,
  ): Promise<Map<string, FileSignalOverlay>> {
    if (provider.streamFileBatch) {
      return provider.streamFileBatch(root, paths, options);
    }
    return provider.buildFileSignals(root, { ...options, paths });
  }

  async runFileSignals(
    provider: EnrichmentProvider,
    root: string,
    paths: string[],
    options?: FileSignalOptions,
  ): Promise<Map<string, FileSignalOverlay>> {
    return provider.buildFileSignals(root, { ...options, paths });
  }

  async runChunkBatch(
    provider: EnrichmentProvider,
    root: string,
    chunkMap: Map<string, ChunkLookupEntry[]>,
    options?: ChunkSignalOptions,
  ): Promise<Map<string, Map<string, ChunkSignalOverlay>>> {
    return provider.buildChunkSignals(root, chunkMap, options);
  }

  async runFinalize(
    provider: EnrichmentProvider,
    root: string,
    options?: FileSignalOptions,
  ): Promise<Map<string, FileSignalOverlay>> {
    if (!provider.finalizeSignals) return new Map();
    return provider.finalizeSignals(root, options);
  }

  async releaseCollection(_providers: EnrichmentProvider[], _collection: string): Promise<void> {
    // No-op: inline shares ONE long-lived provider instance across all
    // collections. Calling provider.onRelease?.() here would wipe state for
    // every concurrent in-flight run on the same provider — codegraph's
    // per-collection chunkSymbolByLine entries would all disappear. Bounded
    // memory is the worker-pool executor's concern (it caches providers
    // per (collection, worker) pair and evicts on this signal). Inline
    // relies on natural process-lifetime cleanup.
  }

  async shutdown(): Promise<void> {
    // No-op: nothing to release on the main thread.
  }
}

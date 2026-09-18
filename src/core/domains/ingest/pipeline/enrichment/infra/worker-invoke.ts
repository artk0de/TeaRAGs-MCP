/**
 * What an enrichment worker does with one `call` envelope once it holds the
 * provider — split out of the worker entry (`./worker.ts`) because that module
 * binds `parentPort` and starts diagnostics at import, and this half has to be
 * reachable without a thread: the in-process parity harness of per-language
 * affinity (bd tea-rags-mcp-sgo8v) routes envelopes to provider instances with
 * exactly the dispatch a real worker performs, so the orchestration under test
 * and the one in production cannot drift.
 */

import type { ChunkSignalOptions, EnrichmentProvider } from "../../../../../contracts/types/provider.js";
import type { ChunkLookupEntry } from "../../../../../types.js";
import type { EnrichmentCallRequest, EnrichmentWorkerResponse } from "./worker-protocol.js";

/**
 * The worker's provider-cache key. One provider instance per (module,
 * collection, language partition): two partitions of a collection must never
 * share one, even on the same thread, or one would absorb as its own what the
 * other only mirrors. Stateless calls carry neither and share the `""` slots.
 */
export function enrichmentProviderCacheKey(
  modulePath: string,
  collectionName?: string,
  affinityPartition?: string,
): string {
  return `${modulePath}::${collectionName ?? ""}::${affinityPartition ?? ""}`;
}

/**
 * Strip the non-serializable `concurrencySemaphore` from chunk options.
 *
 * `ChunkSignalOptions.concurrencySemaphore` is a `Semaphore` CLASS INSTANCE on
 * the main thread (a coordinator-shared git-blame limiter). It cannot survive
 * `postMessage`: structured clone copies its enumerable fields but DROPS the
 * prototype `acquire()` method, so it arrives here as a method-less plain
 * object. Passing it through would make the git chunk path call `.acquire()` on
 * a non-function and throw "acquire is not a function" (tea-rags-mcp-2qja).
 *
 * Each worker thread is an independent process of execution, so a cross-batch
 * shared limiter is meaningless here anyway — the provider rebuilds its own
 * in-thread limiter (bounded by its serializable `chunkConcurrency`) when no
 * semaphore is supplied. Removing the field selects exactly that fallback.
 */
function stripWorkerChunkOptions(options: unknown): ChunkSignalOptions | undefined {
  if (options === undefined) return undefined;
  const { concurrencySemaphore: _drop, ...rest } = options as ChunkSignalOptions;
  return rest;
}

/** Dispatch the named EnrichmentExecutor method on the resolved provider. */
export async function invokeEnrichmentMethod(
  provider: EnrichmentProvider,
  request: EnrichmentCallRequest,
): Promise<EnrichmentWorkerResponse> {
  const { method, root, paths, chunkMap, extractions, pass1ByLanguage, absorbRoles, options } = request;
  switch (method) {
    case "extractFileBatch": {
      // Pass-1 fan-out, extraction half. Dispatched WITHOUT a routing key, so
      // this can be any worker — including one that has never seen this
      // collection. That is safe precisely because the method is pure: it
      // parses and returns records, touching no store and no run state.
      if (!provider.extractFileBatch) {
        return { extractionBatch: { extractions: [], pass1ByLanguage: {} } };
      }
      const fileOptions = options;
      return { extractionBatch: await provider.extractFileBatch(root, paths ?? [], fileOptions) };
    }
    case "absorbExtractedFiles": {
      // …and the absorb half, which the executor pins to the collection's
      // worker. A provider that declared the fan-out without this method would
      // silently drop the run's extractions, so say so instead.
      if (!provider.absorbExtractedFiles) {
        throw new Error("enrichment worker: provider declared extractionFanout but has no absorbExtractedFiles");
      }
      const fileOptions = options;
      await provider.absorbExtractedFiles(root, extractions ?? [], { ...fileOptions, pass1ByLanguage, absorbRoles });
      return { fileOverlay: new Map() };
    }
    case "runFileBatch": {
      const fileOptions = options;
      const pathList = paths ?? [];
      const overlay = provider.streamFileBatch
        ? await provider.streamFileBatch(root, pathList, fileOptions)
        : await provider.buildFileSignals(root, { ...fileOptions, paths: pathList });
      return { fileOverlay: overlay };
    }
    case "runFileSignalsRecovery": {
      const fileOptions = options;
      const overlay = await provider.buildFileSignals(root, { ...fileOptions, paths: paths ?? [] });
      return { fileOverlay: overlay };
    }
    case "runChunkBatch": {
      const map = chunkMap ?? new Map<string, ChunkLookupEntry[]>();
      const overlay = await provider.buildChunkSignals(root, map, stripWorkerChunkOptions(options));
      return { chunkOverlay: overlay };
    }
    case "runFinalize": {
      const fileOptions = options;
      if (!provider.finalizeSignals) {
        return { fileOverlay: new Map() };
      }
      const overlay = await provider.finalizeSignals(root, fileOptions);
      return { fileOverlay: overlay };
    }
  }
}

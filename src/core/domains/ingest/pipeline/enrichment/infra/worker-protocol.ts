/**
 * Worker thread message protocol for the enrichment pool.
 *
 * Pure structurally-cloneable types — no runtime, no `domains/trajectory`
 * import — shared by the ingest-side `WorkerPoolEnrichmentExecutor` (which
 * dispatches requests) and the sibling worker ENTRY (`./worker.ts`, which
 * builds providers in-thread via dynamic-import).
 *
 * The worker ENTRY lives in `domains/ingest` (its home domain), so the
 * eslint leaf-domain guard is preserved — no static `domains/trajectory`
 * import. Provider modules are loaded at RUNTIME via dynamic
 * `import(providerModulePath)` where the path arrives as a serializable
 * string in the request envelope. A runtime variable path is invisible
 * to the import guard, so no exemption is needed.
 *
 * The protocol has TWO request variants and one response shape (typed as
 * a discriminated union via optional fields):
 *
 *   call:    invoke a named provider method on a (cached or fresh)
 *            provider instance. Worker caches the instance per
 *            (providerModulePath, collectionName).
 *   release: evict the cached entry; worker invokes `provider.onRelease?.()`
 *            before deleting from the cache. Idempotent — uncached entry
 *            is a benign no-op (released: false).
 */

import type { FileExtraction } from "../../../../../contracts/types/codegraph.js";
import type {
  ChunkSignalOptions,
  ChunkSignalOverlay,
  FileExtractionAbsorbRole,
  FileExtractionFanoutBatch,
  FileExtractionPass1Telemetry,
  FileSignalOptions,
  FileSignalOverlay,
} from "../../../../../contracts/types/provider.js";
import type { ChunkLookupEntry } from "../../../../../types.js";

/**
 * EnrichmentExecutor method names — the dispatch verbs the worker honours.
 *
 * The last two are the pass-1 fan-out pair and are dispatched DIFFERENTLY from
 * the rest: `extractFileBatch` goes out with NO routingKey (any free worker),
 * `absorbExtractedFiles` with the provider's normal affinity key.
 */
export type EnrichmentMethod =
  | "runFileBatch"
  | "runFileSignalsRecovery"
  | "runChunkBatch"
  | "runFinalize"
  | "extractFileBatch"
  | "absorbExtractedFiles";

/**
 * Build-or-reuse a provider on the worker and invoke a method on it.
 * Cache key on the worker side is `(providerModulePath, collectionName ?? "")`.
 */
export interface EnrichmentCallRequest {
  type: "call";
  providerModulePath: string;
  providerFactoryExport: string;
  serializableConfig: unknown;
  /** Routing key. For stateless providers may be undefined; cache then uses "" suffix. */
  collectionName?: string;
  /**
   * The language partition this call belongs to, under per-language affinity
   * (bd tea-rags-mcp-sgo8v). Part of the worker's provider-cache key: two
   * partitions of one collection are two provider instances even when the pool
   * pins both to the same thread. Absent for collection-wide calls.
   */
  affinityPartition?: string;
  method: EnrichmentMethod;
  root: string;
  /** runFileBatch / runFileSignalsRecovery payload. */
  paths?: string[];
  /** runChunkBatch payload. Nested Map is structured-clone-safe. */
  chunkMap?: Map<string, ChunkLookupEntry[]>;
  /**
   * absorbExtractedFiles payload — records another worker already parsed.
   * Plain data by construction (the same shape the codegraph spill serialises),
   * so it crosses the structured-clone boundary unchanged.
   */
  extractions?: FileExtraction[];
  /** absorbExtractedFiles payload — merged pass-1 attribution of the units above. */
  pass1ByLanguage?: Record<string, FileExtractionPass1Telemetry>;
  /**
   * absorbExtractedFiles payload under per-language affinity — which of
   * `extractions` this partition owns, index for index (bd tea-rags-mcp-sgo8v).
   */
  absorbRoles?: FileExtractionAbsorbRole[];
  /** Method-specific options object. Provider reads only the fields it cares about. */
  options?: FileSignalOptions | ChunkSignalOptions;
}

/**
 * Evict the cached provider for (providerModulePath, collectionName).
 * Worker invokes provider.onRelease?.() before delete. Failures inside
 * onRelease are swallowed — bounded memory wins over perfect cleanup
 * (spec section 5).
 */
export interface EnrichmentReleaseRequest {
  type: "release";
  providerModulePath: string;
  collectionName: string;
  /** The language partition whose provider instance to evict (see `EnrichmentCallRequest.affinityPartition`). */
  affinityPartition?: string;
}

/** Shutdown envelope — close port, exit thread cleanly (mirrors chunker worker). */
export interface EnrichmentShutdownRequest {
  type: "shutdown";
}

export type EnrichmentWorkerRequest = EnrichmentCallRequest | EnrichmentReleaseRequest | EnrichmentShutdownRequest;

/**
 * Single response shape — fields are optional and depend on the request kind.
 * - `call` with file method → `fileOverlay` populated, others absent.
 * - `call` with chunk method → `chunkOverlay` populated.
 * - `release` → `released: true` if entry existed, false otherwise.
 * - any failure → `error` populated with the message (other fields absent).
 *
 * Maps round-trip via structured clone unchanged.
 */
export interface EnrichmentWorkerResponse {
  fileOverlay?: Map<string, FileSignalOverlay>;
  chunkOverlay?: Map<string, Map<string, ChunkSignalOverlay>>;
  /** `call` with `extractFileBatch` → the records + their pass-1 attribution. */
  extractionBatch?: FileExtractionFanoutBatch;
  released?: boolean;
  error?: string;
}

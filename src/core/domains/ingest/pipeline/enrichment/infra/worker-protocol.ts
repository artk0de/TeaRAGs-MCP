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

import type {
  ChunkSignalOptions,
  ChunkSignalOverlay,
  FileSignalOptions,
  FileSignalOverlay,
} from "../../../../../contracts/types/provider.js";
import type { ChunkLookupEntry } from "../../../../../types.js";

/** EnrichmentExecutor method names — the four dispatch verbs the worker honours. */
export type EnrichmentMethod = "runFileBatch" | "runFileSignals" | "runChunkBatch" | "runFinalize";

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
  method: EnrichmentMethod;
  root: string;
  /** runFileBatch / runFileSignals payload. */
  paths?: string[];
  /** runChunkBatch payload. Nested Map is structured-clone-safe. */
  chunkMap?: Map<string, ChunkLookupEntry[]>;
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
  released?: boolean;
  error?: string;
}

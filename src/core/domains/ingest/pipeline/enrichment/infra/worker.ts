/**
 * Enrichment worker thread entry point — Phase 2 of the unified-enrichment-
 * worker-pool plan.
 *
 * A worker thread cannot receive the main process's DI graph (functions /
 * native handles are not structured-cloneable across `postMessage`), so each
 * provider is rebuilt in-thread from a serializable `WorkerEnrichmentDescriptor`
 * payload. The provider module is loaded via dynamic `import(modulePath)` where
 * `modulePath` arrives in the request envelope. A runtime variable path is
 * invisible to the eslint leaf-domain guard (`domains/ingest` MUST NOT import
 * `domains/trajectory`), so NO static import + NO exemption is needed. The same
 * pattern is used by `chunker/infra/worker.ts` (the precedent set during
 * domains/language consolidation, see `.claude/rules/domains-language.md`).
 *
 * Provider lifecycle per worker thread:
 *
 *   1. First `call` envelope for (providerModulePath, collectionName) →
 *      dynamic-import the module, look up `providerFactoryExport`, await
 *      `factory(serializableConfig)`, cache the result.
 *   2. Subsequent `call` envelopes with the SAME (providerModulePath,
 *      collectionName) → reuse the cached instance. `serializableConfig` of
 *      later envelopes is IGNORED — the descriptor carried it on the first
 *      build; mutating it across calls would break codegraph's per-run
 *      symbolTable accumulation.
 *   3. `release` envelope → `await provider.onRelease?.()` (swallow errors)
 *      then delete the cache entry. Idempotent: uncached entry returns
 *      `released: false` without error.
 *
 * Protocol (`./worker-protocol.ts`):
 *   Receives: EnrichmentWorkerRequest (call | release | shutdown)
 *   Returns:  EnrichmentWorkerResponse (fileOverlay | chunkOverlay | released | error)
 */

import { parentPort } from "node:worker_threads";

import type {
  ChunkSignalOptions,
  EnrichmentProvider,
  FileSignalOptions,
} from "../../../../../contracts/types/provider.js";
import type { ChunkLookupEntry } from "../../../../../types.js";
import type {
  EnrichmentCallRequest,
  EnrichmentReleaseRequest,
  EnrichmentWorkerRequest,
  EnrichmentWorkerResponse,
} from "./worker-protocol.js";

/**
 * Factory shape — providers expose this as the named export referenced by
 * `WorkerEnrichmentDescriptor.providerFactoryExport`. Worker calls it once per
 * (providerModulePath, collectionName) and caches the result.
 */
type EnrichmentProviderFactory = (config: unknown) => Promise<EnrichmentProvider>;

/** Cache key composes module path with collection name; stateless gets "". */
function cacheKey(modulePath: string, collectionName?: string): string {
  return `${modulePath}::${collectionName ?? ""}`;
}

/** Per-thread provider cache. Survives across calls within the worker lifetime. */
const providerCache = new Map<string, Promise<EnrichmentProvider>>();

/**
 * Lazily build (or reuse) the provider for the given (modulePath, collectionName)
 * pair. Returns a Promise so concurrent calls for the same key share one build.
 */
async function getProvider(
  modulePath: string,
  factoryExport: string,
  serializableConfig: unknown,
  collectionName?: string,
): Promise<EnrichmentProvider> {
  const key = cacheKey(modulePath, collectionName);
  const existing = providerCache.get(key);
  if (existing) return existing;

  const pending = (async (): Promise<EnrichmentProvider> => {
    const mod = (await import(modulePath)) as Record<string, unknown>;
    const factory = mod[factoryExport];
    if (typeof factory !== "function") {
      throw new Error(
        `enrichment worker: providerFactoryExport "${factoryExport}" not found (or not a function) in ${modulePath}`,
      );
    }
    return (factory as EnrichmentProviderFactory)(serializableConfig);
  })();

  // Cache the PROMISE so the second concurrent caller awaits the same build.
  // If the build rejects, evict the entry so the next call retries with a
  // fresh attempt (caching a rejected promise would poison the slot forever).
  providerCache.set(key, pending);
  pending.catch(() => providerCache.delete(key));
  return pending;
}

/** Dispatch the named EnrichmentExecutor method on the resolved provider. */
async function invokeMethod(
  provider: EnrichmentProvider,
  request: EnrichmentCallRequest,
): Promise<EnrichmentWorkerResponse> {
  const { method, root, paths, chunkMap, options } = request;
  switch (method) {
    case "runFileBatch": {
      const fileOptions = options as FileSignalOptions | undefined;
      const pathList = paths ?? [];
      const overlay = provider.streamFileBatch
        ? await provider.streamFileBatch(root, pathList, fileOptions)
        : await provider.buildFileSignals(root, { ...fileOptions, paths: pathList });
      return { fileOverlay: overlay };
    }
    case "runFileSignals": {
      const fileOptions = options as FileSignalOptions | undefined;
      const overlay = await provider.buildFileSignals(root, { ...fileOptions, paths: paths ?? [] });
      return { fileOverlay: overlay };
    }
    case "runChunkBatch": {
      const chunkOptions = options as ChunkSignalOptions | undefined;
      const map = chunkMap ?? new Map<string, ChunkLookupEntry[]>();
      const overlay = await provider.buildChunkSignals(root, map, chunkOptions);
      return { chunkOverlay: overlay };
    }
    case "runFinalize": {
      const fileOptions = options as FileSignalOptions | undefined;
      if (!provider.finalizeSignals) {
        return { fileOverlay: new Map() };
      }
      const overlay = await provider.finalizeSignals(root, fileOptions);
      return { fileOverlay: overlay };
    }
  }
}

/**
 * Release the cached provider entry for (modulePath, collectionName). Invokes
 * `provider.onRelease?.()` first; swallows any throw (bounded memory wins over
 * perfect cleanup — spec section 5). Idempotent: returns `released: false`
 * when the entry was not in the cache.
 */
async function releaseEntry(request: EnrichmentReleaseRequest): Promise<EnrichmentWorkerResponse> {
  const key = cacheKey(request.providerModulePath, request.collectionName);
  const pending = providerCache.get(key);
  if (!pending) return { released: false };
  providerCache.delete(key);
  try {
    const provider = await pending;
    if (provider.onRelease) await provider.onRelease();
  } catch (err) {
    // Failure during release is non-fatal — see spec section 5. The next index
    // pass rebuilds the provider from scratch; the daemon DuckDB connection is
    // multi-client by design so a stale handle is harmless.
    process.stderr.write(`[enrichment-worker] onRelease failed for ${key}: ${(err as Error).message}\n`);
  }
  return { released: true };
}

async function handle(request: EnrichmentWorkerRequest): Promise<EnrichmentWorkerResponse | "exit"> {
  if (request.type === "shutdown") return "exit";
  if (request.type === "release") return releaseEntry(request);
  // request.type === "call"
  const provider = await getProvider(
    request.providerModulePath,
    request.providerFactoryExport,
    request.serializableConfig,
    request.collectionName,
  );
  return invokeMethod(provider, request);
}

if (parentPort) {
  parentPort.on("message", (request: EnrichmentWorkerRequest) => {
    void (async () => {
      try {
        const result = await handle(request);
        if (result === "exit") {
          parentPort?.close();
          return;
        }
        parentPort?.postMessage(result satisfies EnrichmentWorkerResponse);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        parentPort?.postMessage({ error: message } satisfies EnrichmentWorkerResponse);
      }
    })();
  });
}

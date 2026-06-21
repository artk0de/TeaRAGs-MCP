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
 *   - Providers WITHOUT `workerDescriptor` (git) are dispatched inline via an
 *     internal `InlineEnrichmentExecutor`. Git runs in-process on the
 *     composition-root instance: blame cache reuse is automatic (same instance),
 *     postMessage serialization overhead is zero. Live taxdome evidence showed
 *     collection-affinity made git enrichment ~4x SLOWER by pinning to 1 worker
 *     (removing parallelism) while per-batch cost is dominated by walkCommits
 *     (git log + cat-file + structuredPatch), not blame.
 *
 * Release path:
 *
 *   `releaseCollection(providers, collection)` fans out a `release`
 *   envelope per worker-descriptor provider, then drops the WorkerDispatchPool's
 *   affinity binding so the next collection assigned to that routingKey
 *   can land on any free thread. Inline-fallback providers are no-ops here
 *   (the inline executor itself does no-op release per spec section 5 —
 *   one shared provider instance across collections, can't safely call
 *   onRelease without wiping state for concurrent runs).
 */
import type {
  ChunkSignalOptions,
  ChunkSignalOverlay,
  EnrichmentExecutor,
  EnrichmentProvider,
  FileSignalOptions,
  FileSignalOverlay,
  WorkerEnrichmentDescriptor,
} from "../../../../../contracts/index.js";
import type { ChunkLookupEntry } from "../../../../../types.js";
import { ThreadTransport } from "../../infra/thread-transport.js";
import { WorkerDispatchPool } from "../../infra/worker-dispatch-pool.js";
import type {
  EnrichmentCallRequest,
  EnrichmentMethod,
  EnrichmentReleaseRequest,
  EnrichmentWorkerRequest,
  EnrichmentWorkerResponse,
} from "../infra/worker-protocol.js";
import { InlineEnrichmentExecutor } from "./inline.js";

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

  constructor(poolSize: number, workerPath: string) {
    this.pool = new WorkerDispatchPool<EnrichmentWorkerRequest, EnrichmentWorkerResponse>(
      poolSize,
      new ThreadTransport<EnrichmentWorkerRequest, EnrichmentWorkerResponse>(workerPath),
      {},
      "EnrichmentPool",
    );
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
    const routingKey = routingKeyFor(provider.workerDescriptor, collectionName);
    const response = await this.pool.dispatch(request, routingKey);
    this.throwIfErr(response);
    return response.fileOverlay ?? new Map();
  }

  async runFileSignals(
    provider: EnrichmentProvider,
    root: string,
    paths: string[],
    options?: FileSignalOptions,
  ): Promise<Map<string, FileSignalOverlay>> {
    if (!provider.workerDescriptor) {
      return this.inlineFallback.runFileSignals(provider, root, paths, options);
    }
    const collectionName = options?.collectionName;
    const request = buildCallRequest(provider.workerDescriptor, "runFileSignals", root, collectionName, {
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
    const routingKey = routingKeyFor(provider.workerDescriptor, collectionName);
    const response = await this.pool.dispatch(request, routingKey);
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
    const routingKey = routingKeyFor(provider.workerDescriptor, collectionName);
    const response = await this.pool.dispatch(request, routingKey);
    this.throwIfErr(response);
    return response.fileOverlay ?? new Map();
  }

  async releaseCollection(providers: EnrichmentProvider[], collection: string): Promise<void> {
    await Promise.all(
      providers.map(async (provider) => {
        const descriptor = provider.workerDescriptor;
        // Inline-fallback providers don't have worker-side state to release.
        // Calling provider.onRelease here would mirror the inline executor's
        // no-op rationale (shared instance across collections — wiping
        // state would break concurrent runs). Skip entirely.
        if (!descriptor) return;
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

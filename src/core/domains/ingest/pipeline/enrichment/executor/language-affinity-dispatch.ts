/**
 * LanguageAffinityDispatcher — the collection-scoped calls of a run whose
 * collection is served by one pinned worker per language partition (bd
 * tea-rags-mcp-sgo8v). File batches are the fan-out's
 * (`ExtractionFanoutDispatcher#runPartitionedFileBatch`); everything after them
 * is here, because each is a single call to the executor that has to become one
 * call per partition with a contract the partitions keep between them:
 *
 *   - finalize is a BARRIER. Every partition resolves its own files; only when
 *     the last one has does any partition read back, and only the completion
 *     owner — last, and alone on the connection — recomputes cycles and
 *     PageRank. A metric or an `isHub` read earlier is read off half a graph:
 *     the fan-in p95 every file is judged against counts every partition's
 *     edges.
 *   - the deferred chunk pass goes to the partition that WALKED each file: only
 *     that worker holds the walk ranges the chunk-owner rule settles against.
 *     A file of no language goes to the completion owner, where it settles as
 *     "not extractable" exactly as it would anywhere.
 *   - release evicts every partition's provider instance.
 *
 * Every dispatch goes through the injected pool call, like the fan-out's, so
 * the protocol is testable without threads.
 */
import type { ChunkLookupEntry } from "../../../../../contracts/types/chunker.js";
import type {
  ChunkSignalOverlay,
  FileSignalOptions,
  FileSignalOverlay,
} from "../../../../../contracts/types/provider.js";
import type {
  EnrichmentCallRequest,
  EnrichmentReleaseRequest,
  EnrichmentWorkerResponse,
} from "../infra/worker-protocol.js";
import type { ExtractionFanoutDispatch } from "./extraction-fanout.js";
import type { LanguageAffinityPartition, LanguageAffinityPlan } from "./language-affinity-plan.js";

export class LanguageAffinityDispatcher {
  constructor(private readonly dispatch: ExtractionFanoutDispatch) {}

  /**
   * Finalize the collection across its partitions: `resolve` everywhere, then —
   * past the barrier — `readBack` everywhere. Returns the union of the
   * partitions' file overlays (disjoint: each reports the files it owns).
   *
   * A partition that fails to resolve fails the finalize, but only after the
   * others settled — none is left writing while the caller tears the run down —
   * and no partition reads back a graph a pass-2 is missing from.
   */
  async runFinalize(request: EnrichmentCallRequest, plan: LanguageAffinityPlan): Promise<EnrichmentWorkerResponse> {
    await this.onEach(plan.partitions, async (partition) => this.finalizeStage(request, plan, partition, "resolve"));
    // The other partitions read back first, and the completion owner LAST and
    // ALONE: its readBack recomputes cycles and PageRank by draining the edge
    // tables through a streaming read, and a DuckDB stream is invalidated by any
    // other statement on its connection — which every partition shares. Probed:
    // 3000 edges drained alone, 2048 with one concurrent read, no error either
    // way. Running it last also keeps its timing line the run's closing one.
    const others = plan.partitions.filter((partition) => partition !== plan.completionOwner);
    const readBacks = await this.onEach(others, async (partition) =>
      this.finalizeStage(request, plan, partition, "readBack"),
    );
    readBacks.push(await this.finalizeStage(request, plan, plan.completionOwner, "readBack"));
    const fileOverlay = new Map<string, FileSignalOverlay>();
    for (const response of readBacks) {
      for (const [relPath, overlay] of response.fileOverlay ?? []) fileOverlay.set(relPath, overlay);
    }
    return { fileOverlay };
  }

  /** The deferred chunk pass, each file's chunks on the partition that walked it. */
  async runChunkBatch(request: EnrichmentCallRequest, plan: LanguageAffinityPlan): Promise<EnrichmentWorkerResponse> {
    const byPartition = new Map<LanguageAffinityPartition, Map<string, ChunkLookupEntry[]>>();
    for (const [relPath, entries] of request.chunkMap ?? []) {
      const partition = plan.partitionOfPath(relPath);
      let share = byPartition.get(partition);
      if (!share) {
        share = new Map();
        byPartition.set(partition, share);
      }
      share.set(relPath, entries);
    }
    const responses = await Promise.all(
      [...byPartition].map(async ([partition, chunkMap]) =>
        this.dispatch({ ...request, affinityPartition: partition.label, chunkMap }, partition.routingKey),
      ),
    );
    const chunkOverlay = new Map<string, Map<string, ChunkSignalOverlay>>();
    for (const response of responses) {
      if (response.error) return response;
      for (const [relPath, overlays] of response.chunkOverlay ?? []) chunkOverlay.set(relPath, overlays);
    }
    return { chunkOverlay };
  }

  /**
   * Evict every partition's provider instance of `providerModulePath` for
   * `collectionName`. Best-effort per partition, like the collection-affinity
   * release: a failure leaves memory to the next run's rebuild, never the run.
   */
  async release(providerModulePath: string, collectionName: string, plan: LanguageAffinityPlan): Promise<void> {
    await Promise.all(
      plan.partitions.map(async (partition) => {
        const request: EnrichmentReleaseRequest = {
          type: "release",
          providerModulePath,
          collectionName,
          affinityPartition: partition.label,
        };
        try {
          await this.dispatch(request, partition.routingKey);
        } catch (err) {
          process.stderr.write(
            `[LanguageAffinityDispatcher] release failed for ${providerModulePath} (${partition.label}): ${
              (err as Error).message
            }\n`,
          );
        }
      }),
    );
  }

  private async finalizeStage(
    request: EnrichmentCallRequest,
    plan: LanguageAffinityPlan,
    partition: LanguageAffinityPartition,
    finalizeStage: "resolve" | "readBack",
  ): Promise<EnrichmentWorkerResponse> {
    const options: FileSignalOptions = {
      ...(request.options as FileSignalOptions | undefined),
      finalizeStage,
      ownsCollectionCompletion: partition === plan.completionOwner,
    };
    const response = await this.dispatch(
      { ...request, affinityPartition: partition.label, options },
      partition.routingKey,
    );
    if (response.error) throw new Error(`enrichment worker error: ${response.error}`);
    return response;
  }

  /**
   * Run `stage` on every given partition concurrently and wait for ALL of them
   * to settle before reporting — then rethrow the first failure, if any.
   */
  private async onEach(
    partitions: readonly LanguageAffinityPartition[],
    stage: (partition: LanguageAffinityPartition) => Promise<EnrichmentWorkerResponse>,
  ): Promise<EnrichmentWorkerResponse[]> {
    const settled = await Promise.allSettled(partitions.map(stage));
    const failed = settled.find((outcome): outcome is PromiseRejectedResult => outcome.status === "rejected");
    if (failed) throw failed.reason;
    return settled.map((outcome) => (outcome as PromiseFulfilledResult<EnrichmentWorkerResponse>).value);
  }
}

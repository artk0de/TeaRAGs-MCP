/**
 * GitEnrichmentProvider factory — the rebuild seam for the worker thread.
 *
 * Phase 2 of unified-enrichment-worker-pool: the named factory export
 * `createGitEnrichmentProvider` is the SOLE place that interprets a
 * `GitWorkerConfig` payload coming through `WorkerEnrichmentDescriptor.
 * serializableConfig`. The worker `dynamic-import`s this module by
 * absolute path (see `.claude/rules/domains-language.md`) and calls the
 * factory once per (collectionName) — git is STATEFUL: `buildChunkSignals`
 * reuses `blameByRelPath`/`lastFileResult`/`enrichmentCache` populated by
 * `buildFileSignals` on the same instance, so dispatch is `"collection-affinity"`
 * to pin all of a collection's file/chunk/finalize batches to one worker.
 *
 * Inline path: composition root calls the same factory directly without
 * a descriptor — provider runs on the main thread, no behavior change.
 */
import type { WorkerEnrichmentDescriptor } from "../../../contracts/types/provider.js";
import type { SquashOptions } from "./infra/metrics.js";
import { GitEnrichmentProvider, type GitProviderConfig } from "./provider.js";

/**
 * Structured-clone-safe config payload for in-thread git provider rebuild.
 * All fields are optional — the factory applies provider defaults for any
 * missing tuning. `squashOpts` is a plain object (two optional primitives)
 * and survives postMessage cleanly.
 */
export interface GitWorkerConfig extends Partial<GitProviderConfig> {
  /** Squash-aware session options threaded into commit-walk metrics. */
  squashOpts?: SquashOptions;
}

/**
 * Build a `GitEnrichmentProvider` from a structured-clone-safe config.
 * Named export — referenced by `WorkerEnrichmentDescriptor.providerFactoryExport`.
 *
 * @param config Structured-clone-safe tuning + squash options.
 * @param descriptor Optional descriptor to attach to the provider. The
 *   composition root supplies it when wiring the worker-pool executor; when
 *   omitted, the provider is inline-only (no workerDescriptor surfaced).
 */
export function createGitEnrichmentProvider(
  config: GitWorkerConfig,
  descriptor?: WorkerEnrichmentDescriptor,
): GitEnrichmentProvider {
  const { squashOpts, ...providerConfig } = config;
  return new GitEnrichmentProvider(providerConfig, squashOpts, descriptor);
}

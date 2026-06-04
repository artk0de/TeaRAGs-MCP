/**
 * GitEnrichmentProvider factory.
 *
 * Production path: called by the composition root WITHOUT a descriptor.
 * `WorkerPoolEnrichmentExecutor` detects the missing descriptor and falls
 * through to `InlineEnrichmentExecutor`, which calls
 * `provider.buildFileSignals`/`buildChunkSignals` directly in-process on
 * the single composition-root instance. Blame cache reuse
 * (`blameByRelPath`/`lastFileResult`/`enrichmentCache`) is automatic
 * (same instance), postMessage serialization overhead is zero.
 *
 * Optional descriptor path: if a caller DOES supply a descriptor it is
 * attached verbatim. The factory export name `createGitEnrichmentProvider`
 * is preserved so any future off-thread use can reference it via
 * `WorkerEnrichmentDescriptor.providerFactoryExport`.
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

/**
 * GitTrajectory — unified entry point for the Git trajectory module.
 *
 * Aggregates all query-side and ingest-side capabilities:
 * - Payload signal descriptors (raw Qdrant fields)
 * - Derived signal descriptors (normalized rerank signals)
 * - Filter descriptors (user params → Qdrant conditions)
 * - Rerank presets (named weight configurations)
 * - Enrichment provider (file + chunk signal builders)
 */

import type { WorkerEnrichmentDescriptor } from "../../contracts/types/provider.js";
import type { Trajectory } from "../../contracts/types/trajectory.js";
import { gitFilters } from "./git/filters.js";
import { GIT_PRESETS, gitDerivedSignals, gitStatsAccumulators } from "./git/index.js";
import type { SquashOptions } from "./git/infra/metrics.js";
import { gitPayloadSignalDescriptors } from "./git/payload-signals.js";
import { GitEnrichmentProvider, type GitProviderConfig } from "./git/provider.js";

export class GitTrajectory implements Trajectory {
  readonly key = "git";
  readonly name = "Git";
  readonly description = "Git history signals: churn, authorship, age, and derived analytics";
  readonly payloadSignals = gitPayloadSignalDescriptors;
  readonly derivedSignals = gitDerivedSignals;
  readonly filters = gitFilters;
  readonly presets = GIT_PRESETS;
  readonly statsAccumulators = [...gitStatsAccumulators];
  readonly enrichment: GitEnrichmentProvider;

  constructor(
    config?: Partial<GitProviderConfig>,
    squashOpts?: SquashOptions,
    workerDescriptor?: WorkerEnrichmentDescriptor,
  ) {
    this.enrichment = new GitEnrichmentProvider(config, squashOpts, workerDescriptor);
  }
}

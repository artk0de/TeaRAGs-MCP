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

import type { Trajectory } from "../contracts/types/trajectory.js";
import { gitFilters } from "./git/filters.js";
import { GitEnrichmentProvider } from "./git/provider.js";
import { gitDerivedSignals } from "./git/rerank/derived-signals/index.js";
import { GIT_PRESETS } from "./git/rerank/presets/index.js";
import { gitPayloadSignalDescriptors } from "./git/signals.js";

export class GitTrajectory implements Trajectory {
  readonly key = "git";
  readonly name = "Git";
  readonly description = "Git history signals: churn, authorship, age, and derived analytics";
  readonly payloadSignals = gitPayloadSignalDescriptors;
  readonly derivedSignals = gitDerivedSignals;
  readonly filters = gitFilters;
  readonly presets = GIT_PRESETS;
  readonly enrichment = new GitEnrichmentProvider();
}

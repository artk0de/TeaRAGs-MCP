/**
 * Composition root — assembles the full application graph from trajectories.
 *
 * Uses TrajectoryRegistry to aggregate payloadSignals, derivedSignals,
 * filters, and presets from all registered trajectories. The only place
 * that knows which trajectories exist.
 */

import type { DerivedSignalDescriptor, RerankPreset } from "../../contracts/types/reranker.js";
import type { StatsAccumulatorDescriptor } from "../../contracts/types/stats-accumulator.js";
import type { PayloadSignalDescriptor } from "../../contracts/types/trajectory.js";
import { resolvePresets } from "../../domains/explore/rerank/presets/index.js";
import { Reranker } from "../../domains/explore/reranker.js";
import { validateSignalDependencies } from "../../domains/ingest/infra/collection-stats.js";
import { createCodegraphTrajectories, type CodegraphDeps } from "../../domains/trajectory/codegraph/index.js";
import { GitTrajectory } from "../../domains/trajectory/git.js";
import { TrajectoryRegistry } from "../../domains/trajectory/index.js";
import { StaticTrajectory } from "../../domains/trajectory/static/index.js";

export interface CompositionResult {
  registry: TrajectoryRegistry;
  reranker: Reranker;
  allPayloadSignalDescriptors: PayloadSignalDescriptor[];
  allDerivedSignals: DerivedSignalDescriptor[];
  allStatsAccumulators: StatsAccumulatorDescriptor[];
  resolvedPresets: RerankPreset[];
}

export interface CompositionOptions {
  /**
   * When provided, registers the codegraph L1 family (Slice 1: Symbols).
   * Bootstrap supplies these deps when `CODEGRAPH_ENABLED` is true; tests
   * pass them directly. Omitting opts the family out — the rest of the
   * composition is unaffected.
   */
  codegraph?: CodegraphDeps;
}

export function createComposition(options: CompositionOptions = {}): CompositionResult {
  const registry = new TrajectoryRegistry();
  registry.register(new StaticTrajectory());
  registry.register(new GitTrajectory());
  if (options.codegraph) {
    for (const trajectory of createCodegraphTrajectories(options.codegraph)) {
      registry.register(trajectory);
    }
  }

  const allPayloadSignalDescriptors = registry.getAllPayloadSignalDescriptors();
  // Fail-loud at composition time: if any descriptor's confidence block
  // references a percentile that the support signal doesn't declare
  // (neither stats.labels nor stats.percentilesToCompute), this throws.
  // Prevents silent fallback to rule.fallback in production due to
  // misconfigured wiring. See `validateSignalDependencies` for details.
  validateSignalDependencies(allPayloadSignalDescriptors);
  const allDerivedSignals = registry.getAllDerivedSignals();
  const allStatsAccumulators = registry.getAllStatsAccumulators();
  const resolvedPresets = resolvePresets(registry.getAllPresets(), []);
  const reranker = new Reranker(allDerivedSignals, resolvedPresets, allPayloadSignalDescriptors);

  return {
    registry,
    reranker,
    allPayloadSignalDescriptors,
    allDerivedSignals,
    allStatsAccumulators,
    resolvedPresets,
  };
}

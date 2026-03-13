/**
 * Composition root — assembles the full application graph from trajectories.
 *
 * Uses TrajectoryRegistry to aggregate payloadSignals, derivedSignals,
 * filters, and presets from all registered trajectories. The only place
 * that knows which trajectories exist.
 */

import type { DerivedSignalDescriptor, RerankPreset } from "../../contracts/types/reranker.js";
import type { PayloadSignalDescriptor } from "../../contracts/types/trajectory.js";
import { resolvePresets } from "../../domains/explore/rerank/presets/index.js";
import { Reranker } from "../../domains/explore/reranker.js";
import { GitTrajectory } from "../../domains/trajectory/git.js";
import { TrajectoryRegistry } from "../../domains/trajectory/index.js";
import { StaticTrajectory } from "../../domains/trajectory/static/index.js";

export interface CompositionResult {
  registry: TrajectoryRegistry;
  reranker: Reranker;
  allPayloadSignalDescriptors: PayloadSignalDescriptor[];
  allDerivedSignals: DerivedSignalDescriptor[];
  resolvedPresets: RerankPreset[];
}

export function createComposition(): CompositionResult {
  const registry = new TrajectoryRegistry();
  registry.register(new StaticTrajectory());
  registry.register(new GitTrajectory());

  const allPayloadSignalDescriptors = registry.getAllPayloadSignalDescriptors();
  const allDerivedSignals = registry.getAllDerivedSignals();
  const resolvedPresets = resolvePresets(registry.getAllPresets(), []);
  const reranker = new Reranker(allDerivedSignals, resolvedPresets, allPayloadSignalDescriptors);

  return { registry, reranker, allPayloadSignalDescriptors, allDerivedSignals, resolvedPresets };
}

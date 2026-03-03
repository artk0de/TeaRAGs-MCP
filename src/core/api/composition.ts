/**
 * Composition root — assembles the full application graph from trajectories.
 *
 * Uses TrajectoryRegistry to aggregate payloadSignals, derivedSignals,
 * filters, and presets from all registered trajectories. The only place
 * that knows which trajectories exist.
 */

import { BASE_PAYLOAD_SIGNALS } from "../contracts/payload-signals.js";
import type { DerivedSignalDescriptor, RerankPreset } from "../contracts/types/reranker.js";
import type { PayloadSignalDescriptor } from "../contracts/types/trajectory.js";
import { structuralSignals } from "../search/rerank/derived-signals/index.js";
import { RELEVANCE_PRESETS, resolvePresets } from "../search/rerank/presets/index.js";
import { Reranker } from "../search/reranker.js";
import { GitTrajectory } from "../trajectory/git.js";
import { TrajectoryRegistry } from "../trajectory/index.js";

export interface CompositionResult {
  registry: TrajectoryRegistry;
  reranker: Reranker;
  allPayloadSignalDescriptors: PayloadSignalDescriptor[];
  allDerivedSignals: DerivedSignalDescriptor[];
  resolvedPresets: RerankPreset[];
}

export function createComposition(): CompositionResult {
  const registry = new TrajectoryRegistry();
  registry.register(new GitTrajectory());

  const allPayloadSignalDescriptors = [...BASE_PAYLOAD_SIGNALS, ...registry.getAllPayloadSignalDescriptors()];
  const allDerivedSignals = [...registry.getAllDerivedSignals(), ...structuralSignals];
  const resolvedPresets = resolvePresets(RELEVANCE_PRESETS, registry.getAllPresets(), []);
  const reranker = new Reranker(allDerivedSignals, resolvedPresets, allPayloadSignalDescriptors);

  return { registry, reranker, allPayloadSignalDescriptors, allDerivedSignals, resolvedPresets };
}

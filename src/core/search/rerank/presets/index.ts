/**
 * Preset resolution infrastructure — merges presets from 3-level hierarchy:
 *   1. Generic (RelevancePreset — structural only, always available)
 *   2. Trajectory (provider-defined, e.g. git presets)
 *   3. Composite (future — combines multiple trajectories, overrides by key)
 *
 * Resolution rule: later levels override earlier by (name, tool) key.
 */

import type { ScoringWeights } from "../../../contracts/types/provider.js";
import type { RerankPreset } from "../../../contracts/types/reranker.js";
import { RelevancePreset } from "./relevance.js";

// Re-export for consumers
export type { RerankPreset } from "../../../contracts/types/reranker.js";
export { RelevancePreset } from "./relevance.js";

/** Generic relevance presets — always available regardless of registered trajectories. */
export const RELEVANCE_PRESETS: RerankPreset[] = [new RelevancePreset()];

/**
 * Resolve presets by 3-level hierarchy: generic -> trajectory -> composite.
 * Later levels override earlier by (name, tool) key.
 * Multi-tool presets are indexed for each tool they support.
 */
export function resolvePresets(
  generic: RerankPreset[],
  trajectory: RerankPreset[],
  composite: RerankPreset[],
): RerankPreset[] {
  const map = new Map<string, RerankPreset>();
  for (const preset of [...generic, ...trajectory, ...composite]) {
    const toolList = preset.tools;
    for (const t of toolList) {
      map.set(`${t}:${preset.name}`, preset);
    }
  }
  return [...new Set(map.values())];
}

/** Get preset names for a specific tool. */
export function getPresetNames(presets: RerankPreset[], tool: string): string[] {
  return presets.filter((p) => p.tools.includes(tool)).map((p) => p.name);
}

/** Get preset weights by name + tool. */
export function getPresetWeights(presets: RerankPreset[], name: string, tool: string): ScoringWeights | undefined {
  return presets.find((p) => p.name === name && p.tools.includes(tool))?.weights;
}

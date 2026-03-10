/**
 * Preset resolution infrastructure — merges presets from 2-level hierarchy:
 *   1. Registry presets (from all registered trajectories)
 *   2. Composite (future — combines multiple trajectories, overrides by key)
 *
 * Resolution rule: later levels override earlier by (name, tool) key.
 */

import type { ScoringWeights } from "../../../contracts/types/provider.js";
import type { RerankPreset } from "../../../contracts/types/reranker.js";

export type { RerankPreset } from "../../../contracts/types/reranker.js";

/**
 * Resolve presets by 2-level hierarchy: registry -> composite.
 * Later levels override earlier by (name, tool) key.
 * Multi-tool presets are indexed for each tool they support.
 */
export function resolvePresets(registry: RerankPreset[], composite: RerankPreset[]): RerankPreset[] {
  const map = new Map<string, RerankPreset>();
  for (const preset of [...registry, ...composite]) {
    for (const t of preset.tools) {
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

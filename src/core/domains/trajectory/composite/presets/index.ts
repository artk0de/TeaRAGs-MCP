/**
 * Composite preset namespace — presets that combine signals from 2+
 * trajectories. Pure data declarations (no signal compute, no enrichment
 * provider, no filters) — they reference signals from other trajectories
 * by string key only. Domain-boundary rules stay satisfied because there
 * is no cross-trajectory import.
 *
 * Resolution: `buildCompositePresets(opts)` returns the list fed to
 * `resolvePresets(registry, composite)` from `api/internal/composition.ts`.
 * Composite presets sharing a `(name, tools[i])` key with a trajectory
 * preset win the resolution — they OVERRIDE by name. New names (no
 * trajectory preset with that name) just slot in.
 *
 * Conditional emission: composites that rely on a specific trajectory's
 * signals (e.g. `fanIn` requires codegraph wired) must guard their
 * inclusion on the corresponding flag. Bootstrap toggles each trajectory
 * independently; opts mirror those toggles.
 */

import type { RerankPreset } from "../../../../contracts/types/reranker.js";
import { BlastRadiusPreset } from "./blast-radius.js";

export { BlastRadiusPreset };

export interface CompositePresetOptions {
  /**
   * Codegraph wired (fanIn / fanOut / isHub / isLeaf / chunkFanIn raw
   * signals populated). Presets that read those signals are excluded
   * when this is false so resolved overlays don't reference unpopulated
   * payload keys.
   */
  codegraph: boolean;
}

/**
 * Build the composite preset list for the current composition. Pure
 * function; safe to call multiple times. Order does not matter — the
 * resolver indexes by `(name, tool)`.
 */
export function buildCompositePresets(opts: CompositePresetOptions): RerankPreset[] {
  const out: RerankPreset[] = [];
  if (opts.codegraph) {
    out.push(new BlastRadiusPreset());
  }
  return out;
}

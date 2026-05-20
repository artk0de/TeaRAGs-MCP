/**
 * Composite preset namespace — presets that combine signals from 2+
 * trajectories. Pure data declarations (no signal compute, no
 * enrichment provider, no filters); composite presets reference signals
 * from other trajectories by string key only, so the domain-boundary
 * rule (no cross-trajectory imports) stays satisfied.
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
import { ArchitecturalHubPreset } from "./architectural-hub.js";
import { BlastRadiusPreset } from "./blast-radius.js";
import { CodeReviewCompositePreset } from "./code-review.js";
import { DangerousCompositePreset } from "./dangerous.js";
import { HotspotsCompositePreset } from "./hotspots.js";
import { OwnershipCompositePreset } from "./ownership.js";
import { SecurityAuditCompositePreset } from "./security-audit.js";
import { TechDebtCompositePreset } from "./tech-debt.js";

export {
  ArchitecturalHubPreset,
  BlastRadiusPreset,
  CodeReviewCompositePreset,
  DangerousCompositePreset,
  HotspotsCompositePreset,
  OwnershipCompositePreset,
  SecurityAuditCompositePreset,
  TechDebtCompositePreset,
};

export interface CompositePresetOptions {
  /**
   * Codegraph wired (fanIn / fanOut / isHub / isLeaf / chunkFanIn raw
   * signals populated). Composites that read those signals are excluded
   * when this is false so resolved overlays don't reference unpopulated
   * payload keys.
   */
  codegraph: boolean;
}

/**
 * Build the composite preset list for the current composition. Pure
 * function; safe to call multiple times. Order does not matter — the
 * resolver indexes by `(name, tool)`.
 *
 * Each composite below is guarded on the trajectory toggles it depends
 * on. When a guard is false the composite is omitted so its trajectory
 * preset counterpart wins resolution unmodified — agents get the
 * single-trajectory behaviour the running deployment can actually serve.
 */
export function buildCompositePresets(opts: CompositePresetOptions): RerankPreset[] {
  const out: RerankPreset[] = [];
  if (opts.codegraph) {
    // Overrides: same name as trajectory preset, augmented weights.
    out.push(
      new HotspotsCompositePreset(),
      new TechDebtCompositePreset(),
      new DangerousCompositePreset(),
      new OwnershipCompositePreset(),
      new SecurityAuditCompositePreset(),
      new CodeReviewCompositePreset(),
    );
    // New composite names — no trajectory equivalent.
    out.push(new BlastRadiusPreset(), new ArchitecturalHubPreset());
  }
  return out;
}

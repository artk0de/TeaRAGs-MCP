/**
 * Composite preset namespace — presets that combine signals from 2+
 * trajectories. Pure data declarations (no signal compute, no
 * enrichment provider, no filters); composite presets reference signals
 * from other trajectories by string key only, so the domain-boundary
 * rule (no cross-trajectory imports) stays satisfied.
 *
 * Resolution: `buildCompositePresets(registeredKeys)` returns the list
 * fed to `resolvePresets(registry, composite)` from
 * `api/internal/composition.ts`. Composite presets sharing a
 * `(name, tools[i])` key with a trajectory preset win the resolution —
 * they OVERRIDE by name. New names (no trajectory preset with that name)
 * just slot in.
 *
 * Declarative gating: each composite declares its trajectory
 * dependencies via the mandatory `requires` field on
 * `CompositeRerankPreset`. `buildCompositePresets` filters by
 * `requires.every(k => registeredKeys.has(k))`. A composite whose
 * dependencies are not all registered is silently dropped — it never
 * reaches the Reranker, the SchemaBuilder, the MCP preset enum, or the
 * custom-weights schema.
 *
 * The previous monolithic `{ codegraph: boolean }` gate is generalised
 * to a per-preset declarative check, so adding new trajectories (or
 * disabling existing ones, e.g. `git`) does not require updating this
 * function — the new trajectory key flows through `registeredKeys` and
 * every composite that declares it gets the new dependency for free.
 */

import type { CompositeRerankPreset, RerankPreset } from "../../../../contracts/types/reranker.js";
import { ArchitecturalHubPreset } from "./architectural-hub.js";
import { BlastRadiusPreset } from "./blast-radius.js";
import { CodeReviewCompositePreset } from "./code-review.js";
import { DangerousCompositePreset } from "./dangerous.js";
import { EntryPointPreset } from "./entry-point.js";
import { HotspotsCompositePreset } from "./hotspots.js";
import { OwnershipCompositePreset } from "./ownership.js";
import { SecurityAuditCompositePreset } from "./security-audit.js";
import { TechDebtCompositePreset } from "./tech-debt.js";

export {
  ArchitecturalHubPreset,
  BlastRadiusPreset,
  CodeReviewCompositePreset,
  DangerousCompositePreset,
  EntryPointPreset,
  HotspotsCompositePreset,
  OwnershipCompositePreset,
  SecurityAuditCompositePreset,
  TechDebtCompositePreset,
};

/**
 * Source of truth for every composite preset known to the system. New
 * composites added here automatically flow through gating. Order does
 * not matter — `resolvePresets` indexes by `(name, tool)`.
 */
const ALL_COMPOSITE_PRESETS: readonly CompositeRerankPreset[] = [
  // Overrides: same name as trajectory preset, augmented weights.
  new HotspotsCompositePreset(),
  new TechDebtCompositePreset(),
  new DangerousCompositePreset(),
  new OwnershipCompositePreset(),
  new SecurityAuditCompositePreset(),
  new CodeReviewCompositePreset(),
  // New composite names — no trajectory equivalent.
  new BlastRadiusPreset(),
  new ArchitecturalHubPreset(),
  new EntryPointPreset(),
];

/**
 * Build the composite preset list for the current composition. Pure
 * function; safe to call multiple times.
 *
 * `registeredKeys` is the set of trajectory keys actually registered in
 * `TrajectoryRegistry` (typically `registry.getRegisteredKeys()`). A
 * composite is included iff every key in its `requires` is in the set.
 *
 * Conventions:
 * - Always-on trajectories (e.g. `"static"`) are NOT listed in
 *   `requires`; a composite that only blends static signals with a
 *   single optional trajectory's signals declares only the optional
 *   key. See `EntryPointPreset.requires = ["codegraph.symbols"]`.
 * - Unknown keys in `registeredKeys` are ignored. Extra keys (e.g. a
 *   future trajectory) do not enable extra presets.
 */
export function buildCompositePresets(registeredKeys: ReadonlySet<string>): RerankPreset[] {
  return ALL_COMPOSITE_PRESETS.filter((p) => p.requires.every((k) => registeredKeys.has(k)));
}

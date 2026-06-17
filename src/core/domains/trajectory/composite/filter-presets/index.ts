import type { FilterPresetDef } from "../../../../contracts/types/filter-preset.js";
import { battleTestedFilterPreset } from "./battle-tested.js";
import { abandonedHotspotsFilterPreset } from "./abandoned-hotspots.js";

export { battleTestedFilterPreset, abandonedHotspotsFilterPreset };

const ALL_COMPOSITE_FILTER_PRESETS: readonly FilterPresetDef[] = [
  battleTestedFilterPreset,
  abandonedHotspotsFilterPreset,
];

/**
 * Build the composite filter preset list for the current composition.
 *
 * Mirrors `buildCompositePresets` gating: a preset is included iff every
 * key in its `requires` is present in `registeredKeys`.
 */
export function buildCompositeFilterPresets(registeredKeys: ReadonlySet<string>): FilterPresetDef[] {
  return ALL_COMPOSITE_FILTER_PRESETS.filter((p) =>
    (p.requires ?? []).every((k) => registeredKeys.has(k)),
  );
}

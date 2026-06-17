import type { FilterPresetDef } from "../../../../contracts/types/filter-preset.js";
import { freshLegacyEditsFilterPreset } from "./fresh-legacy-edits.js";
import { fragileSiloFilterPreset } from "./fragile-silo.js";
import { panicZoneFilterPreset } from "./panic-zone.js";
import { godMethodsFilterPreset } from "./god-methods.js";

export { freshLegacyEditsFilterPreset, fragileSiloFilterPreset, panicZoneFilterPreset, godMethodsFilterPreset };

export const GIT_FILTER_PRESETS: FilterPresetDef[] = [
  freshLegacyEditsFilterPreset,
  fragileSiloFilterPreset,
  panicZoneFilterPreset,
  godMethodsFilterPreset,
];

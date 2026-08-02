import type { FilterPresetDef } from "../../../../contracts/types/filter-preset.js";
import { coreLogicFilterPreset } from "./core-logic.js";
import { productionFilterPreset } from "./production.js";
import { securityPathsFilterPreset } from "./security-paths.js";

export { productionFilterPreset, coreLogicFilterPreset, securityPathsFilterPreset };

export const STATIC_FILTER_PRESETS: FilterPresetDef[] = [
  productionFilterPreset,
  coreLogicFilterPreset,
  securityPathsFilterPreset,
];

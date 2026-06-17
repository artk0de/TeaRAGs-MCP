import type { FilterPresetDef } from "../../../../../contracts/types/filter-preset.js";
import { hubsFilterPreset } from "./hubs.js";
import { deadCandidatesFilterPreset } from "./dead-candidates.js";
import { unstableCoreFilterPreset } from "./unstable-core.js";

export { hubsFilterPreset, deadCandidatesFilterPreset, unstableCoreFilterPreset };

export const CODEGRAPH_FILTER_PRESETS: FilterPresetDef[] = [
  hubsFilterPreset,
  deadCandidatesFilterPreset,
  unstableCoreFilterPreset,
];

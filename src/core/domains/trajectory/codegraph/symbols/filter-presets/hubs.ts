import { CODEGRAPH_SYMBOLS_PROVIDER_KEY } from "../../../../../contracts/codegraph-payload.js";
import type { FilterPresetDef } from "../../../../../contracts/types/filter-preset.js";

export const hubsFilterPreset: FilterPresetDef = {
  name: "hubs",
  description:
    "Architectural hub files — high fan-in (imported by many). Focus areas for broad impact or abstraction extraction.",
  requires: [CODEGRAPH_SYMBOLS_PROVIDER_KEY],
  conditions: [{ signal: "codegraph.file.isHub", op: "eq", value: true }],
};

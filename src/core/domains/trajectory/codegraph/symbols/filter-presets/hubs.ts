import type { FilterPresetDef } from "../../../../../contracts/types/filter-preset.js";

export const hubsFilterPreset: FilterPresetDef = {
  name: "hubs",
  description:
    "Architectural hub files — high fan-in (imported by many). Focus areas for broad impact or abstraction extraction.",
  requires: ["codegraph.symbols"],
  conditions: [{ signal: "codegraph.file.isHub", op: "eq", value: true }],
};

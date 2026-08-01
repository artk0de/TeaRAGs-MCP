import type { FilterPresetDef } from "../../../../contracts/types/filter-preset.js";

export const panicZoneFilterPreset: FilterPresetDef = {
  name: "panicZone",
  description: "Recently-active files with high bug-fix rate or high churn volatility — instability hotspots.",
  requires: ["git"],
  conditions: [
    { signal: "git.file.recencyWeightedFreq", op: "gte", value: { percentile: "p50", fallback: 1 } },
    { signal: "git.file.bugFixRate", op: "gte", value: { percentile: "p75", fallback: 30 }, occur: "should" },
    { signal: "git.file.churnVolatility", op: "gte", value: { percentile: "p75", fallback: 25 }, occur: "should" },
  ],
};

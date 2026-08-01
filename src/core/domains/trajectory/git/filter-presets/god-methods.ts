import type { FilterPresetDef } from "../../../../contracts/types/filter-preset.js";

export const godMethodsFilterPreset: FilterPresetDef = {
  name: "godMethods",
  description: "High-churn chunks in frequently-committed files — oversized functions accumulating complexity.",
  requires: ["git"],
  conditions: [
    { signal: "git.chunk.churnRatio", op: "gte", value: 0.8 },
    { signal: "git.file.commitCount", op: "gte", value: { percentile: "p50", fallback: 5 } },
  ],
};

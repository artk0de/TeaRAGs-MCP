import type { FilterPresetDef } from "../../../../contracts/types/filter-preset.js";

export const fragileSiloFilterPreset: FilterPresetDef = {
  name: "fragileSilo",
  description: "Single-owner files with frequently-churning chunks — bus-factor risk under active change.",
  requires: ["git"],
  conditions: [
    { signal: "git.file.blameContributorCount", op: "lte", value: 1 },
    { signal: "git.chunk.commitCount", op: "gte", value: { percentile: "p75", fallback: 5 } },
  ],
};

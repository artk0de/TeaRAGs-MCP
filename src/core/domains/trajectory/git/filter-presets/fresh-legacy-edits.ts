import type { FilterPresetDef } from "../../../../contracts/types/filter-preset.js";

export const freshLegacyEditsFilterPreset: FilterPresetDef = {
  name: "freshLegacyEdits",
  description: "Old files with recent chunk edits — legacy code getting active modification.",
  requires: ["git"],
  conditions: [
    { signal: "git.file.ageDays", op: "gte", value: { percentile: "p75", fallback: 60 } },
    { signal: "git.chunk.ageDays", op: "lte", value: 7 },
  ],
};

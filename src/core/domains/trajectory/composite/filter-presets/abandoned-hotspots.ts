import type { FilterPresetDef } from "../../../../contracts/types/filter-preset.js";

/**
 * abandoned-hotspots: high-churn old files (≥p75 commitCount AND ≥p75 ageDays).
 * These files have been modified frequently throughout their long life yet
 * haven't been touched recently — classic accumulation of unresolved issues
 * with no active owner to clean them up.
 */
export const abandonedHotspotsFilterPreset: FilterPresetDef = {
  name: "abandonedHotspots",
  description: "High-churn old files with no recent activity — accumulated issues, no active owner",
  requires: ["git"],
  conditions: [
    {
      signal: "git.file.commitCount",
      op: "gte",
      value: { percentile: "p75", fallback: 9 },
    },
    {
      signal: "git.file.ageDays",
      op: "gte",
      value: { percentile: "p75", fallback: 42 },
    },
  ],
};

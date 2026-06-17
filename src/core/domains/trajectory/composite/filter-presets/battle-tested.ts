import type { FilterPresetDef } from "../../../../contracts/types/filter-preset.js";

/**
 * battle-tested: stable files that have been around long (≥p50 ageDays),
 * have a low bug-fix rate (≤p25 bugFixRate), and are touched by multiple
 * authors (≥2 blameContributorCount). These are the safest-to-depend-on
 * files in the repository.
 */
export const battleTestedFilterPreset: FilterPresetDef = {
  name: "battleTested",
  description:
    "Old, low-bug-rate, multi-author files — stable and safe to depend on",
  requires: ["git"],
  conditions: [
    {
      signal: "git.file.ageDays",
      op: "gte",
      value: { percentile: "p50", fallback: 30 },
    },
    {
      signal: "git.file.bugFixRate",
      op: "lte",
      value: { percentile: "p25", fallback: 10 },
    },
    {
      signal: "git.file.blameContributorCount",
      op: "gte",
      value: 2,
    },
  ],
};

import type { FilterPresetDef } from "../../../../../contracts/types/filter-preset.js";

export const unstableCoreFilterPreset: FilterPresetDef = {
  name: "unstableCore",
  description:
    "Well-connected files with high Martin instability — many outgoing edges relative to incoming. " +
    "These files depend heavily on others but are not widely depended upon, making them volatile core. " +
    "Prime candidates for dependency inversion or abstraction.",
  requires: ["codegraph.symbols"],
  conditions: [
    { signal: "codegraph.file.instability", op: "gte", value: { percentile: "p90", fallback: 0.9 } },
    { signal: "codegraph.file.connectionCount", op: "gte", value: { percentile: "p50", fallback: 5 } },
  ],
};

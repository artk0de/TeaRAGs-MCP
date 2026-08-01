import type { FilterPresetDef } from "../../../../contracts/types/filter-preset.js";

export const coreLogicFilterPreset: FilterPresetDef = {
  name: "coreLogic",
  description: "Only function/class chunks, excluding tests — the meaningful units of code.",
  conditions: [
    { signal: "chunkType", op: "eq", value: ["function", "class"] },
    { signal: "isTest", op: "eq", value: true, occur: "must_not" },
  ],
};

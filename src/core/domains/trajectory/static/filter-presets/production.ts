import type { FilterPresetDef } from "../../../../contracts/types/filter-preset.js";

export const productionFilterPreset: FilterPresetDef = {
  name: "production",
  description: "Production code only — excludes tests, documentation, and catch-all block chunks.",
  conditions: [
    { signal: "isTest", op: "eq", value: true, occur: "must_not" },
    { signal: "isDocumentation", op: "eq", value: true, occur: "must_not" },
    { signal: "chunkType", op: "eq", value: "block", occur: "must_not" },
  ],
};

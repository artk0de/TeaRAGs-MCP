import type { FilterPresetDef } from "../../../../../contracts/types/filter-preset.js";

export const deadCandidatesFilterPreset: FilterPresetDef = {
  name: "deadCandidates",
  description:
    "Function-scope symbols with zero incoming call edges — hypothesis generator for dead code candidates. " +
    "Expect false positives: method-edge resolution is approximate (tea-rags-mcp-lgt4), " +
    "dynamic dispatch and cross-language calls are not yet resolved, " +
    "and public API entry points are unreferenced by design. " +
    "Treat results as a lead list, not a verdict.",
  requires: ["codegraph.symbols"],
  conditions: [
    { signal: "codegraph.chunk.fanIn", op: "eq", value: 0 },
    { signal: "chunkType", op: "eq", value: "function" },
  ],
};

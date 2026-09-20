import type { LanguageCapability } from "../../../contracts/types/language.js";

export const capability: LanguageCapability = {
  language: "swift",
  ast: { tier: "full", engine: "tree-sitter", grammarPackage: "tree-sitter-swift" },
  tests: { tier: "medium", detection: "*Test.swift / *Tests.swift", tech: "generic AST (XCTest not recognized)" },
  codegraph: { tier: "none", tech: "tier 1 — chunks only; call-graph walker + resolver chain land in tier 2" },
  // Tier 1 vertical: every axis is at its seed and stays there until the tier-2
  // walker lands. `codegraphSchema` is 1 the same way markdown's is — the
  // language emits no call graph, so there is no edge vocabulary to version
  // (unlike bash, whose "minimal" graph ships one).
  versions: { chunking: 1, walker: 1, codegraphSchema: 1 },
  notes:
    "Tier 1: symbolId-carrying chunks for find_symbol + hybrid BM25. Type bodies (class/struct/enum/extension/actor) are scope containers whose funcs/inits extract as member chunks; extension methods attribute to the extended type. Computed/stored properties, subscripts, deinit and typealiases are not chunked yet. No call graph (tier 2).",
};

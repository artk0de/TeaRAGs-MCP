import type { LanguageCapability } from "../../../contracts/types/language.js";

export const capability: LanguageCapability = {
  language: "javascript",
  ast: {
    tier: "full",
    engine: "tree-sitter",
    grammarPackage: "tree-sitter-javascript",
    hooks: [
      { name: "jsAssignmentFilter", short: "assignment chunking" },
      { name: "JsChunkClassifier", short: "module/class split" },
    ],
  },
  tests: { tier: "high", detection: "*.test.js / *.spec.jsx", tech: "testScopeChunker (describe/it scopes)" },
  codegraph: { tier: "high", tech: "6-strategy; CommonJS/ESM require resolution (dynamic gaps)" },
  // codegraphSchema 2: bd tea-rags-mcp-ex28m — see typescript/capability.ts.
  // walker 2: bd tea-rags-mcp-hwwtw — receiver-bearing calls no longer fall
  // through to the global short-name lookup.
  versions: { chunking: 1, walker: 2, codegraphSchema: 2 },
};

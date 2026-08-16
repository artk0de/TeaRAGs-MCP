import type { LanguageCapability } from "../../../contracts/types/language.js";

export const capability: LanguageCapability = {
  language: "rust",
  ast: {
    tier: "full",
    engine: "tree-sitter",
    grammarPackage: "tree-sitter-rust",
    hooks: [{ name: "nameExtractor", short: "named-item extraction" }],
  },
  tests: { tier: "medium", detection: "*_test.rs", tech: "generic AST (#[test] attrs not preserved)" },
  codegraph: { tier: "moderate", tech: "6-strategy; trait-based dispatch" },
  versions: { chunking: 1, walker: 1, codegraphSchema: 1 },
};

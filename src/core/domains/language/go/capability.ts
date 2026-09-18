import type { LanguageCapability } from "../../../contracts/types/language.js";

export const capability: LanguageCapability = {
  language: "go",
  ast: {
    tier: "full",
    engine: "tree-sitter",
    grammarPackage: "tree-sitter-go",
    hooks: [{ name: "GoChunkClassifier", short: "func/type split" }],
  },
  tests: { tier: "medium", detection: "*_test.go", tech: "generic AST" },
  codegraph: { tier: "moderate", tech: "6-strategy; explicit interfaces (no poly dispatch)" },
  // codegraphSchema 2: bd tea-rags-mcp-ex28m — see typescript/capability.ts.
  // walker 2: bd tea-rags-mcp-e6xx — struct-field facet + method promotion
  // through embedding; indexed Go projects need `--force-enrichments codegraph`.
  versions: { chunking: 1, walker: 2, codegraphSchema: 2 },
};

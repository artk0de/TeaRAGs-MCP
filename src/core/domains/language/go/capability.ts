import type { LanguageCapability } from "../../../contracts/types/language.js";

export const capability: LanguageCapability = {
  language: "go",
  ast: { tier: "full", engine: "tree-sitter", hooks: [{ name: "GoChunkClassifier", short: "func/type split" }] },
  tests: { tier: "medium", detection: "*_test.go", tech: "generic AST" },
  codegraph: { tier: "moderate", tech: "6-strategy; explicit interfaces (no poly dispatch)" },
};

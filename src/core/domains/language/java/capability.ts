import type { LanguageCapability } from "../../../contracts/types/language.js";

export const capability: LanguageCapability = {
  language: "java",
  ast: { tier: "full", engine: "tree-sitter", grammarPackage: "tree-sitter-java" },
  tests: { tier: "medium", detection: "*Test.java / *IT.java", tech: "generic AST" },
  codegraph: { tier: "moderate", tech: "6-strategy + java.lang stdlib whitelist + overload disambiguation" },
  // codegraphSchema 2: bd tea-rags-mcp-ex28m — see typescript/capability.ts.
  versions: { chunking: 1, walker: 1, codegraphSchema: 2 },
};

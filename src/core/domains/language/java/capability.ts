import type { LanguageCapability } from "../../../contracts/types/language.js";

export const capability: LanguageCapability = {
  language: "java",
  ast: { tier: "full", engine: "tree-sitter" },
  tests: { tier: "medium", detection: "*Test.java / *IT.java", tech: "generic AST" },
  codegraph: { tier: "moderate", tech: "6-strategy + java.lang stdlib whitelist + overload disambiguation" },
};

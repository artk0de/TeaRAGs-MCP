import type { LanguageCapability } from "../../../contracts/types/language.js";

export const capability: LanguageCapability = {
  language: "java",
  ast: { tier: "full", engine: "tree-sitter", grammarPackage: "tree-sitter-java" },
  tests: { tier: "medium", detection: "*Test.java / *IT.java", tech: "generic AST" },
  codegraph: { tier: "moderate", tech: "6-strategy + java.lang stdlib whitelist + overload disambiguation" },
  // codegraphSchema 2: bd tea-rags-mcp-ex28m — see typescript/capability.ts.
  // walker 2: bd tea-rags-mcp-f11nz — innermost-chunk call attribution. Every
  // in-method call used to be emitted a second time from its enclosing class
  // chunk; commons-lang measured 17,641 sites collapsing to 8,719, so an already
  // indexed Java project carries duplicate call rows until it recomputes.
  versions: { chunking: 1, walker: 2, codegraphSchema: 2 },
};

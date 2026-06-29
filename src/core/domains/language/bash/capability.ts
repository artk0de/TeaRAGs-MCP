import type { LanguageCapability } from "../../../contracts/types/language.js";

export const capability: LanguageCapability = {
  language: "bash",
  ast: { tier: "full", engine: "tree-sitter" },
  tests: { tier: "low", detection: "—", tech: "generic AST (bats/shunit not recognized)" },
  codegraph: { tier: "minimal", tech: "function-call extraction only, no dispatch" },
};

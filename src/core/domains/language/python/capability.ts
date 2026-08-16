import type { LanguageCapability } from "../../../contracts/types/language.js";

export const capability: LanguageCapability = {
  language: "python",
  ast: { tier: "full", engine: "tree-sitter", grammarPackage: "tree-sitter-python" },
  tests: { tier: "medium", detection: "test_*.py / *_test.py / conftest.py", tech: "generic AST" },
  codegraph: { tier: "moderate", tech: "6-strategy + ConeDispatch CHA; type hints where present" },
  // codegraphSchema 2: bd tea-rags-mcp-ex28m — see typescript/capability.ts.
  versions: { chunking: 1, walker: 1, codegraphSchema: 2 },
};

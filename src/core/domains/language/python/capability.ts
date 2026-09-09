import type { LanguageCapability } from "../../../contracts/types/language.js";

export const capability: LanguageCapability = {
  language: "python",
  ast: { tier: "full", engine: "tree-sitter", grammarPackage: "tree-sitter-python" },
  tests: { tier: "medium", detection: "test_*.py / *_test.py / conftest.py", tech: "generic AST" },
  codegraph: { tier: "moderate", tech: "6-strategy + ConeDispatch CHA; type hints where present" },
  // codegraphSchema 2: bd tea-rags-mcp-ex28m — see typescript/capability.ts.
  // walker 2: bd tea-rags-mcp-9fgdi — `ImportRef` now carries importedNames /
  // importedBindings, which the importedName strategy and the import file
  // mapper resolve through. A file walked by walker 1 has neither.
  // walker 3: bd tea-rags-mcp-y4hro — `classAncestors` records EVERY base
  // (including subscript ones) under a file-qualified class key. A file walked
  // by walker 2 has only the single-base `classExtends`.
  versions: { chunking: 1, walker: 3, codegraphSchema: 2 },
};

import type { LanguageCapability } from "../../../contracts/types/language.js";

export const capability: LanguageCapability = {
  language: "python",
  ast: { tier: "full", engine: "tree-sitter", grammarPackage: "tree-sitter-python" },
  tests: { tier: "medium", detection: "test_*.py / *_test.py / conftest.py", tech: "generic AST" },
  codegraph: {
    tier: "high",
    tech: "8-strategy chain (super, selfField, selfMember, localBinding, chainType, namingConvention, importedName, globalShortName) + ConeDispatch CHA + C3 linearization over file-qualified class keys, memoized once per run, with `super()` dispatching on that MRO from the entry after the enclosing class and every member lookup reading up it + import→file mapper resolving through symbol-table membership (seeded source roots plus a caller-ancestor scan, re-export hops, hop-bounded package re-export following to the file that declares a name, stdlib guard) + kernel receiver-chain propagation for dotted receivers, module-text receivers and call-result locals folded to their callee's return type + kernel return inference over return statements + subtype-gated naming-convention receiver typing + class-body manager attribute typing + annotation and docstring type facts",
  },
  // codegraphSchema 2: bd tea-rags-mcp-ex28m — see typescript/capability.ts.
  // walker 2: bd tea-rags-mcp-9fgdi — `ImportRef` now carries importedNames /
  // importedBindings, which the importedName strategy and the import file
  // mapper resolve through. A file walked by walker 1 has neither.
  // walker 3: bd tea-rags-mcp-y4hro — `classAncestors` records EVERY base
  // (including subscript ones) under a file-qualified class key. A file walked
  // by walker 2 has only the single-base `classExtends`.
  // walker 4: bd tea-rags-mcp-9fgdi (E2 seam 5) — two new channels. Chunks
  // carry `callResultBindings` (the callee spelling a local was assigned from,
  // which the resolver folds to a return type), and files carry
  // `classFieldTypesByClassKey`, the file-qualified field address the MRO fold
  // reads a base class's fields from. A file walked by walker 3 has neither, so
  // its call-result locals and its inherited fields stay untyped.
  versions: { chunking: 1, walker: 4, codegraphSchema: 2 },
};

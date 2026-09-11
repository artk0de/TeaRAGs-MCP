import type { LanguageCapability } from "../../../contracts/types/language.js";

export const capability: LanguageCapability = {
  language: "python",
  ast: { tier: "full", engine: "tree-sitter", grammarPackage: "tree-sitter-python" },
  tests: { tier: "medium", detection: "test_*.py / *_test.py / conftest.py", tech: "generic AST" },
  codegraph: {
    tier: "high",
    tech: "8-strategy chain (super, selfField, selfMember, localBinding, chainType, namingConvention, importedName, globalShortName) + ConeDispatch CHA fan-out consulted before the chain, RTA-pruned by the run-global instantiation set (name-only `dynamic` dispatch built, measured and PARKED behind `CODEGRAPH_PY_DYNAMIC_DISPATCH`, default off) + C3 linearization over file-qualified class keys, memoized once per run, with `super()` dispatching on that MRO from the entry after the enclosing class and every member lookup reading up it + import→file mapper resolving through symbol-table membership (seeded source roots plus a caller-ancestor scan, re-export hops, hop-bounded package re-export following to the file that declares a name, a module-shaped sibling hop that terminates on the FILE a package aliases as a submodule, stdlib guard) + kernel receiver-chain propagation for dotted receivers, module-text receivers and call-result locals folded to their callee's return type, split into hops at bracket depth zero so dots inside an argument list or a generic subscript stay in the argument + chain heads that are calls (generic subscript stripped, `typing.cast(T, x)` typed from argument one, a lowercase callee's recorded return read when the project declares exactly one definition of the name) + `-> Self` recorded as a marker and substituted with the class the RECEIVER names + kernel return inference over return statements + subtype-gated naming-convention receiver typing + class-body attribute typing from declared-or-import-bound constructors + class fields addressed both per-file by short name and run-global by file-qualified class key, with a field assigned from a CALL folded one level against the callee's return + annotation and docstring type facts, `Mapped[T]` read as transparent + an import shadow that spans the whole establishing statement + bare-call resolution in Python's LEGB order (enclosing frames, filtered before the pick, ahead of the caller's own module level, then builtins) with short-name candidates gated to same-language, bare-callable, non-builtin definitions",
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
  // walker 5: bd tea-rags-mcp-w205u (E4.0.5) — the resolver chain, not the
  // walker pass, but the rule routes a resolver-chain change here because it
  // moves what an already-indexed project PRODUCES without moving the chunk
  // set. Short-name resolution now admits same-language, bare-callable,
  // non-builtin candidates only, so an index built by walker 4 carries
  // cross-language and class-body edges this one never emits.
  versions: { chunking: 1, walker: 5, codegraphSchema: 2 },
};

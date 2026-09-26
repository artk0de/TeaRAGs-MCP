import type { LanguageCapability } from "../../../contracts/types/language.js";
import { testFiles } from "./test-files.js";

export const capability: LanguageCapability = {
  language: "python",
  ast: { tier: "full", engine: "tree-sitter", grammarPackage: "tree-sitter-python" },
  tests: { tier: "medium", detection: "test_*.py / *_test.py / conftest.py", tech: "generic AST" },
  testFiles,
  codegraph: {
    tier: "high",
    summary:
      "9-strategy chain + C3 MRO + CHA cone dispatch + dict-table dispatch + re-export-aware import mapping + annotation, docstring and return-type facts",
    tech: "9-strategy chain (super, clsMember, selfField, selfMember, localBinding, chainType, namingConvention, importedName, globalShortName) + dict-table dispatch consulted first: a module-level `NAME = {…}` whose values name callables (bare, dotted `Cls.method`, or a nested field dict) fans `NAME[k](…)` / `NAME.get(k)(…)` / a local bound to either out to every entry, a string-literal key narrowing to one, entries resolved the way a direct call from the table's module would be, plus the single-hop callback-param join when a table read is passed as an argument + class-object receivers resolved on the enclosing class's MRO, preferring the class-level symbolId spelling a `@classmethod` carries + ConeDispatch CHA fan-out consulted before the chain, RTA-pruned by the run-global instantiation set and narrowed by call-site arity and keyword keys (a positional parameter may be passed by name, so `arity` counts slots and `kwargs.optional` every nameable param; a `*args` call site omits its count rather than guessing) (name-only `dynamic` dispatch built, measured and PARKED behind `CODEGRAPH_PY_DYNAMIC_DISPATCH`, default off) + C3 linearization over file-qualified class keys, memoized once per run, with `super()` dispatching on that MRO from the entry after the enclosing class and every member lookup reading up it, a base spelled as a package module alias resolved through the sibling-module hop, and the legacy single-base walk declining a first hop the class's own ancestors do not name while the short name is declared in more than one file + import→file mapper resolving through symbol-table membership (seeded source roots plus a caller-ancestor scan, re-export hops, hop-bounded package re-export following to the file that declares a name, a module-shaped sibling hop that terminates on the FILE a package aliases as a submodule, stdlib guard) + kernel receiver-chain propagation for dotted receivers, module-text receivers and call-result locals folded to their callee's return type, split into hops at bracket depth zero so dots inside an argument list or a generic subscript stay in the argument + chain heads that are calls (generic subscript stripped, `typing.cast(T, x)` typed from argument one, a lowercase callee's recorded return read from a per-FILE `<relPath>::<name>` key rather than a run-global bare name, so six namesake `get_client` defs no longer share one fact) + namesake narrowing ahead of the import-SET filter: an ambiguous short name resolves to the file the CALLER's own import binding names, through one re-export hop, and refuses rather than guesses when no binding is in sight + `-> Self` recorded as a marker and substituted with the class the RECEIVER names, applied terminally on the call-result binding as well so the literal marker can never reach file resolution + kernel return inference over return statements + subtype-gated naming-convention receiver typing + class-body attribute typing from declared-or-import-bound constructors, its Django `as_manager` arm active only where the project's own manifests declare django (every pyproject.toml / requirements*.txt under the root, PEP 503 normalized, exact match; no manifest anywhere leaves every vocabulary on) + class fields addressed both per-file by short name and run-global by file-qualified class key, with a field assigned from a CALL folded one level against the callee's return + annotation and docstring type facts, `Mapped[T]` read as transparent + an import shadow that spans the whole establishing statement + bare-call resolution in Python's LEGB order (enclosing frames, filtered before the pick, ahead of the caller's own module level, then builtins) with short-name candidates gated to same-language, bare-callable, non-builtin definitions + an inert-file fast path that skips materializing a file whose native tree bears none of the node types the walker can extract from. Measured against jedi merged per file with a pyright LSP second engine, every chain-vs-oracle disagreement arbitrated by a third pyright vote: the `tiebroken` column that stage publishes is the precision figure to quote, and `legacy` stays beside it as the regression gate",
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
  // walker 6: bd tea-rags-mcp-4yvms — the pass-1 slice now persists
  // `classFieldTypesByClassKey` + `moduleReexports`; rows written by walker 5
  // carry neither, so an incremental run on them still mis-resolves cross-file
  // fields and package re-exports until the Python rows are rewritten.
  // walker 7: bd tea-rags-mcp-11qqk — the import mapper's re-export answers are
  // memoised per RUN rather than per symbol table, so a second run against one
  // pooled table no longer reads the first run's declarers. An index whose rows
  // were written by walker 6 can carry edges resolved through a re-export target
  // that had already moved, and nothing short of re-resolving them is coherent.
  // walker 8: bd tea-rags-mcp-z99hp — the ancestor linearizer is cached per RUN
  // (the identity of `classAncestors`) rather than per symbol table, so a second
  // run against one pooled table linearizes its own hierarchy instead of the
  // first run's. Rows written by walker 7 can carry member, `super()`,
  // cls-member and cone edges resolved on an MRO merged from a previous run's
  // base lists, and only re-resolving them is coherent.
  // walker 9: bd tea-rags-mcp-pbwd — dict-table dispatch. Files now carry
  // `dispatchTables` and `callbackParams`, and a call whose callee is a table
  // read (`T[k](…)`, `T.get(k)(…)`, a local bound to one) carries
  // `CallRef.dispatch` and fans out to the table's callables instead of going
  // through the chain. Rows written by walker 8 have neither channel, so those
  // sites keep their old bare-call answer until the Python rows are rewritten.
  // walker 11: bd tea-rags-mcp-jwjyr.1. The walker records the DECLARED
  // visibility on `ChunkExtraction.visibility` — a name-mangled `__name` method as private — persisted in
  // `cg_symbols.visibility`. Needs `--force-enrichments codegraph` to fill.
  // walker 11 (on its own branch): bd tea-rags-mcp-nbf8q — the package re-export hop
  // (`reexportOriginFile`) asks a Python-only lookup. A namesake another
  // language declares no longer makes the hop ambiguous or lands a Python
  // import on a `.ts` file, so imported-name, module-member and ancestor-base
  // edges move on polyglot repos.
  // walker 12: bd tea-rags-mcp-nbf8q — the facade answers
  // `hasInProjectDefinition` from Python files only, so a miss whose only
  // namesake is a `.ts` / `.rb` declaration books as `noInProjectDef` instead of
  // `missWithInProjectDef`. No edge moves; the persisted resolve rate does.
  // walker 13: the two branches above bumped 10 -> 11 independently and were
  // merged, so neither parent's index holds the merged extraction.
  // walker 14: bd tea-rags-mcp-4p3sb.3 — the walker publishes
  // `identifierDeclarations` (params, locals, `self.<attr>` fields, annotation
  // and CapWords-constructor types) for the naming lexicon. Rows written by
  // walker 13 carry none, so only the recompute adds them.
  // walker 16: bd tea-rags-mcp-4p3sb.21 — `identifierDeclarations` carries each
  // def's return annotation as a `return`, so a walker-15 index has no return
  // row for a module-level def (the structured channel keys it by file).
  // walker 14: bd tea-rags-mcp-r8hme.2. Every import records the names it
  // takes from the module (`importedExportNames`: the imported spelling, `*`
  // for a star import or `import m`), persisted on the file edge (migration
  // 030). No edge moves.
  // walker 17: the naming-lexicon branch (walker 16 there) rebased onto
  // integration walker 14; neither side's index holds both extractions.
  // walker 9: release v1.44.2 shipped walker 8 and a release cycle gets ONE
  // walker bump, so every branch-local number above collapses into 9.
  // Same walker 9, bd tea-rags-mcp-r8hme.12: an import inside an
  // `if TYPE_CHECKING:` body is flagged `typeOnly`, so its file edge moves from
  // `cg_symbols_edges_file` to `cg_symbols_edges_file_type_only`.
  versions: { chunking: 1, walker: 9, codegraphSchema: 2 },
  // PEP 8: classes CapWords, modules short lowercase (underscores allowed),
  // functions, methods, variables and attributes snake_case, module-level
  // constants SCREAMING_SNAKE.
  naming: {
    casing: {
      type: ["pascal"],
      module: ["snake"],
      method: ["snake"],
      param: ["snake"],
      local: ["snake"],
      field: ["snake"],
      constant: ["screamingSnake"],
    },
    // Builtins, plus the `typing` wrappers that name a container rather than a concept.
    nonConceptTypes: [
      "str",
      "int",
      "float",
      "complex",
      "bool",
      "bytes",
      "bytearray",
      "dict",
      "list",
      "set",
      "frozenset",
      "tuple",
      "type",
      "object",
      "None",
      "Any",
      "Optional",
      "Union",
      "Callable",
      "Dict",
      "List",
      "Set",
      "Tuple",
    ],
  },
};

import type { LanguageCapability } from "../../../contracts/types/language.js";
import { testFiles } from "./test-files.js";

export const capability: LanguageCapability = {
  language: "javascript",
  ast: {
    tier: "full",
    engine: "tree-sitter",
    grammarPackage: "tree-sitter-javascript",
    hooks: [
      { name: "jsAssignmentFilter", short: "assignment chunking" },
      { name: "testScopeChunker", short: "describe/it scopes" },
      { name: "JsChunkClassifier", short: "module/class split" },
    ],
  },
  tests: {
    tier: "high",
    detection: "*.test.js / *.spec.jsx",
    tech: "testScopeChunker (describe/it scopes, one addressable chunk per example)",
  },
  testFiles,
  codegraph: { tier: "high", tech: "6-strategy; CommonJS/ESM require resolution (dynamic gaps)" },
  // chunking 2: bd tea-rags-mcp-1etj8 — `jsTestDslFilterHook` +
  // `jsTestScopeChunkerHook` composed into the hook chain and
  // `call_expression` added to chunkable/child chunk types, so the already
  // advertised tests-high tier is actually implemented: `.js` / `.jsx` test
  // files now emit `chunkType: "test"` / `"test_setup"` scope chunks. Chunk
  // set moves → `--force` reindex for indexed projects with JS tests.
  // codegraphSchema 2: bd tea-rags-mcp-ex28m — see typescript/capability.ts.
  // walker 2: bd tea-rags-mcp-hwwtw — receiver-bearing calls no longer fall
  // through to the global short-name lookup.
  // walker 3: bd tea-rags-mcp-x9qsh — file edges come from
  // `JavascriptImportFileMapper` through the shared `resolveImportFileEdges`,
  // which the `JavaScriptLanguage` facade now forwards, instead of the
  // synthesised-call default, which dropped every explicit-extension import
  // (`./lib/render-changelog.js`) and sent two same-basename imports to one
  // file. An edge is emitted only to a file the index holds: `./config`
  // reaches `config/index.js`, a `.ts` / `.tsx` / `.mts` / `.cts` specifier its
  // file as written, and `../build/…` or a stylesheet no edge at all where the
  // default named `<file>.js` / `<file>.ts.js`. The call path still maps a
  // `.ts`-family or `.json` specifier as written rather than `<file>.ts.js`.
  // Also bd tea-rags-mcp-t5cji (same unreleased bump): lookups are restricted
  // to TypeScript / JavaScript files, so the bare-call fallback and `super` no
  // longer land on a Ruby or Python namesake, and such a call counts as
  // `noInProjectDef`.
  // walker 4: bd tea-rags-mcp-hkj8 — lookup-table dispatch (port of the
  // TypeScript n0zj mechanism). The walker records module-level const tables
  // (`dispatchTables`), tags `H[k]()` / `T[k].f()` / const-bound dispatch
  // locals with `CallRef.dispatch`, records `callbackParams` and
  // `dispatchArgs`; the resolver fans them out. New caller→candidate edges;
  // those call sites move from the `dynamic` / `index` buckets to `bareCall`.
  // walker 6: bd tea-rags-mcp-jwjyr.1. The walker records the DECLARED
  // visibility on `ChunkExtraction.visibility` — a class member's `#name` private access — persisted in
  // `cg_symbols.visibility`. Needs `--force-enrichments codegraph` to fill.
  // walker 7: bd tea-rags-mcp-4p3sb.4 — the walker publishes
  // `identifierDeclarations` (params, locals, class fields; `new X()` types)
  // for the naming lexicon. Rows written by walker 6 carry none, so only the
  // recompute adds them.
  // walker 7: bd tea-rags-mcp-r8hme.2. ESM imports, `require` and dynamic
  // `import()` record the export names they take (`importedExportNames`),
  // persisted on the file edge (migration 030). Re-exports still produce no
  // edge in this walker. No edge moves.
  // walker 9: the naming-lexicon branch (walker 8 there) rebased onto
  // integration walker 7; neither side's index holds both extractions.
  // walker 4: release v1.44.2 shipped walker 3 and a release cycle gets ONE
  // walker bump, so every branch-local number above collapses into 4.
  // Same walker 4, bd tea-rags-mcp-39xca.19: a method of the literal a named
  // function returns composes with `#` (`createOutcome#isFullSuccess`).
  // chunking 3: bd tea-rags-mcp-39xca.19 — the same `#` reaches the payload
  // `symbolId`, and a declarator-bound factory's members gain its segment.
  versions: { chunking: 3, walker: 4, codegraphSchema: 2 },
  // Google JavaScript Style Guide — the same convention as TypeScript:
  // classes UpperCamelCase, functions / methods / parameters / locals /
  // properties lowerCamelCase, a module binding lowerCamelCase or
  // UpperCamelCase, a constant lowerCamelCase or CONSTANT_CASE.
  naming: {
    casing: {
      type: ["pascal"],
      module: ["camel", "pascal"],
      method: ["camel"],
      param: ["camel"],
      local: ["camel"],
      field: ["camel"],
      constant: ["camel", "screamingSnake"],
    },
    // JavaScript types come from constructors only (`new Map()`), so only the built-in ones appear —
    // the constructible subset of TypeScript's list (no `Iterable`, `ReturnType` …: those are type-only).
    nonConceptTypes: [
      "undefined",
      "null",
      "String",
      "Number",
      "Boolean",
      "BigInt",
      "Symbol",
      "Object",
      "Function",
      "Array",
      "Map",
      "Set",
      "Promise",
      "WeakMap",
      "WeakSet",
      "WeakRef",
    ],
  },
};

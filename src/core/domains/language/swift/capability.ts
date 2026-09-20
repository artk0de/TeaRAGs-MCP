import type { LanguageCapability } from "../../../contracts/types/language.js";

export const capability: LanguageCapability = {
  language: "swift",
  ast: { tier: "full", engine: "tree-sitter", grammarPackage: "tree-sitter-swift" },
  tests: {
    tier: "high",
    detection: "*Test.swift / *Tests.swift / Tests/**",
    tech: "XCTest + swift-testing recognition (test cases, setUp/tearDown, @Test/@Suite); nesting via types, not a DSL scope tree",
  },
  codegraph: {
    tier: "moderate",
    tech: "6-strategy chain + implicit-self field typing + extension-scope member resolution; no import narrowing (Swift imports name modules)",
  },
  // walker 2: the call graph shipped (walker + `SwiftCallResolver`), so an index
  // built at walker 1 holds NO swift edges at all — not stale ones, none.
  // codegraphSchema 2: swift now EMITS method edges, which puts it in the bd
  // tea-rags-mcp-ex28m cohort whose edge primary key carries `source_rel_path`;
  // the rows the old key discarded come back only by re-extraction. That is the
  // rule `versions.test.ts` states for every edge-emitting language, so it is
  // not a judgement call once the graph exists.
  // chunking 2: the hook chain landed, so `.swift` test files now emit
  // `chunkType: "test"` / `"test_setup"` chunks an index built by chunking 1
  // never held, and `detectScope` switches that project from path-based to
  // chunkType-based test accounting the moment those counts are non-zero.
  versions: { chunking: 2, walker: 2, codegraphSchema: 2 },
  notes:
    "Type bodies (class/struct/enum/extension/actor) are scope containers whose funcs/inits extract as member chunks; extension methods attribute to the extended type. Computed/stored properties, subscripts, deinit and typealiases are not chunked. Codegraph resolves a receiver only where the walker PROVED a type — annotation, CapWords initializer, stored property, or self/Self — because Swift imports name modules, never symbols, so there is no import table to narrow anything else. Recall is therefore structurally capped below Java's; raising it is a typing problem (receiver-type propagation + conformance MRO), not a chain-ordering one.",
};

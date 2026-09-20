import type { LanguageCapability } from "../../../contracts/types/language.js";

export const capability: LanguageCapability = {
  language: "swift",
  ast: { tier: "full", engine: "tree-sitter", grammarPackage: "tree-sitter-swift" },
  tests: {
    tier: "high",
    detection: "*Test.swift / *Tests.swift / Tests/** / *Spec.swift / Specs/**",
    tech: "XCTest + swift-testing recognition (test cases, setUp/tearDown, @Test/@Suite) plus Quick/Nimble DSL scope chunking (per-scenario chunks with ancestor beforeEach spliced in)",
  },
  codegraph: {
    tier: "moderate",
    tech: "8-strategy chain + super over the superclass chain + implicit-self field typing + extension-scope and nested-type receivers; no import narrowing",
  },
  // walker 4: the walker publishes `classExtends` for the first time and the
  // chain gained a terminal `super` pass reading it, so edges exist that walker
  // 3 could not emit — measured 0.000 -> 0.688 (Alamofire) and 0.000 -> 0.167
  // (Quick) on that receiver kind, with every other kind unmoved.
  // walker 3: two independent movements, either of which would earn the bump.
  // The chain gained `scopedTypeReceiver` and stopped double-counting a type
  // re-opened by a same-file extension, so edges exist that walker 2 never
  // emitted. And the walker's type reads reached a REAL index for the first
  // time: tree-sitter-swift registers a type position under `name` as well as
  // `type`, `materializeTree` keeps one field name per child, and the pipeline
  // walks only materialized trees — so every annotated parameter, annotated
  // local and stored-property fact silently evaluated to nothing in production
  // while unit tests (which parse natively) stayed green.
  // codegraphSchema 2: swift EMITS method edges, which puts it in the bd
  // tea-rags-mcp-ex28m cohort whose edge primary key carries `source_rel_path`;
  // the rows the old key discarded come back only by re-extraction. That is the
  // rule `versions.test.ts` states for every edge-emitting language.
  // chunking 3: chunking 2 added XCTest / swift-testing labelling; chunking 3
  // adds the Quick scope chunker, which MOVES THE CHUNK SET — one giant `spec`
  // chunk becomes N scenario chunks with new ids and ranges — so the drift hint
  // must route `--force`, not `--force-enrichments`.
  versions: { chunking: 3, walker: 4, codegraphSchema: 2 },
  notes:
    "Type bodies (class/struct/enum/extension/actor) are scope containers whose funcs/inits extract as member chunks; extension methods attribute to the extended type. Computed/stored properties, subscripts, deinit and typealiases are not chunked. Codegraph resolves a receiver only where the walker PROVED a type — an annotation, a CapWords initializer, a stored property, self/Self, a guard-let/if-let unwrap of any of those, a same-file declared return type, or the element type of an [T] collection in a for-in — because Swift imports name modules, never symbols, so there is no import table to narrow anything else. Recall is therefore structurally capped below Java's; the remaining gap is cross-file return types and conformance MRO, a typing problem rather than a chain-ordering one. `super.X()` is the one receiver the LANGUAGE types rather than the walker: it dispatches on the first inheritance specifier, which Swift requires to be the superclass, and it is terminal — a miss drops instead of falling through to a namesake. Its own ceiling is ownership rather than inference: a class rooted in UIKit or XCTest has no project superclass to resolve into, which is most of what it cannot answer. A type re-opened by a same-file extension is counted once, so construction into it resolves; the same type re-opened ACROSS files stays ambiguous, because nothing in a symbol definition says which file carries the body.",
};

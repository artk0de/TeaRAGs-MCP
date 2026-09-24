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
    tech: "9-strategy chain + super over the superclass chain + implicit-self and chained field typing + extension-scope and nested-type receivers; no import narrowing",
  },
  // walker 10: a type name a walker fact WROTE short resolves to the nested
  // type it denotes. Members compose under the qualified id
  // (`DataStreamRequest.CancellationToken#cancel`), but a property or local
  // annotated `CancellationToken` inside `DataStreamRequest` carries the short
  // spelling, so every member lookup on it probed an id nothing declares.
  // `qualifySwiftTypeName` keeps a name that some declaration composes under
  // as-is, and otherwise takes the one nested type declaration whose last
  // segments are the name — narrowed, when several exist, to the one nested in
  // a type enclosing the caller (`URLEncoding.Destination` vs
  // `URLEncodedFormParameterEncoder.Destination`). Still ambiguous stays
  // unresolved. Measured TOTAL 0.564 -> 0.568 (846 -> 852 of 1501, Alamofire;
  // dynamic 0.206 -> 0.218), Quick unmoved; under grammar 0.7.3 0.701 -> 0.706
  // (seven edges, including the `token.cancel` a 0.7.3 parse had retargeted
  // away). Zero edges lost on either grammar. So an index built by walker 9
  // holds no edge into a member of a nested type reached through its short
  // name.
  // walker 9: the walker PUBLISHES its declared return types, run-global under
  // `structuredReturnTypes`, keyed by the callee's own composed symbolId
  // (overload suffix included, taken from the chunk collected at the
  // declaration rather than recomposed). The chain fold reads them for a METHOD
  // hop — resolve the hop to the declaration the call lands on (own type, then
  // superclass), then read what that symbol returns — over the bracket-aware
  // hop split, since an argument list carries its own dots. And a head that
  // spells its own type is typed: a parenthesised cast `(x as T)` and an array
  // or dictionary literal (`Array` / `Dictionary`). Walker 6's note recorded the
  // return-type channel as built, measured at zero edges and NOT shipped; it
  // pays now because inherited dispatch (walker 8) and a parseable Session /
  // SessionDelegate landed first. Measured TOTAL 0.563 -> 0.564 (845 -> 846 of
  // 1501, Alamofire; chain 0.091 -> 0.099), Quick unmoved — one edge,
  // `DebugDescription.description(for:).indentingNewlines` into the project's
  // own `extension String`. Under grammar 0.7.3 it is 0.698 -> 0.701, adding
  // three `stateProvider.request(for: task).<m>` edges into `Request`, which
  // 0.7.1 cannot reach because it fails to parse SessionDelegate.swift. The
  // cast and literal heads type the three `index` sites (a `Dictionary.map`,
  // an `Array.compactMap`), which DROP correctly: the standard library, not
  // the project, declares those. So an index built by walker 8 carries no
  // return type and no edge off a call hop.
  // walker 8: a member INHERITED from the superclass resolves. Every pass that
  // proves a receiver's type — a local, a stored property, a chained field, a
  // scoped type name, and `self` / a bare call through the extension-scope
  // pass — looked the member up on that type ALONE, so `request.resume()` on a
  // `DataRequest` dropped: `resume` lives on `Request`. They now share one walk
  // (`SwiftMemberTypeLookup#memberOn`), the superclass chain `super` and the
  // field lookup already use, stopping at the first class that declares the
  // member at all so an ambiguous own declaration never falls through to a
  // base. A class whose first inheritance specifier is a PROTOCOL walks into it
  // too, which lands on the protocol extension's default implementation —
  // `lock.around` on an `UnfairLock: Lock` reaches `Lock#around`, which is the
  // body that runs. Measured TOTAL 0.546 -> 0.563 (820 -> 845 of 1501,
  // Alamofire; selfMember 0.556 -> 0.741, dynamic 0.184 -> 0.206), Quick
  // unmoved at 0.523: 25 edges gained, none lost, all into `Request#…` and
  // each checked against the subclass for an override. Under grammar 0.7.3,
  // 0.673 -> 0.698 and selfMember 1.000 on both corpora. So an index built by
  // walker 7 holds no edge into an inherited member.
  // walker 7: a TYPE chunk's own calls now run inside the type. Swift chunks
  // neither a computed property, a subscript, a `deinit` nor a stored-property
  // initializer, so their calls land on the type's own chunk — whose `scope`
  // is, honestly, its PARENT's (`[]` for a top-level type). Every type-based
  // pass was dead there. `swiftNameOf` now opts its containers into the kernel's
  // `bodyScope`, and the runner hands that to the chunk's calls as
  // `callerScope`. Taking it exposed that the resolver read the enclosing type
  // as the bare LAST scope segment, which is wrong twice over: a nested type's
  // members compose as `Outer.Inner#m`, not `Inner#m`, and a local function's
  // segment is a function, not a type. So the enclosing type is now the scope
  // PREFIX at the innermost UpperCamelCase segment, `self` stops there, and a
  // bare name walks the enclosing types outward the way Swift's unqualified
  // lookup does — which is what keeps `Options(rawValue:)` inside
  // `DownloadRequest.Options` landing on `DownloadRequest.Options`. Measured
  // TOTAL 0.545 -> 0.546 (818 -> 820 of 1501, Alamofire) and 0.513 -> 0.523
  // (210 -> 214 of 409, Quick), bareCall 0.870 -> 0.874 and 0.820 -> 0.842:
  // 11 edges gained, every one hand-checked (a subscript getter, a computed
  // property, a `deinit`, a stored-property initializer, an `onCancel:`
  // closure), and 5 lost — all five into `Session.swift#webSocketRequest#…`,
  // ids that exist only because tree-sitter-swift 0.7.1 fails to parse that
  // file and names a FUNCTION as the enclosing scope. Under the 0.7.3 grammar
  // the same change measures 0.664 -> 0.673 and 0.816 -> 0.844 with nothing
  // lost. So an index built by walker 6 carries none of the type-body edges.
  // walker 6: two independent movements, measured separately and shipped
  // together. The walker's type reduction now sees an EXISTENTIAL annotation —
  // `any Proto`, and the `(any Proto)?` spelling Swift requires for an optional
  // one, which the grammar wraps in a one-element `tuple_type` that is really
  // just parentheses. Swift 5.7 made `any` mandatory, so this is how modern
  // code SPELLS protocol-typed storage: Alamofire writes 200+ of its
  // annotations that way, and every one of them typed to nothing under walker
  // 5, taking the parameter, the local and the stored property with it. And
  // `storedPropertyType` stopped reading the caller's own `classFieldTypes`
  // alone, folding instead through the same lookup the chain pass uses — the
  // run-global union first, then up the superclass chain — so an implicit-self
  // property an `extension` declares in ANOTHER file is typed at last.
  // Measured TOTAL 0.500 -> 0.545 (751/1501 -> 818/1501, Alamofire) and 0.506
  // -> 0.513 (207/409 -> 210/409, Quick): dynamic 0.053 -> 0.184 and chain
  // 0.050 -> 0.091 on Alamofire, dynamic 0.130 -> 0.185 on Quick, with every
  // other receiver kind unmoved and none losing an edge. The split is clean —
  // the existential reduction is worth all 67 Alamofire edges and none of
  // Quick's, the union all 3 of Quick's and none of Alamofire's — because
  // Quick barely uses `any` and Alamofire declares its properties in the files
  // that use them. So an index built by walker 5 carries neither the
  // protocol-typed facts nor any edge off a cross-file property.
  //
  // What did NOT ship, having been built and measured: publishing declared
  // return types run-global so a chained CALL (`a.makeThing().run()`) could be
  // typed. Zero edges on both corpora, and still zero with the existential fix
  // in place — the chained calls these corpora contain either land on
  // Foundation / Combine / stdlib types the index never declares, or start
  // from a head no channel keys. `resolver/swift-receiver-type-ports.ts`
  // records the verdict where the next reader will look for it.
  // walker 5: TWO halves that only pay together, which is why they share one
  // bump. The walker now publishes its field facts under the run-global
  // `classFieldTypesByClassKey` address as well as the per-file
  // `classFieldTypes` one; and the chain gained `chainedReceiverType`, which
  // threads a DOTTED receiver through the kernel's receiver fold — head from
  // `localBindings` / `self` / a stored property / a declared type name, then
  // one field hop per link, read up the superclass chain and unioned across
  // every file that re-opens the type. Either half alone is worth almost
  // nothing: the pass without the address measures +1 edge, because
  // `classFieldTypes` reaches a resolver PER-FILE and hop 2's type is declared
  // somewhere else. Together, measured chain 0.008 -> 0.050 (1/121 -> 6/121,
  // Alamofire) and 0.000 -> 0.341 (0/91 -> 31/91, Quick), TOTAL 0.497 -> 0.500
  // and 0.430 -> 0.506, with every other receiver kind unmoved. So an index
  // built by walker 4 carries neither the address nor any edge for a dotted
  // receiver beyond the single-property `self.<x>` form.
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
  versions: { chunking: 3, walker: 11, codegraphSchema: 2 },
  notes:
    "Type bodies (class/struct/enum/extension/actor) are scope containers whose funcs/inits extract as member chunks; extension methods attribute to the extended type. Computed/stored properties, subscripts, deinit and typealiases are not chunked. Codegraph resolves a receiver only where the walker PROVED a type — an annotation, a CapWords initializer, a stored property, self/Self, a guard-let/if-let unwrap of any of those, a same-file declared return type, or the element type of an [T] collection in a for-in — because Swift imports name modules, never symbols, so there is no import table to narrow anything else. Recall is therefore structurally capped below Java's; the remaining gap is cross-file return types and conformance MRO, a typing problem rather than a chain-ordering one. `super.X()` is the one receiver the LANGUAGE types rather than the walker: it dispatches on the first inheritance specifier, which Swift requires to be the superclass, and it is terminal — a miss drops instead of falling through to a namesake. Its own ceiling is ownership rather than inference: a class rooted in UIKit or XCTest has no project superclass to resolve into, which is most of what it cannot answer. A type re-opened by a same-file extension is counted once, so construction into it resolves; the same type re-opened ACROSS files stays ambiguous, because nothing in a symbol definition says which file carries the body.",
};

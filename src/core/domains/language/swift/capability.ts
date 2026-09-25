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
    tier: "high",
    tech: "10-strategy chain + super and inherited members over the superclass chain + implicit-self and chained field typing + return-typed call hops + extension-scope, nested-type and module-level-value receivers; no import narrowing",
    summary:
      "10-strategy chain + superclass dispatch + field and return-type receiver typing + nested-type and module-value receivers; no import narrowing",
  },
  // walker 45: a module-level value (`public let AF = Session.default`) is
  // published run-global under the module-scope key `<relPath>::` — typed on
  // `classFieldTypesByClassKey`, else by spelling on `classFieldCallResults`
  // — and a receiver naming it types by it, through a new `moduleValue` pass
  // and the chain fold's head (bd tea-rags-mcp-y99pg.30). Measured: Alamofire
  // TOTAL 0.974 -> 0.980 (1241/1274 -> 1248/1274), Quick unchanged 0.997;
  // edges +7 / -0, all `AF.*` in the example apps; oracle WRONG unchanged.
  // walker 41: a protocol composition (`Subscriber & Sendable`, `any Sendable &
  // Monitor`) types as its one non-marker protocol; two real protocols type
  // nothing (bd tea-rags-mcp-y99pg.28). Measured: Alamofire TOTAL 0.971 ->
  // 0.974 (1241/1278 -> 1241/1274), Quick unchanged; edges +0 / -0, 4 SDK
  // sites proved external.
  // walker 40: a string literal binds String and a non-empty array literal
  // binds Array of its elements' common type (bd tea-rags-mcp-y99pg.27).
  // Measured: Alamofire TOTAL 0.966 -> 0.971 (1241/1285 -> 1241/1278), Quick
  // unchanged; edges +0 / -0, 7 SDK `Array.append` sites proved external.
  // walker 39: a stored property initialized by a construction publishes its
  // generic arguments — spelled (`Protected<[T]>(…)`) or bound through the
  // generic initializer its argument labels select (`Protected(State())`
  // runs `init(_ value: Value)`) — so its closure parameters type (bd
  // tea-rags-mcp-y99pg.26). Measured: Alamofire TOTAL 0.953 -> 0.966
  // (1239/1300 -> 1241/1285), Quick unchanged 0.997; edges +2 / -0, 15 SDK
  // sites proved external, 0 FIXABLE hidden.
  // walker 38: the receiver fold types SDK links from the substrate — SDK
  // property types and method returns with the receiver's generic arguments
  // substituted, SDK construction and string-literal heads, implicit-self SDK
  // members of an extended SDK type, SDK closure parameters — and a call whose
  // labels fit no project overload of a member the SDK also declares leaves
  // the denominator (bd tea-rags-mcp-y99pg.25). Measured (swiftc -dump-ast
  // oracle): Alamofire TOTAL 0.938 -> 0.953 (1234/1315 -> 1239/1300), Quick
  // 0.995 -> 0.997 (375/377 -> 375/376); edges +5 / +0, -0 / -0, every gained
  // oracle-covered edge the typechecker's target, every excluded
  // oracle-covered site an SDK target.
  // walker 37: the SDK facts the resolver reads — which names are SDK types,
  // an SDK type's superclass chain and conformances, whether a re-opened name
  // is an SDK type — come from a GENERATED substrate
  // (`swift/vocabulary/sdk-vocabulary.generated.ts`, from
  // swift-symbolgraph-extract) instead of three hand-written lists; member
  // lookup now walks an SDK class's superclass chain (`OutputStream` reaches
  // `extension Stream`) (bd tea-rags-mcp-y99pg.24). Measured (swiftc -dump-ast
  // oracle): Alamofire TOTAL 0.938 unchanged (1234/1315), Quick 0.995
  // unchanged; edges +0 / +0, -0 / -0.
  // walker 36: a type publishes what each function-typed alias it declares
  // returns (`functionAliasReturns`), and a stored closure of that alias called
  // as a chain head (`responseHandler { … }.resume()`) types by it (bd
  // tea-rags-mcp-y99pg.22). Measured (swiftc -dump-ast oracle): Alamofire TOTAL
  // 0.936 -> 0.938 (1231/1315 -> 1234/1315), Quick 0.995 unchanged; edges
  // +3 / +0, -0 / -0.
  // walker 35: `super.init()` with no initializer declared up the project chain
  // lands on the project superclass (its implicit initializer), where it dropped
  // (bd tea-rags-mcp-y99pg.21). Measured (swiftc -dump-ast oracle): Quick TOTAL
  // 0.992 -> 0.995 (374/377 -> 375/377), Alamofire 0.936 unchanged; edges
  // +0 / +1, -0 / -0.
  // walker 34: a chain head is read past `try` / `await`, and a head naming a
  // type nested in an enclosing type resolves to it lexically (bd
  // tea-rags-mcp-y99pg.20). Measured (swiftc -dump-ast oracle): Alamofire TOTAL
  // 0.934 -> 0.936 (1228/1315 -> 1231/1315), Quick 0.992 unchanged; edges
  // +3 / +0, -0 / -0.
  // walker 33: a generic-argument extension publishes the id its members compose
  // under (`spelledAs: "Collection<String>"`), and member lookup reaches an SDK
  // type's standard-library conformances (bd tea-rags-mcp-y99pg.19). Measured
  // (swiftc -dump-ast oracle): Alamofire TOTAL 0.933 -> 0.934 (1227/1315 ->
  // 1228/1315), Quick 0.992 unchanged; edges +1 / +0, -0 / -0.
  // walker 32: INVARIANT CHANGED — a `-> Self` return publishes the `Self`
  // marker in `structuredReturnTypes` (the resolver substitutes the receiver's
  // type), where it published nothing (bd tea-rags-mcp-y99pg.18). Measured
  // (swiftc -dump-ast oracle): Alamofire TOTAL 0.931 -> 0.933 (1224/1315 ->
  // 1227/1315), Quick 0.992 unchanged; edges +3 / +0, -0 / -0, all the
  // typechecker's target.
  // walker 31: INVARIANT CHANGED — `[T]()` / `[K: V]()` constructions type as
  // Array / Dictionary, and a `for (k, v) in` over a dictionary binds its key and
  // value types, where a tuple pattern bound nothing (bd tea-rags-mcp-y99pg.17).
  // Measured (swiftc -dump-ast oracle): Quick TOTAL 0.981 -> 0.992
  // (370/377 -> 374/377), Alamofire 0.931 unchanged; edges +0 / +4, -0 / -0,
  // all the typechecker's target.
  // walker 30: enums publish their cases' payload types (`enumCasePayloads`) and
  // a switch case's payload names are bound to the subject they destructure
  // (bd tea-rags-mcp-y99pg.16). Measured (swiftc -dump-ast oracle): Alamofire
  // TOTAL 0.929 -> 0.931 (1221/1315 -> 1224/1315), Quick 0.981 unchanged;
  // edges +3 / +0, -0 / -0, all the typechecker's target.
  // walker 29: a construction of a type the project only extends lands on the
  // file declaring the extension initializer its labels fit, and a bare name no
  // longer sees a nested type whose container does not enclose the caller
  // (bd tea-rags-mcp-y99pg.15). Measured (swiftc -dump-ast oracle): Alamofire
  // TOTAL 0.921 -> 0.929 (1216/1321 -> 1221/1315), Quick 0.981 unchanged;
  // edges +5 / +0, -0 / -0, all the typechecker's target.
  // walker 28: INVARIANT CHANGED — an `[T]` value binds `Array` and a `[K: V]`
  // one `Dictionary` (element kept for for-in and element accessors), where both
  // bound nothing; member lookup on Array / Dictionary also reads the sugar
  // re-openings `extension [HTTPHeader]` composes under (bd tea-rags-mcp-y99pg.14).
  // Measured (swiftc -dump-ast oracle): Alamofire TOTAL 0.892 -> 0.921
  // (1209/1355 -> 1216/1321), Quick 0.971 -> 0.981 (366/377 -> 370/377); edges
  // +7 / +4, -0 / -0, all the typechecker's target.
  // walker 27: the resolve-rate denominator stops charging a call whose receiver
  // is TYPED and whose member no type on that receiver's hierarchy, conformances
  // or possible SDK-protocol extensions declares (`task.resume()` on a
  // `URLSessionTask`, `super.awakeFromNib()` on a UIKit superclass,
  // `MainActor.run`), and a construction of an extension-only type whose labels
  // no extension initializer takes (bd tea-rags-mcp-y99pg.11). Edges are
  // unchanged; the persisted `cg_run_stats` rate moves: Alamofire TOTAL 0.836 ->
  // 0.892 (1209/1446 -> 1209/1355), Quick 0.917 -> 0.971 (366/399 -> 366/377),
  // every excluded oracle-covered site the typechecker's own SDK target.
  // walker 26: a type publishes its generic parameters, the generic arguments of
  // its stored properties and the parameter types of each method's closure on
  // `typeDeclarations`, and a closure literal the file cannot type binds its
  // parameters by the callee they are passed to (`CallResultBinding`
  // `closureParameter`), so `mutableState.write { mutableState in … }` on a
  // `Protected<MutableState>` types the parameter as `MutableState` across files
  // (bd tea-rags-mcp-y99pg.13). Measured (swiftc -dump-ast oracle): Alamofire
  // TOTAL 0.826 -> 0.836 (1195 -> 1209 of 1446), Quick unmoved at 0.917; edges
  // +14 / -0, all the typechecker's target.
  // walker 25: a parameter is typed past its modifiers (`inout`, `@escaping`)
  // and a metatype annotation (`Foo.Type`, `Foo.Protocol`) types its value as
  // Foo, whose static members a call on it reaches (bd tea-rags-mcp-y99pg.12).
  // Measured (swiftc -dump-ast oracle): Alamofire TOTAL 0.825 -> 0.826 (+2
  // edges), Quick 0.915 -> 0.917 (+1), all three oracle-correct, none lost.
  // walker 24: merge of the identifier-record fix (bd tea-rags-mcp-f4ce0,
  // walker 10 -> 11 on its own line) into walker 23 — a binding, field or
  // type named like an `Object.prototype` member (`description`,
  // `constructor`) now extracts, so an index built by walker 23 drops it.
  // walker 23: every function records its argument-label signature (labelled
  // parameters as keywords, unlabelled ones as positional slots, closure
  // acceptance three-valued) and every call site its labels, count and trailing
  // closure, so an overloaded member resolves to the declaration the call's
  // labels reach (bd tea-rags-mcp-y99pg.7). Measured (swiftc -dump-ast oracle):
  // Alamofire TOTAL 0.826 -> 0.825 (1195 -> 1193 of 1446; the two lost edges
  // were wrong self.init targets), Quick unmoved at 0.915; the edge landing on
  // the oracle's own overload rose 909 -> 1067 of 1126 (Alamofire) and
  // 245 -> 258 of 279 (Quick), wrong-file edges 13 -> 7. So an index built by
  // walker 22 points overloaded calls at the first namesake.
  // walker 22: an explicitly specialised construction (`Protected<[T]>(...)`,
  // `DataResponse<T, E>(...)`), which tree-sitter-swift parses as a
  // `constructor_expression` rather than a call, is now emitted as a call site
  // and types the local or property it initialises; a `catch` block without a
  // pattern binds `error` as `Error` for its own lines (bd
  // tea-rags-mcp-y99pg.10). Measured (swiftc -dump-ast oracle): Alamofire TOTAL
  // 0.817 -> 0.826 (1162/1422 -> 1195/1446; bareCall 638/650 -> 660/674,
  // dynamic 219/339 -> 223/333), Quick unmoved at 0.915. Edges +33 / -0; oracle
  // resolved-ok 1095 -> 1126, nothing disputed. So an index built by walker 21
  // has no edge for any specialised construction.
  // walker 21: a leading underscore no longer hides a type name
  // (`_URLEncodedFormEncoder` is a type, and a construction of it or of its
  // nested `UnkeyedContainer` reads as one), and a type receiver named from
  // outside its declaration (`DebugDescription.description(of:)`,
  // `QuickConfiguration.configureSubclassesIfNeeded`) resolves at module scope
  // (bd tea-rags-mcp-y99pg.9). Measured (swiftc -dump-ast oracle): Alamofire
  // TOTAL 0.802 -> 0.817 (1140 -> 1162 of 1422; constant 5/25 -> 16/25, bareCall
  // 633/650 -> 638/650), Quick 0.900 -> 0.915 (360 -> 366 of 400; constant 0/16
  // -> 6/16). Edges +22 / +6, -0 / -0; no oracle-covered gain disputed. So an
  // index built by walker 20 misses every call on an explicit type receiver.
  // walker 20: protocol property requirements (`var serverTrustManager:
  // ServerTrustManager? { get }`) publish their types like stored properties, and
  // an `[T]` value's element accessors (`first`, `last`, `removeFirst()`,
  // `popLast()`, ...) type their result as the element (bd tea-rags-mcp-y99pg.6).
  // Measured (swiftc -dump-ast oracle): Alamofire TOTAL 0.798 -> 0.802 (1135 ->
  // 1140 of 1422; localVar 135/184 -> 138/187, dynamic 213/342 -> 213/339),
  // Quick unmoved at 0.900. Edges +5 / -0, all the typechecker's target. So an
  // index built by walker 19 leaves every protocol-typed chain unfolded past its
  // first requirement.
  // walker 19: invoking a closure VALUE is no longer emitted as a call (bd
  // tea-rags-mcp-y99pg.8) — a bare `name(...)` whose name is a parameter of an
  // enclosing function or closure, or a local declared above it, and every
  // optional call `name?(...)`. The terminal short-name pass used to land them on
  // a namesake method (`stream(...)` on `Request#stream`, `requestDidFinish?(r)`
  // on the protocol method the closure property mirrors). Measured (swiftc
  // -dump-ast oracle): Alamofire TOTAL 0.798 (1145/1434 -> 1135/1422, bareCall
  // 643/662 -> 633/650), oracle resolved-wrong-nonsymbol 10 -> 0, resolved-ok
  // unchanged at 1075; Quick unmoved at 0.900. So an index built by walker 18
  // carries ten fabricated edges per such corpus.
  // walker 18: a type's conventional singleton (`NotificationCenter.default`,
  // `URLSession.shared`, `DispatchQueue.main`, `.current`, `.standard`) types as
  // an instance of the type when nothing the project declares answers first, so a
  // call on it lands on the project's extension of that type (bd
  // tea-rags-mcp-y99pg.5). Measured (swiftc -dump-ast oracle): Alamofire TOTAL
  // 0.793 -> 0.798 (1137 -> 1145 of 1434; chain 48/121 -> 56/121), Quick unmoved
  // at 0.900. Edges +8 / -0, all 8 `NotificationCenter.default.postNotification`
  // landing on the typechecker's target.
  // walker 17: a local whose right-hand side is a value chain this file cannot
  // type (`let evaluator = try stateProvider?.serverTrustManager?.evaluator(...)`,
  // `a ?? b` read as `a`) is published by SPELLING in `callResultBindings`, and
  // the resolver folds it through the kernel receiver fold, strictly below its
  // own line (bd tea-rags-mcp-y99pg.6). A cast (`x as? Foo`) types its local
  // outright, and a local declared inside a closure ends at the closure's brace.
  // Measured (swiftc -dump-ast oracle): Alamofire TOTAL 0.788 -> 0.793 (1130 ->
  // 1137 of 1434; chain 45 -> 48, dynamic 212 -> 214), Quick 0.870 -> 0.900
  // (348 -> 360 of 400; chain 82/93 -> 90/93, dynamic 41 -> 45). Edges +7 / +12,
  // -0 / -0; every oracle-covered gain the typechecker's target. So an index
  // built by walker 16 carries no spelling for such a local.
  // walker 16: a generic parameter reads as its constraint (bd
  // tea-rags-mcp-y99pg.6). `responseSerializer: Serializer` under
  // `<Serializer: DataResponseSerializerProtocol>`, and a stored property typed by
  // the enclosing type's `where AuthenticatorType: Authenticator`, are typed as
  // the protocol whose requirement the call dispatches on; an unconstrained one
  // (and an associated type such as `Serializer.SerializedObject`) types nothing,
  // where walker 15 recorded the bare generic name. A generic return bound by a
  // metatype argument (`request(for: task, as: DataRequest.self)` over
  // `-> R?` with `as type: R.Type`) types the local as the named type. `some P`
  // reads as `P`. Measured (swiftc -dump-ast oracle): Alamofire TOTAL 0.775 ->
  // 0.788 (1111 -> 1130 of 1434; localVar 116/168 -> 131/176, dynamic 209/358 ->
  // 212/350), Quick unmoved at 0.870. Edges +19 / -0, all 19 the typechecker's
  // target. So an index built by walker 15 misses every call on a generic-typed
  // value.
  // walker 15: a closure's parameters take their types from the parameter the
  // closure is passed to (bd tea-rags-mcp-y99pg.3). `performEvent { $0.x() }`
  // types `$0` (and a named `m in`) from the callee's ONE function-typed
  // parameter when this file declares the callee, and `xs.forEach { $0.x() }`
  // from the element of an `[T]` receiver. A callee with two function-typed
  // parameters, a generic parameter type, and a closure nesting an
  // implicit-parameter closure it cannot type all bind nothing. Measured
  // (swiftc -dump-ast oracle): Alamofire TOTAL 0.744 -> 0.775 (1067 -> 1111 of
  // 1434; the 44 `$0` sites move from dynamic to localVar, localVar 72/124 ->
  // 116/168), Quick unmoved at 0.870. Edges +44 / -0, all 44 the typechecker's
  // target (`EventMonitor#request`, `EventMonitor#urlSession`). So an index
  // built by walker 14 binds no closure parameter.
  // walker 14: member lookup walks every protocol a type conforms to after its
  // superclass chain (bd tea-rags-mcp-y99pg.4), reading the conformances every
  // declaration and re-opening names off the `typeDeclarations` channel;
  // `extension SecTrust: AlamofireExtended {}` is what makes `trust.af` an
  // `AlamofireExtension`. `super` keeps the superclass-only walk. Measured
  // (swiftc -dump-ast oracle): Alamofire TOTAL 0.729 -> 0.744 (1045 -> 1067 of
  // 1434; chain 0.231 -> 0.364, dynamic 0.505 -> 0.520), Quick unmoved at 0.870.
  // Edges +22 / -0, all 22 the typechecker's target (`trust.af.*`,
  // `SecPolicy.af.*`, `error.asAFError`). So an index built by walker 13 misses
  // every member reached through a conformance.
  // walker 13: the walker publishes `typeDeclarations`, a hydrated run-global
  // channel naming the files that DECLARE a type and the files that only re-open
  // it (bd tea-rags-mcp-y99pg.1). `extension World` composes exactly the id
  // `class World` does, so the lookups could not tell them apart: a type re-opened
  // across files read as ambiguous, and a type the project only extends read as
  // one it declares. The lookups now keep a type id's declaring file, and a
  // construction of a type the project only EXTENDS (`JSONDecoder()`, `Array(x)`,
  // `URL(string:)`) emits no edge and leaves the denominator unless an extension
  // declares an initializer. Measured (swiftc -dump-ast oracle): Alamofire TOTAL
  // 0.712 -> 0.729 (1071/1505 -> 1045/1434; bareCall 0.913 -> 0.971), Quick
  // 0.844 -> 0.870 (bareCall 0.923 -> 1.000). Edges: +7 / +4, every one the
  // typechecker's target (`World()`, `AsyncWorld()`, `DataRequest(...)`); -33 /
  // -18, every one a construction the oracle binds to an SDK initializer (31 + 5
  // oracle-covered, the rest in files the oracle does not compile). So an index
  // built by walker 12 carries no declaration fact at all.
  // walker 12: a property's type is qualified from the type that DECLARES the
  // property, not from the caller. `var dataEncoding: DataEncoding` written inside
  // `URLEncodedFormEncoder` names `URLEncodedFormEncoder.DataEncoding`, and a
  // `_URLEncodedFormEncoder` method reading it encloses no such type, so the old
  // caller-scope qualification found nothing. `SwiftMemberTypeLookup#typeOfProperty`
  // now hands the defining class to `qualifySwiftTypeNameWithin`, which walks
  // Swift's lexical lookup from that owner outward before falling back. Measured
  // (swiftc -dump-ast oracle, grammar 0.7.3): Alamofire TOTAL 0.706 -> 0.712
  // (1062 -> 1071 of 1505; dynamic 0.485 -> 0.505, chain 0.223 -> 0.231), Quick
  // unmoved; 9 edges gained, every one the typechecker's own target, 0 lost. So an
  // index built by walker 11 holds no edge through a field typed by a nested type
  // of the field's owner.
  // tree-sitter-swift 0.7.1 -> 0.7.3 (walker 11, chunking 4). Upstream tagged
  // 0.7.3 but never published it to npm, so it ships as our own N-API prebuild
  // package `@artk0de/tree-sitter-swift@0.7.3-prebuild.1`, built from the
  // pinned upstream release asset by `scripts/vendor/tree-sitter-swift/`. The
  // grammar now parses `@unchecked Sendable`, `#if` inside a type body and
  // `nonisolated(unsafe)`, each of which 0.7.1 turned into ERROR nodes that
  // cost whole files their scopes (Session.swift, SessionDelegate.swift) and
  // minted ids like `Session.swift#webSocketRequest#init` for members of a
  // type. Measured at walker 10, per receiverKind, 0.7.1 -> 0.7.3:
  //   Alamofire TOTAL 0.568 -> 0.706 (852/1501 -> 1062/1505); localVar
  //   0.317 -> 0.581, selfMember 0.741 -> 1.000, super 0.688 -> 0.813,
  //   bareCall 0.874 -> 0.913, chain 0.099 -> 0.223, dynamic 0.218 -> 0.485.
  //   Quick TOTAL 0.523 -> 0.844 (214/409 -> 362/429); localVar 0.200 ->
  //   0.789, selfMember 0.350 -> 1.000, super 0.167 -> 0.333, bareCall 0.842
  //   -> 0.923, chain 0.341 -> 0.882, dynamic 0.185 -> 0.759.
  // Edges: Alamofire +210 gained, 37 retargeted (every one from a parse-error
  // id onto the real member, e.g. `#performEagerlyIfNecessary` ->
  // `Session#performEagerlyIfNecessary`), 0 lost; Quick +148, 9 retargeted, 0
  // lost. The chunk set MOVES: with the production chunker config 271 of 2401
  // Alamofire chunks change across 15 of 101 files and 110 of 672 Quick chunks
  // across 9 of 113, because files that failed to parse now split at real
  // symbol boundaries — hence chunking 4 as well as walker 11, and the drift
  // hint routes `--force` for Swift projects. The same numbers move codegraph
  // from `moderate` to `high`: typed receivers (selfMember 1.000 on both
  // corpora) now resolve as reliably as the structural chain allows, and what
  // stays unresolved is dominated by closure parameters (`$0`) and Foundation
  // or UIKit receivers the project does not declare.
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
  // chunking 4: the grammar bump above — files 0.7.1 could not parse now
  // chunk at real symbol boundaries, so the chunk set moves again.
  // walker 42: bd tea-rags-mcp-jwjyr.1 (merged onto walker 41 from y99pg.28, so
  // neither parent index holds the merged extraction). The walker records the DECLARED
  // visibility on `ChunkExtraction.visibility` — `private` / `fileprivate` vs everything wider — persisted in
  // `cg_symbols.visibility`. Needs `--force-enrichments codegraph` to fill.
  // walker 43: bd tea-rags-mcp-ezm9o — `*Test(s).swift` match case-sensitively,
  // so `Latest.swift` enters the graph; the reasoning is java/capability.ts's.
  // walker 44: a property observer's `oldValue` / `newValue` binds the
  // property's declared type; a closure passed off a construction head
  // (`Result { … }.mapError { $0 … }`) spells its callee through it; a
  // `switch self` payload inside a NESTED enum reads the qualified enum's cases
  // (bd tea-rags-mcp-y99pg.31). Measured: Alamofire TOTAL 0.974 -> 0.976
  // (1241/1274 -> 1243/1273), Quick unchanged 0.997; edges +2 / -0, one SDK
  // site (`DateFormatter.string`) proved external, WRONG unchanged.
  // walker 46: bd tea-rags-mcp-y99pg.29 (built on its own branch as 44 and 45,
  // merged onto 45). A closure passed to a BARE callee binds its parameters by
  // that callee (`withCheckedContinuation { continuation in`), read off the
  // enclosing type's method or the SDK's module-level function; a closure passed
  // to a CONSTRUCTION binds them by the constructed type's initializer — the
  // project's `init` (now published on `memberClosureParameters`) or the
  // SDK's; only a call's LAST closure is bound, and a function-typed parameter
  // taking nothing no longer competes for a closure that names one. Measured
  // on its branch: Alamofire TOTAL 0.974 -> 0.979 (1241/1274 -> 1241/1268),
  // Quick unchanged; edges +0 / -0, 6 SDK continuation sites proved external.
  // walker 47: bd tea-rags-mcp-y99pg.29 (46 on its branch) plus the merge with
  // y99pg.30 / .31 — the resolve-rate denominator stops charging a BARE call
  // inside a type whose hierarchy the SDK declares the member on and the
  // project does not (implicit `self.map` inside a `Publisher`); an index
  // built by any earlier walker holds neither branch's extraction whole.
  // walker 48: bd tea-rags-mcp-y99pg.32 — a `Set<T>` / `Array<T>` spelling
  // carries its element like `[T]` does, so `for x in set` and
  // `set.forEach { $0… }` type their item (a closure parameter declared
  // `(Set<Request>) -> Void` included). Measured: Alamofire TOTAL 0.988 ->
  // 0.989 (1250/1265 -> 1251/1265), Quick 0.997 unchanged, WRONG 8; edges
  // +1 / -0 (Session.swift:274 `$0.cancel` -> Request#cancel, oracle-matched).
  // walker 49: bd tea-rags-mcp-y99pg.32 — a published closure-parameter type
  // keeps its concrete generic arguments (`Result<URLRequest, Error>`), so a
  // closure passed to a protocol method in another file reads `result.get()`
  // as `URLRequest`. Measured: Alamofire TOTAL 0.989 -> 0.990 (1251/1265 ->
  // 1252/1265), Quick 0.997 unchanged, WRONG 8; edges +1 / -0
  // (Session.swift:1276 -> URLRequest#validate, oracle-matched).
  // walker 50: bd tea-rags-mcp-y99pg.32 — each `let` clause of a multi-line
  // `if` / `guard` / `while` condition is positioned on its own line, so a
  // later clause's spelling folds the earlier ones (a spelling is visible
  // strictly below its line). Measured: Alamofire TOTAL 0.990 -> 0.991
  // (1252/1265 -> 1252/1264: Request.swift:1213 `cookies.map` proven
  // `Array<HTTPCookie>` and SDK `map`, oracle `Collection.map`), Quick 0.997
  // unchanged, WRONG 8; edges +0 / -0.
  // walkers 51-54: bd tea-rags-mcp-y99pg.34, built as 48-51 on a parallel
  // branch off walker 47 and renumbered at the merge with y99pg.32; the
  // measurements below are that branch's own, taken without y99pg.32.
  // walker 51 (branch 48): bd tea-rags-mcp-y99pg.34 — `self` inside an extension of an
  // array type (`extension [P]`, `extension Array where Element == P`) iterates
  // as its element, so `for x in self` binds `x`. Alamofire TOTAL 0.988 ->
  // 0.989 (1250/1265 -> 1251/1265), Quick unchanged, WRONG 8 -> 8; edges +1 / -0,
  // the one the typechecker binds (`ServerTrustEvaluating.evaluate`).
  // walker 52 (branch 49): bd tea-rags-mcp-y99pg.34 — `typeDeclarations` publishes which
  // stored properties a generic parameter types and each re-opening's `where`
  // clause, so inside `extension Protected where Value == Request.MutableState`
  // `self` is a `Protected<Request.MutableState>` and `value` a
  // `Request.MutableState`. Alamofire TOTAL 0.989 -> 0.991 (1251/1265 ->
  // 1252/1264), Quick unchanged, WRONG 8 -> 8; edges +1 / -0
  // (`Request.State.canTransitionTo`, as swiftc binds it), and one SDK site
  // (`type.map` on a `[SecCertificate]`) proved external.
  // walker 53 (branch 50): bd tea-rags-mcp-y99pg.34 — a receiver known only by an SDK CLASS
  // bound (`ExtendedType: Bundle`) is read as that class plus its project
  // subclasses, so a member only an unrelated project type declares leaves the
  // denominator. Alamofire TOTAL 0.991 -> 0.991 (1252/1264 -> 1252/1263),
  // Quick unchanged, WRONG 8 -> 8; edges +0 / -0; `type.paths` on a `Bundle`
  // proved external (swiftc: Bundle.paths(forResourcesOfType:inDirectory:)).
  // walker 54 (branch 51): bd tea-rags-mcp-y99pg.34 — the receiver fold's hop cap moves
  // from three links to five, so a five-link chain of SDK links is typed.
  // Alamofire TOTAL 0.991 -> 0.992 (1252/1263 -> 1252/1262), Quick unchanged,
  // WRONG 8 -> 8; edges +0 / -0; HTTPHeaders.swift:383 `….last.map` proved an
  // SDK member (swiftc: Optional.map).
  // walkers 55-58: bd tea-rags-mcp-y99pg.33, built as 48-51 on a parallel
  // branch off walker 47 and renumbered at the merge with y99pg.32 / .34; the
  // measurements below are that branch's own, taken without either.
  // walker 55 (branch 48): bd tea-rags-mcp-y99pg.33 — an extension's `where Self: Q` /
  // `Self == X` constraints reach `typeDeclarations`, and an implicit-self call
  // inside that body resolves to the constraint's member: Alamofire TOTAL
  // 0.988 -> 0.989 (1250/1265 -> 1251/1265), Quick unchanged, WRONG 8 -> 8,
  // edges +1 / -0 (`serializeDownload`'s `serialize`, oracle-confirmed).
  // walker 56 (branch 49): bd tea-rags-mcp-y99pg.33 — `typeDeclarations` carries each
  // stored property's attribute types, and `$name` types as its wrapper's
  // `projectedValue` (`@Published` → `Published<Value>.Publisher`): Alamofire
  // TOTAL 0.989 -> 0.990 (1251/1265 -> 1251/1264), Quick unchanged, WRONG 8,
  // edges +0 / -0 (watchOS `$result.compactMap(\.self).map` proved Combine's).
  // walker 57 (branch 50): bd tea-rags-mcp-y99pg.33 — `T?` is `Optional<T>`: bindings
  // and properties declared optional, the receiver as written
  // (`CallRef.writtenReceiver`) and SDK optionals reach the fold, and a member
  // written straight on an optional is `Optional`'s: Alamofire TOTAL 0.990 ->
  // 0.991 (1251/1264 -> 1251/1262), Quick unchanged, WRONG 8, edges +0 / -0
  // (ResponseSerialization `Optional.map` x2, oracle-confirmed).
  // walker 58 (branch 51): bd tea-rags-mcp-y99pg.33 — `typeDeclarations` carries each
  // type body's nominal member typealiases, which bind `Self.X` in an SDK
  // member's types on a project conformer (`compactMap { stream in` inside a
  // `Publisher` whose `typealias Output = DataStreamRequest.Stream<…>`):
  // Alamofire TOTAL 0.991 -> 0.992 (1251/1262 -> 1251/1261), Quick unchanged,
  // WRONG 8, edges +0 / -0 (Combine `completion.error.map` is `Optional.map`,
  // oracle-confirmed).
  // walker 59: bd tea-rags-mcp-y99pg.36 — an `@autoclosure` parameter takes no
  // trailing closure (a closure literal there is the wrapped value, not the
  // body), so its label stays required and it no longer makes a declaration
  // accept a block. Walkers 59-61 were measured on a branch without 55-58. Measured:
  // Alamofire TOTAL 0.994 -> 0.994 (1254/1261 unchanged), Quick 0.997
  // unchanged, WRONG 8 -> 2; edges +0 / -0 / ~6 — the six `validate { … }`
  // sites in Validation.swift move from `validate(contentType:)` to
  // `DataRequest` / `DataStreamRequest` / `DownloadRequest#validate(_:)`, as
  // swiftc binds them.
  // walker 60: bd tea-rags-mcp-y99pg.36 — `self.init(…)` never lands on the
  // calling initializer (a delegation to itself never terminates): another
  // overload the call fits wins, else the edge is refused, and when the SDK
  // declares the member on the hierarchy the site leaves the denominator.
  // Measured: Alamofire TOTAL 0.994 -> 0.994 (1254/1261 -> 1253/1260), Quick
  // 0.997 unchanged, WRONG 2 -> 1; edges +0 / -1 — the refused
  // OperationQueue+Alamofire.swift:42 `self.init()`, which swiftc binds to
  // Foundation's `OperationQueue.init()`.
  // walker 61: bd tea-rags-mcp-y99pg.36 — a nested type's property types are
  // published under its nesting path (`DownloadResponsePublisher.Inner`) as
  // well as its short name, the short entry keeps only the fields same-named
  // namesakes agree on, and the enclosing type's fields are read by path.
  // Measured: Alamofire TOTAL 0.994 -> 0.994 (1253/1260 unchanged), Quick
  // 0.997 unchanged, WRONG 1 -> 0; edges +0 / -0 / ~1 — Combine.swift:486
  // `request.cancel()` moves from `Request#cancel` (through the first
  // `Inner`'s `DataRequest`) to `DownloadRequest#cancel`, as swiftc binds it.
  versions: { chunking: 4, walker: 61, codegraphSchema: 2 },
  notes:
    "Type bodies (class/struct/enum/extension/actor) are scope containers whose funcs/inits extract as member chunks; extension methods attribute to the extended type. Computed/stored properties, subscripts, deinit and typealiases are not chunked. Codegraph resolves a receiver only where the walker PROVED a type — an annotation, a CapWords initializer, a stored property, self/Self, a guard-let/if-let unwrap of any of those, a same-file declared return type, or the element type of an [T] collection in a for-in — because Swift imports name modules, never symbols, so there is no import table to narrow anything else. Recall is therefore structurally capped below Java's; the remaining gap is cross-file return types and conformance MRO, a typing problem rather than a chain-ordering one. `super.X()` is the one receiver the LANGUAGE types rather than the walker: it dispatches on the first inheritance specifier, which Swift requires to be the superclass, and it is terminal — a miss drops instead of falling through to a namesake. Its own ceiling is ownership rather than inference: a class rooted in UIKit or XCTest has no project superclass to resolve into, which is most of what it cannot answer. A type re-opened by a same-file extension is counted once, so construction into it resolves; the same type re-opened ACROSS files stays ambiguous, because nothing in a symbol definition says which file carries the body.",
};

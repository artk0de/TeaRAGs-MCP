/**
 * Per-language code versions (bd tea-rags-mcp-frwka).
 *
 * Three axes decide whether a language's indexed data is behind the code:
 * the upstream tree-sitter grammar, our own chunking/walker revision, and the
 * codegraph schema that language emits. The first is read from the installed
 * package; the rest are hand-bumped constants on the capability descriptor.
 */

import { describe, expect, it } from "vitest";

import {
  resolveChunkSetBumpScopes,
  resolveLanguageCodeVersions,
} from "../../../../../src/core/domains/language/capability/versions.js";
import { LanguageFactory } from "../../../../../src/core/domains/language/factory.js";
import { SHARED_LANGUAGE } from "../../../../../src/core/domains/language/kernel/capability.js";

const factory = new LanguageFactory();

describe("resolveLanguageCodeVersions", () => {
  it("combines the descriptor's hand-bumped versions with the installed grammar version", () => {
    const versions = resolveLanguageCodeVersions(factory.capabilities(), () => "9.9.9");

    expect(versions.get("typescript")).toEqual({
      grammar: "9.9.9",
      chunking: expect.any(Number),
      walker: expect.any(Number),
      codegraphSchema: expect.any(Number),
    });
  });

  it("asks the reader for the language's declared grammar package", () => {
    const asked: string[] = [];
    resolveLanguageCodeVersions(factory.capabilities(), (pkg) => {
      asked.push(pkg);
      return undefined;
    });

    expect(asked).toContain("tree-sitter-typescript");
    expect(asked).toContain("tree-sitter-ruby");
  });

  it("omits grammar for a language that parses without a tree-sitter grammar", () => {
    const versions = resolveLanguageCodeVersions(factory.capabilities(), () => "9.9.9");

    expect(versions.get("markdown")?.grammar).toBeUndefined();
  });

  it("omits grammar when the package is not installed", () => {
    const versions = resolveLanguageCodeVersions(factory.capabilities(), () => undefined);

    expect(versions.get("ruby")?.grammar).toBeUndefined();
    expect(versions.get("ruby")?.walker).toEqual(expect.any(Number));
  });

  it("declares versions for every supported language", () => {
    const versions = resolveLanguageCodeVersions(factory.capabilities(), () => undefined);

    for (const language of factory.supported()) {
      expect(versions.get(language), `missing code versions for ${language}`).toBeDefined();
    }
  });

  it("reads the real installed grammar version by default", () => {
    const versions = resolveLanguageCodeVersions(factory.capabilities());

    expect(versions.get("ruby")?.grammar).toMatch(/^\d+\.\d+\.\d+/);
  });

  it("declares the shared * pseudo-language without a grammar axis", () => {
    const resolved = resolveLanguageCodeVersions(factory.capabilities(), () => "1.0.0");

    // codegraphSchema 2: bd tea-rags-mcp-9i2ow — cg_symbols line ranges and the
    // one chunk-owner rule for every writer of codegraph chunk signals.
    // walker 3: bd tea-rags-mcp-nbf8q — run-global class-name maps per family.
    // walker 4: bd tea-rags-mcp-qea83 — return-type maps and hierarchy per family.
    // walker 5: bd tea-rags-mcp-r8hme.2 — export names on
    // `cg_symbols_edges_file` (migration 030), carried by the shared import→file
    // engine and unioned by the runner's per-target dedupe.
    // bd tea-rags-mcp-r8hme.8's type-abstractness census pass ships under the
    // same walker 5 (one bump per release) and only re-pins the digest.
    // chunking 2: bd tea-rags-mcp-y5vx4 — oversized symbols split on statement
    // boundaries into `#part1..N` with context prefixes; markdown and the
    // character fallback cut between blocks / syntax-neutral units. Same bump:
    // bd tea-rags-mcp-msv3l — test files chunked by example.
    // chunking 3: bd tea-rags-mcp-nu05a — heading-less markdown documents and
    // oversized preambles split under maxChunkSize (scoped to .md/.markdown).
    expect(resolved.get(SHARED_LANGUAGE)).toEqual({ chunking: 3, walker: 3, codegraphSchema: 2 });
    // `*` parses nothing of its own, so there is no grammar package to read —
    // and borrowing one language's would make the axis a lie for every other.
    expect(resolved.get(SHARED_LANGUAGE)?.grammar).toBeUndefined();
  });

  it("hands out a copy of the shared stamp, so a mutating caller cannot poison the next resolve", () => {
    const stamp = resolveLanguageCodeVersions(factory.capabilities(), () => undefined).get(SHARED_LANGUAGE);
    if (stamp) stamp.walker = 99;

    expect(resolveLanguageCodeVersions(factory.capabilities(), () => undefined).get(SHARED_LANGUAGE)?.walker).toBe(3);
  });
});

describe("seeded support versions", () => {
  const versions = resolveLanguageCodeVersions(factory.capabilities(), () => undefined);

  it("seeds chunking at 1 everywhere, and bumps walker/codegraphSchema only where the code moved", () => {
    // codegraphSchema 2 on every language that EMITS method edges: bd
    // tea-rags-mcp-ex28m widened the edge primary key with source_rel_path, and
    // the rows the old key discarded can only come back by re-extraction.
    // markdown is doc-only — no call graph, so nothing of its was collapsed and
    // its axes stay put. swift LEFT this set when its walker + resolver landed:
    // it now emits method edges, so the widened key applies to it like every
    // other edge-emitting language.
    const NO_CALL_GRAPH = new Set(["markdown"]);

    for (const [language, v] of versions) {
      // `*` is not a language vertical. Its axes stand for sources that run
      // under every language at once, are pinned by their own test above, and
      // none of the per-language expectations below apply to them.
      if (language === SHARED_LANGUAGE) continue;
      // typescript walker 3: the wave-2 resolver additions (2a7e774e4), on top
      // of walker 2's oracle wave. python walker 2: bd tea-rags-mcp-9fgdi gave
      // `ImportRef` importedNames / importedBindings; python walker 3: bd
      // tea-rags-mcp-y4hro added the `classAncestors` channel; python walker 4:
      // E2 seam 5 (bd tea-rags-mcp-9fgdi) added the chunk-level
      // `callResultBindings` and the file-level `classFieldTypesByClassKey`;
      // python walker 5: bd tea-rags-mcp-w205u narrowed short-name resolution
      // to same-language, bare-callable, non-builtin candidates, so an index
      // built by walker 4 holds edges this one never emits; python walker 6: bd
      // tea-rags-mcp-4yvms persists `classFieldTypesByClassKey` +
      // `moduleReexports` in the pass-1 slice, so rows written by walker 5
      // carry neither and an incremental run on them still mis-resolves
      // cross-file fields and package re-exports; python walker 7: bd
      // tea-rags-mcp-11qqk scoped the import mapper's re-export memo to the RUN
      // rather than to the pooled symbol table, so rows written by walker 6 can
      // carry edges resolved through a re-export target that had already moved;
      // python walker 8: bd tea-rags-mcp-z99hp scoped the ancestor linearizer
      // the same way — by the identity of `classAncestors` rather than by the
      // pooled table — so rows written by walker 7 can carry edges resolved on
      // an MRO merged from a previous run's base lists; python walker 9: bd
      // tea-rags-mcp-pbwd added dict-table dispatch — `dispatchTables`,
      // `callbackParams` and tagged `CallRef.dispatch` sites walker 8 never wrote.
      // ruby walker 2: bd
      // tea-rags-mcp-kumq2 routed every Ruby short-name lookup through the same
      // same-language filter, so an index built by walker 1 holds the
      // cross-language picks this one never emits; ruby walker 3: bd
      // tea-rags-mcp-39xca.9 persists `self.table_name` overrides in the pass-1
      // slice, so rows written by walker 2 carry none and an incremental run on
      // them still drops the column accessors of every model they disambiguate.
      // java walker 2: bd
      // tea-rags-mcp-f11nz gave the java walker the kernel's innermost-chunk
      // call attribution, so an index built by walker 1 holds a second copy of
      // every in-method call, emitted from the enclosing class chunk. rust
      // walker 2: the same bd tea-rags-mcp-f11nz change, where the duplicate
      // came from each enclosing impl / mod / trait chunk. typescript walker 5
      // and javascript walker 2: bd tea-rags-mcp-hwwtw stopped deciding member
      // calls by global short-name uniqueness — typescript dispatches a
      // checker-typed interface receiver through the cone, javascript keeps the
      // global fallback for bare calls only. typescript walker 6 and javascript
      // walker 3: bd tea-rags-mcp-x9qsh maps a specifier that already names a
      // TypeScript file to that file, so an index built before it holds file
      // edges to `<file>.ts.js` / `<file>.mts.ts` paths no file row matches.
      // typescript walker 7: bd tea-rags-mcp-05uhs lets every receiver-bearing
      // call the chain declined reach the typeCheckerFallback regardless of
      // namesake count, so an index built before it holds neither the 203
      // file-only checker edges nor the 37 symbol-precise ones the taxdome A/B
      // measured at the old gate.
      // typescript walker 8: bd tea-rags-mcp-nj8i6 owner-rules the same-file
      // fallbacks (typeCheckerReturnType's short-name narrowing, thisMember's
      // same-file fallback) and reads a class-body chunk's callerSymbolId, so
      // an index built before it holds the C12-class misattributed edges the
      // owner rule declines and misses the class-body `this.m()` edges the
      // read recovers.
      // go walker 2: bd tea-rags-mcp-e6xx publishes struct field facts on
      // `classFieldTypesByClassKey` and resolves promoted methods through
      // embedding, so an index built by walker 1 holds none of the
      // `engine.GET` → `RouterGroup#GET` edges this one emits.
      // typescript walker 9: bd tea-rags-mcp-pv7ul adds a POSITIVE structural
      // arm to the evidence guard for receivers that construct or produce
      // their type (`new ImportedClass().m()`, a `createX()` factory call), so
      // an index built by walker 8 misses the checker-off member edges those
      // sites gain when the constructed type's definer walk owns the
      // candidate.
      // typescript walker 10: bd tea-rags-mcp-wr3n4 extends the owner rule's
      // containment arm to the candidate's OWNER, so an index built by walker 9
      // holds file-only edges where the factory/hook idiom's shorthand member
      // (declared in the object literal the enclosing function returns) has a
      // structurally-correct symbol pin the candidate-lines-only containment
      // declined.
      // go walker 3: bd tea-rags-mcp-7h6j0 keys the run-global return-type
      // channel by the declaring package, so an index built by walker 2 holds
      // bare-keyed entries its resolver cannot read — namesake `New()`s
      // resolve to nothing until the recompute rewrites them.
      // go walker 4: bd tea-rags-mcp-fov8f emits every spec of a grouped
      // `type ( ... )` declaration, so an index built by walker 3 holds only
      // the group's FIRST type — every later spec resolves to nothing until
      // the recompute rewrites it.
      // typescript walker 11: bd tea-rags-mcp-4pa9o narrows
      // `importNarrowedFallback` through a barrel — the binding's re-export
      // origin joins the candidate-file set when the receiver head names it —
      // so an index built by walker 10 misses the checker-off constructed
      // receiver edges behind `sync/index.js`-style barrels.
      // swift walker 3: walker 2 shipped the call graph itself (an index built
      // by walker 1 holds no swift edges whatsoever); walker 3 added the
      // scope-qualified type receiver, stopped double-counting a type re-opened
      // by a same-file extension, and fixed the materialization field loss that
      // made every annotated-type read evaluate to nothing in production;
      // walker 4 publishes `classExtends` and resolves `super` over it, so an
      // index built by walker 3 carries no inheritance for swift at all and
      // every `super.X()` in it is unresolved; walker 5 publishes the
      // run-global `classFieldTypesByClassKey` address AND adds
      // `chainedReceiverType` reading it, so an index built by walker 4 carries
      // neither the address nor any edge for a dotted receiver beyond the
      // single-property `self.<x>` form; walker 6 reduces an EXISTENTIAL
      // annotation (`any Proto`, and the parenthesized `(any Proto)?`), which
      // is how Swift 5.7+ spells protocol-typed storage and which walker 5
      // typed to nothing, and widens `storedPropertyType` to the cross-file
      // field union plus the superclass chain — so an index built by walker 5
      // holds no fact about any `any`-annotated parameter, local or property;
      // walker 7 hands a TYPE chunk's own calls (computed properties,
      // subscripts, `deinit`, stored-property initializers) the type as
      // `callerScope` via the kernel's opt-in `bodyScope`, and reads the
      // enclosing type as a qualified scope prefix rather than the last segment,
      // so an index built by walker 6 holds none of the type-body edges;
      // walker 8 resolves a member INHERITED from the superclass for every
      // typed receiver and for `self` / bare calls, so an index built by
      // walker 7 holds no edge into an inherited member; walker 9 publishes
      // declared return types run-global and types a call hop, a cast head and
      // a collection-literal head, so an index built by walker 8 carries no
      // return type and no edge off a call hop; walker 10 qualifies a short
      // type name to the nested type it denotes, so an index built by walker 9
      // holds no edge into a nested type's member reached by its short name.
      // swift walker 11 (with chunking 4): the grammar moves from
      // tree-sitter-swift 0.7.1 to 0.7.3, which parses files 0.7.1 left as
      // ERROR nodes, so an index built by walker 10 holds parse-error ids and
      // none of the edges out of those files.
      // swift walker 12: a property's type is qualified from its declaring type
      // outward, so an index built by walker 11 holds no edge through a field typed
      // by a nested type of the field's owner.
      // swift walker 13: the walker publishes `typeDeclarations` (declaration vs
      // re-opening), so an index built by walker 12 still lands constructions of a
      // Foundation type on the project's extension of it and leaves a type re-opened
      // across files ambiguous.
      // swift walker 14: member lookup reaches protocol members through conformances,
      // so an index built by walker 13 misses `trust.af.*` and every other member a
      // protocol or its extension provides.
      // swift walker 15: closure parameters (`$0`, named) are typed from the
      // function-typed parameter they are passed to, so an index built by walker 14
      // misses every call on a closure parameter.
      // swift walker 16: generic parameters read as their constraints and a
      // metatype-bound generic return as the named type, so an index built by walker
      // 15 misses every call on a generic-typed value.
      // swift walker 17: locals bound to an untypable value chain are published by
      // spelling in `callResultBindings`, so an index built by walker 16 misses every
      // call on such a local.
      // swift walker 18: a type's conventional singleton types as the type, so an
      // index built by walker 17 misses calls through `NotificationCenter.default`.
      // swift walker 19: closure-value invocations are no longer calls, so an index
      // built by walker 18 keeps edges from `stream(...)` / `handler?(...)` to
      // namesake methods.
      // swift walker 20: protocol property requirements publish their types and
      // `[T]` element accessors type as the element, so an index built by walker 19
      // misses calls through them.
      // swift walker 21: underscore-prefixed type names read as types and a type
      // receiver resolves at module scope, so an index built by walker 20 misses
      // calls on explicit type receivers.
      // swift walker 22: specialised constructions are call sites and type their
      // binding, and `catch` binds `error`, so an index built by walker 21 misses
      // both.
      // swift walker 23: definitions carry argument-label signatures and call sites
      // their labels, so an index built by walker 22 targets the first overload.
      // swift walker 25: inout and metatype parameters bind their type, so an index
      // built by walker 24 has no edge for a call on either.
      // swift walker 26: generic closure parameters bind through the callee's
      // declaration, so an index built by walker 25 leaves every such closure
      // parameter untyped.
      // swift walker 27: the codegraph resolve-rate denominator excludes typed
      // receivers whose member no reachable type declares, so a rate a walker-26
      // run persisted is lower than this build reports.
      // swift walker 28: array and dictionary values bind Array / Dictionary, so an
      // index built by walker 27 has no edge into any project Array extension.
      // swift walker 29: extension-initializer constructions and bare names shadowed
      // by an unrelated nested type now resolve, so an index built by walker 28 lacks
      // those edges.
      // swift walker 30: enum case payloads and switch-case payload bindings are new
      // channel content, so an index built by walker 29 types no payload name.
      // swift walker 31: collection constructions and dictionary for-in tuples now
      // bind, so an index built by walker 30 types neither.
      // swift walker 32: `-> Self` returns are published, so an index built by
      // walker 31 types no chain through one.
      // swift walker 33: `spelledAs` is new channel content, so an index built by
      // walker 32 reaches no generic-argument extension.
      // swift walker 34: resolver-side chain-head reads changed which edges exist,
      // so an index built by walker 33 lacks the `try`-headed and nested-type-headed
      // edges.
      // swift walker 35: implicit-initializer `super.init()` edges are new, so an
      // index built by walker 34 lacks them.
      // swift walker 36: `functionAliasReturns` is new channel content, so an index
      // built by walker 35 types no stored-closure call head.
      // swift walker 37: SDK facts come from the generated symbol-graph
      // substrate and member lookup walks SDK superclass chains, so an index
      // built by walker 36 lacks the edges into project extensions of an SDK
      // superclass and persisted a denominator the hand-written lists drew.
      // swift walker 38: SDK member hops, closure parameters and construction
      // heads are typed from the substrate, so an index built by walker 37 lacks
      // those edges and charges their SDK sites as misses.
      // swift walker 39: `fieldConstructions` and `genericInitializers` are new
      // channel content, so an index built by walker 38 types no closure
      // parameter of a construction-initialized generic field.
      // swift walker 40: string and array literals bind their default types,
      // so an index built by walker 39 charges a literal-bound local's SDK
      // calls as misses.
      // swift walker 41: a protocol composition types as its one non-marker
      // protocol, so an index built by walker 40 leaves `S: Subscriber &
      // Sendable` values untyped.
      // ruby walker 4: `module_function` now emits the static symbolId form
      // alongside the instance one, so an index built by walker 3 holds none of
      // the `M.foo` → `M#foo` edges this one emits for module functions.
      // ruby walker 5: a `Const.call` entry lands on a `#call` override below the
      // delegator, and a `super`-delegating override inherits its ancestor
      // template's hook (`superDelegates` in the pass-1 slice), so an index built
      // by walker 4 holds those entries on the shared `KindOfService.call` node.
      // javascript walker 4: bd tea-rags-mcp-hkj8 extracts lookup-table
      // dispatch (`dispatchTables`, `CallRef.dispatch`, `callbackParams`,
      // `dispatchArgs`), so an index built by walker 3 holds none of the
      // caller→candidate edges `H[k]()` / `T[k].f()` sites now fan out to.
      // typescript walker 12: bd tea-rags-mcp-v0207 adds the annotated-factory
      // hop to the owner rule, so an index built by walker 11 holds file-only
      // edges where a member declared on a same-file type the factory's return
      // annotation names now pins the factory's own member.
      // typescript 13, javascript 5, python 10, ruby 6, java 3, rust 3, go 5,
      // swift 11: bd tea-rags-mcp-f4ce0 keys every identifier-keyed extraction
      // record by own key (`createIdentifierRecord` / `identifierEntry`). A
      // local, field or class named `toString` / `constructor` / `__proto__`
      // used to hit `Object.prototype` and throw, so the whole FILE dropped out
      // of the graph (9 of commons-lang's) — an index built by the previous
      // walker holds no row for any such file until the recompute rewrites it.
      // swift walker 24: that fix merged onto swift walker 23, which had moved
      // independently (bd tea-rags-mcp-y99pg), so neither parent's index holds
      // the merged extraction.
      // typescript 14, javascript 6, java 4, rust 4, go 6, swift 42 (37 on its branch, merged onto 41):
      // bd tea-rags-mcp-jwjyr.1 records each language's DECLARED visibility on
      // `ChunkExtraction.visibility` (ruby already did), so an index built by
      // the previous walker holds a NULL `cg_symbols.visibility` for every
      // symbol of these languages until the recompute rewrites it.
      // python walker 11 / 12, ruby walker 7: bd tea-rags-mcp-nbf8q gives the
      // package re-export hop a Python-only lookup, and both facades answer
      // `hasInProjectDefinition` from their own files, so a miss whose only
      // namesake is another language's moves out of the charged bucket.
      // python 13: jwjyr.1 (11) and nbf8q (11, 12) bumped from 10 on separate
      // branches and were merged.
      // java 5, swift 43: bd tea-rags-mcp-ezm9o matches the PascalCase test
      // suffixes case-sensitively, so `Latest.java` / `Latest.swift` enter a
      // graph an index built by the previous walker excluded them from.
      // swift walker 45: bd tea-rags-mcp-y99pg.30 publishes module-level values
      // and types receivers naming them, so an index built by walker 44 holds
      // no edge off `AF.request(…)`.
      // ruby walker 8: bd tea-rags-mcp-nbf8q item 4 caps Ruby's dynamic fan-out
      // at RUBY's own defs-per-member p99, not the polyglot corpus one (taxdome:
      // 19, not 16), so an index built by walker 7 reports as `ambiguous` the
      // 17–19-survivor fans this one materializes as edges.
      // swift walker 44: property-observer parameters, construction-head closure
      // callees and nested-enum `switch self` payloads bind (bd
      // tea-rags-mcp-y99pg.31), so an index built by walker 43 lacks those edges
      // and charges an SDK payload's calls as misses.
      // typescript walker 15: bd tea-rags-mcp-g7h1y keeps the member edge of a
      // `.call` / `.apply` / `.bind` whose receiver's declared type declares
      // that member (`this.connection.call(fn)` → `QdrantConnection#call`).
      // swift walker 46: bd tea-rags-mcp-y99pg.29 — a closure passed to a bare
      // callee or a construction binds its parameters by that callee's (or the
      // initializer's) closure parameter, so an index built by walker 45 charges
      // `withCheckedContinuation { continuation in … }` SDK calls as misses.
      // swift walker 47: y99pg.29 merged with y99pg.30 / .31 — a bare call an
      // enclosing type's SDK supertype declares leaves the denominator, and no
      // earlier walker's index holds both branches' extraction whole.
      // swift walker 51: bd tea-rags-mcp-y99pg.34 — `self` in an array-type
      // extension iterates as its element, so an index built by walker 47 holds
      // no binding for `for x in self` there.
      // swift walker 52: bd tea-rags-mcp-y99pg.34 — `genericFieldParameters` and
      // `whereClause` are new channel content, so an index built by walker 48
      // cannot type a generic-typed property inside a constrained extension.
      // swift walker 53: bd tea-rags-mcp-y99pg.34 — a receiver known by an SDK
      // class bound leaves the denominator for a member no subclass declares, so
      // an index built by walker 49 still charges those sites as misses.
      // swift walker 54: bd tea-rags-mcp-y99pg.34 — the chain fold's hop cap
      // moves from three links to five, so an index built by walker 50 leaves a
      // four- or five-link receiver untyped.
      // swift walker 61: bd tea-rags-mcp-y99pg.36 — an `@autoclosure` parameter
      // no longer accepts a trailing closure, so an index built by walker 60
      // lands `validate { … }` on `validate(contentType:)`.
      // swift walker 62: bd tea-rags-mcp-y99pg.36 — `self.init(…)` never lands
      // on the calling initializer, so an index built by walker 61 keeps an
      // edge from `OperationQueue#init` to itself.
      // swift walker 63: bd tea-rags-mcp-y99pg.36 — nested types' fields are
      // published under their nesting path, so an index built by walker 62 lets
      // the first same-named nested type type every namesake's properties.
      // typescript walker 16, javascript walker 7, python walker 14: bd
      // tea-rags-mcp-r8hme.2 records the export names every import takes (and,
      // for typescript, every re-export forwards) on the persisted file edge, so
      // an index built by the previous walker carries no names and the facade
      // check falls back to its file-level rule there.
      // swift walker 55 (branch 48): bd tea-rags-mcp-y99pg.33 — `typeDeclarations` carries
      // an extension's `where Self` constraints, so a walker-54 index cannot
      // resolve an implicit-self call to the constraint's member.
      // swift walker 56 (branch 49): bd tea-rags-mcp-y99pg.33 — property attribute types
      // reach `typeDeclarations`, so a walker-55 index cannot type `$name`.
      // swift walker 57 (branch 50): bd tea-rags-mcp-y99pg.33 — optional bindings,
      // optional properties and the written receiver are new extraction, so a
      // walker-56 index reads every optional as what it wraps.
      // swift walker 58 (branch 51): bd tea-rags-mcp-y99pg.33 — member typealiases reach
      // `typeDeclarations`, so a walker-57 index cannot bind `Self.X` on a
      // project conformer.
      // swift walker 60: bd tea-rags-mcp-y99pg.35 — `declarationKind` is new
      // `typeDeclarations` content, and an Objective-C dynamic-lookup call no
      // project class can implement leaves the denominator, so an index built
      // by an earlier walker still charges it as a miss.
      // swift walker 64: bd tea-rags-mcp-y99pg.37 — a call's lone key-path
      // argument stays in the value spelling, a `for` item over an untyped local
      // is recorded as its sequence's element, and `typeDeclarations` names the
      // methods returning their closure's result, so a walker-63 index cannot
      // type `for request in mutableState.read(\.activeRequests)`.
      // bd tea-rags-mcp-r8hme.8's per-file type-abstractness census ships under
      // each language's existing release bump below (re-pinned, not bumped).
      // Numbered on the naming-lexicon branch (bd tea-rags-mcp-4p3sb), before
      // its merge with the waves above:
      // ruby 8, python 14: bd tea-rags-mcp-4p3sb.3 publishes
      // `identifierDeclarations`, so an index built by the previous walker
      // holds no declaration for the naming lexicon.
      // typescript 15, javascript 7: bd tea-rags-mcp-4p3sb.4, the same channel.
      // go 7, rust 5: bd tea-rags-mcp-4p3sb.5, the same channel.
      // java 6, swift 44, bash 2: bd tea-rags-mcp-4p3sb.6, the same channel.
      // ruby 9, python 15, typescript 16, javascript 8, go 8, rust 6, java 7,
      // swift 45, bash 3: bd tea-rags-mcp-4p3sb.16 binds each call-valued local
      // and field to its callee (`boundCallee`), and Python / TypeScript name a
      // collection annotation's element, so an index built by the previous
      // walker holds neither.
      // ruby 10, typescript 17, swift 48: the naming-lexicon branch (ruby 9,
      // typescript 16, swift 45 on its branch) merged with nbf8q (ruby 8),
      // g7h1y (typescript 15) and y99pg.29-.31 (swift 47), so neither parent's
      // index holds the merged extraction.
      // rust 7, java 8, swift 49: bd tea-rags-mcp-4p3sb.17 names the element of a
      // collection / wrapper annotation on `identifierDeclarations`, so an index
      // built by the previous walker types those rows by the container.
      // swift 55: the naming-lexicon branch (swift 49 on its branch) merged with
      // y99pg.32 / .34 (swift 54), so neither parent's index holds the merged
      // extraction.
      // typescript 18, python 16, java 9, rust 8, go 9, swift 56: bd
      // tea-rags-mcp-4p3sb.21 publishes each function's return annotation as a
      // `return` declaration, so an index built by the previous walker holds no
      // return row for the call-return join to read.
      // typescript 19, javascript 9, python 17, swift 65: the naming-lexicon
      // branch (typescript 18, javascript 8, python 16, swift 56 there) rebased
      // onto integration walkers 16 / 7 / 14 / 64 (r8hme.2, y99pg.35-.37), so
      // neither side's index holds both extractions.
      // swift 66: the naming-lexicon branch (swift 65 there) rebased onto main's
      // swift walker 64, which changed its extraction under the same number (bd
      // tea-rags-mcp-y99pg.39), so again neither side's index holds both.
      // swift 7: release v1.44.2 shipped swift walker 6 and a release cycle gets
      // ONE walker bump, so the branch-local 7..66 collapse into 7.
      // Every other language is still at its seed.
      // Every walker collapses to (release v1.44.2) + 1: one bump per release cycle.
      // ruby 6: bd tea-rags-mcp-0qaht — class variables, `||=` memoization and
      // accessor macros declare naming-lexicon rows, so an index built by walker
      // 5 (shipped in v1.45.1) holds none of them.
      const WALKER_BUMPED = new Map([
        ["typescript", 12],
        ["javascript", 4],
        ["python", 9],
        ["ruby", 6],
        ["java", 3],
        ["rust", 3],
        ["go", 5],
        ["swift", 7],
        ["bash", 2],
      ]);
      const expectedWalker = WALKER_BUMPED.get(language) ?? 1;
      // javascript chunking 2: bd tea-rags-mcp-1etj8 composed the test-scope
      // chunker into the JS hook chain and listed `call_expression` among the
      // chunkable/child chunk types, so `.js` / `.jsx` test files now emit
      // `chunkType: "test"` / `"test_setup"` chunks an index built by
      // chunking 1 never held — the advertised tests-high tier is implemented.
      // swift chunking 2: the same step for Swift — the hook chain recognizes
      // XCTest and swift-testing members, so `.swift` test files now emit
      // `test` / `test_setup` chunks, and `detectScope` switches the project
      // from path-based to chunkType-based test accounting once they appear.
      // swift chunking 3 added the Quick scope chunker; chunking 4 is the
      // grammar bump to 0.7.3 — files 0.7.1 failed to parse now split at real
      // symbol boundaries, so the chunk set moves.
      // bash chunking 2: bd tea-rags-mcp-lyo4p — a top-level `command` chunk no
      // longer takes its callee's name as its symbolId, so an index built by
      // chunking 1 holds statement blocks claiming the id of the function they
      // call.
      // ruby chunking 2: bd tea-rags-mcp-j4jrn — the class-body grouper budgets
      // the reserved header prefix, so groups the header pushed over the cap are
      // no longer line-cut into `#partN` windows.
      // typescript chunking 2 / javascript chunking 3: bd tea-rags-mcp-39xca.19
      // — a method of the literal a named function returns is written as
      // `factory#member`, and a declarator-bound factory's members gain its
      // segment, so the payload `symbolId` of those chunks moves.
      const CHUNKING_BUMPED = new Map([
        ["typescript", 2],
        ["javascript", 3],
        ["swift", 4],
        ["bash", 2],
        ["ruby", 2],
      ]);
      const expectedCodegraph = NO_CALL_GRAPH.has(language) ? 1 : 2;
      expect(v.walker, `walker version for ${language}`).toBe(expectedWalker);
      expect(v.chunking, `chunking version for ${language}`).toBe(CHUNKING_BUMPED.get(language) ?? 1);
      expect(v.codegraphSchema, `codegraph schema version for ${language}`).toBe(expectedCodegraph);
    }
  });
});

describe("resolveChunkSetBumpScopes (bd tea-rags-mcp-j4oww)", () => {
  it("carries each capability's declared chunk-set bump scopes, keyed by language", () => {
    const capabilities = new Map(factory.capabilities());
    const ruby = capabilities.get("ruby")!;
    capabilities.set("ruby", { ...ruby, chunkSetBumpScopes: { chunking: { 9: { testFile: "only" } } } });

    const scopes = resolveChunkSetBumpScopes(capabilities, { chunking: { 7: { testFile: "only" } } });

    expect(scopes.get("ruby")).toEqual({ chunking: { 9: { testFile: "only" } } });
    expect(scopes.get(SHARED_LANGUAGE)).toEqual({ chunking: { 7: { testFile: "only" } } });
  });

  it("omits languages that declare nothing — an undeclared bump is unscoped", () => {
    const scopes = resolveChunkSetBumpScopes(new Map(factory.capabilities()), {});

    expect(scopes.has("typescript")).toBe(false);
    expect(scopes.has(SHARED_LANGUAGE)).toBe(false);
  });
});

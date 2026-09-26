/**
 * Codegraph extraction contracts — everything a language walker emits for one
 * source file, and the sink that receives it. `FileExtraction` is the whole
 * per-file payload (imports, chunks, and the optional per-language type /
 * inheritance / dispatch side-maps); `ChunkExtraction` and `CallRef` are its
 * per-symbol and per-call-site grain.
 *
 * Every optional map here is a plain `Record` / array rather than a `Map` or
 * `Set` — the payload round-trips through the codegraph NDJSON spill, where a
 * `Map` serialises to `{}` and loses every entry. Re-exported verbatim by the
 * `codegraph.ts` barrel.
 */

import type { DispatchRef, DispatchTable } from "./codegraph-dispatch.js";
import type { InheritanceEdgeDecl } from "./codegraph-hierarchy.js";
import type { CallResultBinding, LocalBinding } from "./codegraph-local-binding.js";
import type { AritySignature, KwargSignature, RelPath, SymbolId } from "./codegraph-symbols.js";
import type { RubyTypeRef } from "./language.js";

/**
 * Per-file extraction emitted by the TypeScript walker (and, in slice 3,
 * by other-language walkers) for graph construction. The walker calls
 * `ExtractionSink.write(extraction)` once per file after chunking
 * completes for that file.
 */
export interface FileExtraction {
  relPath: RelPath;
  language: string;
  imports: ImportRef[];
  /**
   * Imports that bring in types only and load nothing at runtime
   * (bd tea-rags-mcp-r8hme.12) — TypeScript's statement-level `import type` /
   * `export type … from`. Kept OUT of {@link FileExtraction.imports}: nothing
   * that reads the runtime import list (receiver binding, dispatch gates, the
   * file graph's fanIn / fanOut) may see them. Resolved through the same
   * import→file path into `GraphEdges.typeOnlyFileEdges`, which only the
   * structure-vs-history judgement reads. Absent when the file has none.
   */
  typeOnlyImports?: ImportRef[];
  chunks: ChunkExtraction[];
  /** Lexical scope chain at file top level — usually `[]` for TS, may be
   *  e.g. `["module Acme"]` for Ruby (slice 3). */
  fileScope: string[];
  /**
   * Optional per-class field-type map: `className → fieldName → typeName`.
   * Populated by walkers for languages with static field-type annotations
   * (TS, Java) so resolvers can resolve `this.field.method()` cross-class
   * calls to `<typeName>#<method>` / `<typeName>.<method>`. Languages
   * without type annotations (Ruby, Python untyped) leave this undefined
   * or empty — resolver falls through to short-name lookup.
   */
  classFieldTypes?: Record<string, Record<string, string>>;
  /**
   * The same `fieldName → typeName` facts as {@link FileExtraction.classFieldTypes},
   * addressed by the RUN-GLOBAL class key `<relPath>::<dotted class FQ>` rather
   * than by the class's short name (bd tea-rags-mcp-f0xaa).
   *
   * Two properties `classFieldTypes` cannot have. A short name is ambiguous
   * run-global — two `Base` classes in two files conflate — so that channel can
   * only ever be read per-file, and a base class declared elsewhere is therefore
   * invisible to a subclass. This key is the one `classAncestors` uses, so a
   * linearized ancestor key looks the fields up directly: polar's
   * `SyncServiceBase.__init__` assigns `self.client` once and 60-odd subclasses
   * in other files call it.
   *
   * Populated by the Python walker and its annotation facet pass. Languages that
   * have not pulled on the cross-file read leave it undefined and keep reading
   * the short-name channel. Plain Record for NDJSON round-trip.
   */
  classFieldTypesByClassKey?: Record<string, Record<string, string>>;
  /**
   * A field assigned from a CALL, as `<relPath>::<dotted class FQ> → field →
   * callee SPELLING` (bd tea-rags-mcp-w205u, E4.6c).
   *
   * The sibling of {@link FileExtraction.classFieldTypesByClassKey} for the
   * shape a walker cannot type at all. `self.payment_repo =
   * PaymentRepository.from_session(session)` names no class: what the field
   * holds is whatever that callee RETURNS, and only the resolver — which has
   * every file's `structuredReturnTypes` — can say. So the walker records the
   * spelling verbatim (`PaymentRepository.from_session`, `get_geo_provider`,
   * `self._init_transport`, arguments stripped) and the resolver folds it ONE
   * level. `callResultBindings` already does exactly this for a
   * single-IDENTIFIER target; a `self.<field>` target had no channel.
   *
   * Class-key addressed and NOT also short-name addressed: the own-class read
   * goes through the same key (the caller's own class is declared in the
   * caller's file), and the MRO walk needs the qualified form anyway.
   *
   * A field this file also TYPES is absent here — the type is the better answer
   * — and a field two methods assign from DIFFERENT callees is dropped rather
   * than resolved last-write-wins, because a conflict is not a fact.
   *
   * Plain Record for NDJSON round-trip; absent when the file has none.
   */
  classFieldCallResults?: Record<string, Record<string, string>>;
  /**
   * Optional per-class Rails association map: `className → accessorName →
   * modelType`. Populated by the Ruby walker from class-body association macros
   * (`belongs_to`/`has_one`/`has_many`/`has_and_belongs_to_many`); the accessor
   * name is the macro's first symbol verbatim (`:user` → `user`,
   * `:agents` → `agents`) and the model type is the associated constant —
   * honouring an explicit `class_name:` override (`belongs_to :author,
   * class_name: "User"` → `User`, NOT `Author`). Drives compound-receiver
   * chain typing: `event.user.agents` binds each prefix left-to-right
   * (`event.user` → User, `event.user.agents` → Agent) so the existing
   * local-type strategy resolves the deepest call exactly. Languages without
   * Rails-style associations leave this undefined.
   *
   * Plain Record (NOT Map) so the value round-trips through the NDJSON spill.
   */
  associationTypes?: Record<string, Record<string, string>>;
  /**
   * Optional per-class superclass + mixin map: `className → ancestor[]`.
   * Walkers populate this when the source declares an explicit inheritance
   * chain (`class Foo < Bar` in Ruby) or module mixin (`include Mod`).
   * The first entry is the direct superclass; subsequent entries are
   * mixins in declaration order. Resolvers walk this list when a
   * receiver-typed method lookup misses on the bound class, so inherited
   * AR methods like `User.find(id).save` find their target via
   * `User → ApplicationRecord → ActiveRecord::Base`. Languages without
   * explicit inheritance markers leave this undefined.
   *
   * Plain Record (NOT Map) so the value round-trips through the NDJSON
   * spill: `Map` serialises to `{}` and loses every entry.
   */
  classAncestors?: Record<string, readonly string[]>;
  /**
   * FQs declared in COMPACT form (`class A::B::C`), whose intermediate
   * namespaces are NOT open lexical scopes. Consumed by the Ruby ancestor-FQ
   * canonicalization so a compact class's raw ancestor is not prefix-walked
   * through a namespace it never opened (bd lawlq.3.7). Array (not Set) for
   * NDJSON-spill round-trip.
   */
  compactDeclaredClasses?: readonly string[];
  /**
   * Explicit ORM table overrides declared in a class body, keyed by class FQ
   * (`Firm` → `companies` for `self.table_name = "companies"`). Consumed by the
   * project-scope schema-column pre-pass at the pass-1→pass-2 barrier: an
   * explicit declaration always beats the table→model inflection guess, and a
   * table a declaration claims can never be inflected onto a namesake model
   * (bd tea-rags-mcp-8l5fo). Populated by the Ruby walker; languages with no
   * such convention leave it undefined.
   *
   * Plain Record (NOT Map) so the value round-trips through the NDJSON spill.
   */
  classSchemaTables?: Record<string, string>;
  /**
   * Optional per-class superclass map for languages with single inheritance
   * via an `extends` clause (TypeScript / JavaScript / Java). Keyed by the
   * fully-qualified class name (`Outer.Inner` for nested classes); value is
   * the parent class as written at the call site, qualifying segments kept
   * intact (`A.B.C` stays `A.B.C`). Resolvers walk this to route `super()`
   * / `super.foo()` calls to the parent class's method — without it, the
   * super branch self-loops to the enclosing class's own method.
   *
   * Differs from `classAncestors` in two ways:
   *   1. Single value per class (TS/JS/Java have one extends parent), not
   *      a list of mixin ancestors.
   *   2. `implements` clauses and TS interface heritage do NOT populate
   *      this map — those are type-only and carry no runtime dispatch.
   *
   * "Extends" here is always the SUPERCLASS. Ruby's `extend Mod` is a
   * class-method mixin that happens to share the word: it belongs in
   * `classAncestors` / an `inheritanceEdges` entry with `kind: "extend"`, and a
   * walker that files it here fabricates a superclass every `super` resolution
   * then trusts.
   *
   * Plain Record (NOT Map) so the value round-trips through the NDJSON
   * spill in the codegraph provider — Map serialises to `{}` and loses
   * every entry.
   */
  classExtends?: Record<string, string>;
  /**
   * Optional per-class `prepend Module` list: `className → prepended[]`.
   * Ruby's `prepend M` inserts M BEFORE the class itself in the method
   * resolution order — `M#foo` wins over the class's own `def foo`. The
   * walker collects every `prepend ModuleName` call at class body level
   * here so the resolver walks prepended modules BEFORE the class's own
   * method table. Later `prepend` calls take priority in MRO, so the
   * walker emits them in source-declaration order and the resolver
   * iterates the array in REVERSE when checking inheritance.
   *
   * Same plain-Record discipline as `classAncestors` for NDJSON round-trip.
   */
  classPrependedAncestors?: Record<string, readonly string[]>;
  /**
   * Optional `functionName → declaredReturnTypeName` map for languages with
   * static return-type declarations (Go). Lets a resolver bind a variable
   * assigned from a function call (`x := New()`) to that function's DECLARED
   * return type so `x.method()` resolves to `<ReturnType>#method` — even when
   * the function is declared in a different file (the map is merged run-global
   * by the codegraph provider in pass-1, mirroring `classExtends`).
   *
   * Recorded by the walker ONLY for single-return signatures whose return is
   * a concrete named type (bare `type_identifier`, `*Type` pointer unwrapped,
   * or the bare last segment of `pkg.Type`). Multi-return signatures
   * (`func New() (*Engine, error)`) and untyped returns are OMITTED — guessing
   * which return feeds the variable reintroduces the m46z false positives.
   * The resolver applies the final safety gate (return type must exist as a
   * struct/type symbol in the table). bd tea-rags-mcp-6g9c.
   *
   * Plain Record (NOT Map) so the value round-trips through the NDJSON spill.
   * Languages without static return types leave this undefined.
   */
  functionReturnTypes?: Record<string, string>;
  /**
   * Optional `tableName → DispatchTable` map for const lookup-table
   * dispatch (bd tea-rags-mcp-n0zj). Populated by walkers that recognise
   * module-level `const NAME = { … }` whose values are object literals
   * (S1) or plain identifiers (S2). The provider merges these run-global
   * (keyed by name + defining relpath) so the resolver can fan a
   * `TABLE[key].field(...)` call out to every candidate function. Plain
   * Record (NOT Map) for NDJSON-spill round-trip. Languages whose walkers
   * don't emit dispatch tables leave this undefined.
   */
  dispatchTables?: Record<string, DispatchTable>;
  /**
   * Optional `fnSymbolId → invokedParamIndices` map for the bounded
   * single-hop inter-procedural join (bd tea-rags-mcp-n0zj). For each
   * in-file function / method, lists the parameter positions invoked as
   * `param(...)` inside its body ("callback params"). The resolver joins
   * this with a call site's `CallRef.dispatchArgs`: when a dispatch
   * candidate-set is passed at a callback-param position, the CALLEE fans
   * out to the candidates. Enables `collectSymbols(tree, langConfig.nameOf)`
   * → `collectSymbols → {tsNameOf, rbNameOf, …}` edges. Plain Record for
   * NDJSON-spill round-trip; undefined when no params are invoked.
   */
  callbackParams?: Record<string, number[]>;
  /**
   * Optional unified inheritance edge list (bd tea-rags-mcp-f10y). New capture
   * surface superseding the per-kind classAncestors/classExtends/
   * classPrependedAncestors Records (which stay for the phased resolver-forward
   * path). TS walkers emit `implements` / interface-extends here — those have no
   * legacy Record. The normalizer reads BOTH this field and the legacy Records.
   * Plain array for NDJSON-spill round-trip.
   */
  inheritanceEdges?: InheritanceEdgeDecl[];
  /**
   * Optional per-class instance-variable type map: `fqClassName → ivarName →
   * typeName`, built from DECLARED ivar types — `RubyTypeFact` entries of
   * `kind:"ivar"` (YARD / Sorbet / RBS). The ivar name is recorded with the
   * leading `@` (`"@account"`, `"@user"`). Lets the resolver bind
   * `@ivar.method()` calls to `<typeName>#method`. Mirror of
   * `CallContext.ivarTypes`; persisted via the NDJSON spill.
   *
   * **Empty today (bd tea-rags-mcp-wr7ku).** No inline type source emits
   * `kind:"ivar"` yet — YARD carries ivar types on `attr_*` readers, not on the
   * ivar itself — so this stays undefined until a sidecar source (Sorbet
   * `T.let` / RBS `@x: Foo`) lands. Ruby's live ivar channel is
   * {@link FileExtraction.classFieldTypes}, filled by AST inference over
   * `@x = Const.new`. The two are NOT mirrors of each other: one carries
   * declarations, the other inference, and `ivarTypes` outranks
   * `classFieldTypes` at every reader precisely because of that.
   *
   * Plain Record (NOT Map) for NDJSON-spill round-trip. Undefined for languages
   * without ivar annotations.
   */
  ivarTypes?: Record<string, Record<string, string>>;
  /**
   * Optional `"<fqClass>#<method>" → RubyTypeRef` map of structured method return
   * types. Populated by the Ruby type-source propagation engine (Increment 1,
   * Task 1.1) from YARD / Sorbet / RBS annotations and AST inference. The key
   * format is `"ClassName#method"` for instance methods and `"ClassName.method"`
   * for class methods (the codegraph fqMethodKey convention). Lets the resolver
   * thread `recv.method().member` chains to the precise structured return ref
   * (union / container preserved) for annotated Ruby code. Mirror of
   * `CallContext.structuredReturnTypes`; persisted via the NDJSON spill.
   *
   * Plain Record (NOT Map) for NDJSON-spill round-trip. Undefined for languages
   * without structured return annotations.
   */
  structuredReturnTypes?: Record<string, RubyTypeRef>;
  /**
   * Optional program-wide instantiation set for RTA cone pruning (bd
   * tea-rags-mcp-pffv): the fully-qualified constants this file instantiates
   * via `Klass.new` or a factory/finder in `RUBY_INSTANCE_RETURNING`
   * (`User.find`, `Account.create!`, `Const.where(...).first`). The provider
   * merges these run-global (pass-1 barrier, mirroring `functionReturnTypes`)
   * so `ConeDispatchResolver` can prune a CHA cone to the subtypes that are the
   * nearest definer of `m` for some INSTANTIATED type — cutting false fan-out.
   *
   * Plain array (NOT Set) so the value round-trips through the NDJSON spill.
   * Undefined for languages whose walkers don't collect instantiation sites.
   */
  instantiatedTypes?: string[];
  /**
   * Argument types observed at call sites whose CALLEE IS SYNTACTICALLY KNOWN
   * — no resolution required (bd tea-rags-mcp-bvalc). Populated by the Ruby
   * walker for `Const.new(...)` and constant-receiver factory verbs; the
   * pass-1→pass-2 barrier folds them per callee coordinate into parameter
   * types (see `foldKnownTargetParamTypes`).
   *
   * These sites are the increment that dodges the interprocedural fixpoint:
   * the target of `Firm::Service.new(x)` is `Firm::Service#initialize`
   * regardless of what any other call site resolves to, so the fold can run at
   * the barrier — before ANY call is resolved.
   *
   * Plain array (NOT Map) for NDJSON-spill round-trip. Undefined for languages
   * whose walkers don't collect call-site argument types.
   */
  knownTargetCallArgs?: KnownTargetCallArgs[];
  /**
   * Per-class map of `@ivar` fields assigned VERBATIM from a method parameter:
   * `fqClassName → "@ivar" → { method, param }` (bd tea-rags-mcp-bvalc). The
   * unresolved half of an ivar's type — the walker knows WHICH parameter the
   * field copies but not that parameter's type, which only the barrier's
   * interprocedural fold can supply.
   *
   * Populated by the Ruby walker for INSTANCE methods only (a `@x` inside
   * `def self.m` is a class-level ivar — a different storage slot). An `@ivar`
   * fed by two different (method, param) coordinates in one class is DROPPED,
   * not last-write-wins: two origins mean two candidate types and Increment 1
   * never picks between them.
   *
   * Plain Record (NOT Map) for NDJSON-spill round-trip.
   */
  classFieldParamLinks?: Record<string, Record<string, ClassFieldParamLink>>;
  /**
   * Every name this file's `from <module> import <name>` statements bind, and
   * where each came from (bd tea-rags-mcp-xpl83.3).
   *
   * The channel exists for one question the import mapper cannot otherwise
   * answer: WHICH FILE DECLARES a name an importer asked for. netbox's
   * `core/models/__init__.py` declares nothing and star-imports six siblings, so
   * mapping `core.models` to it is right and useless — the `ObjectType` behind
   * `from core.models import ObjectType` lives one hop further on, and netbox
   * declares a namesake elsewhere that makes guessing illegal.
   *
   * Recorded for EVERY module: a plain module re-exporting is legal Python too,
   * and the consumer only follows the channel when the file it mapped to
   * declares nothing under the name. A plain `import a.b` binds a MODULE PATH
   * rather than an exported name and is deliberately absent.
   *
   * Plain array (NOT Map) for NDJSON-spill round-trip. Undefined for a file with
   * no `from` import, and for languages whose walkers do not collect them.
   */
  moduleReexports?: readonly ModuleReexport[];
  /**
   * The file's build constraint as written (bd tea-rags-mcp-e6xx) — Go: the
   * expression of the `//go:build` line above the package clause
   * (`!nomsgpack`, `linux && amd64`). The resolver evaluates it to tell
   * build-tag twins apart: two same-package declarations of one name, each
   * compiled under a different tag set, of which the default build compiles one.
   *
   * Undefined for a file without one and for languages without file-level
   * build constraints.
   */
  buildConstraint?: string;
  /**
   * Every TYPE declaration the file carries, the primary declaration and the
   * re-openings alike, in source order (bd tea-rags-mcp-y99pg.1).
   *
   * A symbol id cannot say which file holds a type's own declaration: Swift's
   * `extension Request` composes exactly the id `class Request` does, so a type
   * re-opened across files reads as ambiguous, and a type the project only
   * EXTENDS (`extension JSONDecoder`) reads as one it declares. This is the fact
   * both questions need. Undefined for a file declaring no type, and for
   * languages whose walkers do not collect it.
   */
  typeDeclarations?: readonly TypeDeclarationFact[];
  /**
   * How many of the file's types declare behaviour without implementing it and
   * how many implement it (bd tea-rags-mcp-r8hme.8) — the input of Martin's
   * abstractness A that the architecture report's main-sequence detector sums
   * per component. Which declaration is which is each language's census pass
   * (`kernel/type-abstractness-pass.ts`). Present with both counts 0 when the
   * census ran and found no type; absent for a language with no census pass.
   */
  typeAbstractness?: TypeAbstractnessCensus;
  /**
   * Every named value a symbol declares — parameters, locals, fields — with the
   * type the SYNTAX states, when it states one (bd tea-rags-mcp-4p3sb.1).
   *
   * Syntactic facts only: the kernel identifier-declaration pass never sees the
   * native walker's type channels, so a declaration typed only by a binding, a
   * field type or a return type is joined at sink time, not here. File-scope
   * declarations (no owning chunk) are out of scope.
   *
   * Plain array (NOT Map) for NDJSON-spill round-trip. Undefined for a file
   * declaring nothing, and for languages whose passes do not collect it.
   */
  identifierDeclarations?: readonly IdentifierDeclaration[];
}

/** A file's type-abstractness census ({@link FileExtraction.typeAbstractness}). */
export interface TypeAbstractnessCensus {
  /** Types that declare behaviour and leave its implementation to others. */
  abstractTypeCount: number;
  /** Types that implement behaviour. */
  concreteTypeCount: number;
}

/**
 * What a declared identifier is to its owning symbol. `return` is the symbol's
 * own declared return type: the pass emits it from a syntactic return
 * annotation, the sink-time row builder from the language's return-type
 * channels.
 */
export type IdentifierDeclarationKind = "param" | "local" | "field" | "return";

/**
 * Where a declared identifier's type came from. The pass emits `annotation` and
 * `constructor`; the sink-time row builder joins `binding`, `field-type` and
 * `return-type` from the language's type channels (a `return` row always
 * persists as `return-type`, whichever producer typed it) and derives `finder` from the
 * bound callee and the language's finder vocabulary. `call-return` is never
 * persisted: the `cg_identifiers` reads compute it by joining the bound call to
 * its single exact target's `return` row.
 */
export type IdentifierTypeSource =
  | "annotation"
  | "constructor"
  | "binding"
  | "field-type"
  | "return-type"
  | "finder"
  | "call-return";

/** The type sources a `cg_identifiers` row may carry on disk — every one but the query-time join. */
export type PersistedIdentifierTypeSource = Exclude<IdentifierTypeSource, "call-return">;

/**
 * How many values of its type a declared identifier holds (bd
 * tea-rags-mcp-4p3sb.26). A collection annotation is read as its ELEMENT
 * (`candidates: Doc[]` → `Doc`) so the lexicon groups `candidates` with `Doc`;
 * `many` is what keeps it apart from a `fallback: Doc`, which holds one. Absent
 * means `one`.
 */
export type IdentifierTypeMultiplicity = "one" | "many";

/** One identifier declaration (`FileExtraction.identifierDeclarations`). */
export interface IdentifierDeclaration {
  /** A `return` declaration's name is the function's own short name. */
  readonly name: string;
  /**
   * `return` (bd tea-rags-mcp-4p3sb.21): the function's written return
   * annotation. Always typed — an unannotated function declares no return — and
   * owned by the chunk that IS the function, never by an enclosing one.
   */
  readonly kind: IdentifierDeclarationKind;
  /** 1-based line of the declared name. */
  readonly line: number;
  /** The innermost chunk containing the declaration; for a `return`, the function's own chunk. */
  readonly ownerSymbolId: string;
  readonly typeName?: string;
  readonly typeSource?: Extract<IdentifierTypeSource, "annotation" | "constructor">;
  /**
   * `many` when `typeName` was read through a collection — the annotation or
   * constructor named its element (`Doc[]`, `list[Doc]`, `[]Doc{}`), or the
   * declaration itself collects its values (`...rest`, `*args`, `opts ...T`).
   * Set only with `typeName`; absent means `one`.
   */
  readonly typeMultiplicity?: IdentifierTypeMultiplicity;
  /**
   * The OUTERMOST call a `local` / `field` is bound to, split the way the
   * language's walker splits that call's `CallRef` — so the sink-time row builder
   * finds the `CallRef` (and its `callText`) by `(startLine, member, receiver)`.
   * `x = find_x!(id)` → `{ member: "find_x!" }`, `row = Doc.find(id)` →
   * `{ member: "find", receiver: "Doc" }`. Absent on params, on values that are
   * not a call, and on calls the walker emits no `CallRef` for.
   */
  readonly boundCallee?: IdentifierBoundCallee;
}

/** The callee a declared identifier is bound to — a `CallRef`'s `member` / `receiver` pair. */
export interface IdentifierBoundCallee {
  readonly member: string;
  /** Absent for a receiverless call (`CallRef.receiver === null`). */
  readonly receiver?: string;
}

/** The keyword a type's own declaration is written with ({@link TypeDeclarationFact.declarationKind}). */
export type TypeDeclarationKind = "class" | "struct" | "enum" | "actor" | "protocol";

/**
 * One type declaration a file carries (`FileExtraction.typeDeclarations`).
 */
export interface TypeDeclarationFact {
  /** The type's composed id, nesting included: `Request`, `Request.State`. */
  readonly typeId: string;
  /**
   * `true` for a RE-OPENING — a declaration that adds members to a type
   * declared elsewhere (Swift `extension`) — and `false` for the type's own
   * declaration. A type with re-openings only is not the project's type.
   */
  readonly reopens: boolean;
  /**
   * The keyword of the type's OWN declaration — `class`, `struct`, `enum`,
   * `actor` or `protocol` (bd tea-rags-mcp-y99pg.35). What a consumer reads it
   * for is what the kind can hold: only a class carries an implementation the
   * Objective-C runtime dispatches a selector to. Absent on a re-opening, and
   * on a fact written before the walker published it — a consumer treats that
   * as "any kind".
   */
  readonly declarationKind?: TypeDeclarationKind;
  /**
   * The supertypes this declaration names — superclass and protocols alike, in
   * clause order, generic arguments dropped (`Base<T>` → `Base`). A re-opening
   * lists the conformances IT adds (`extension SecTrust: AlamofireExtended`).
   * Absent when the declaration names none.
   */
  readonly conforms?: readonly string[];
  /**
   * The type's own generic parameter names, in order (`Protected<Value>` →
   * `["Value"]`) — the positions {@link fieldTypeArguments} and
   * {@link memberClosureParameters} are read against (bd
   * tea-rags-mcp-y99pg.13). Absent on a non-generic type and on re-openings.
   */
  readonly genericParameters?: readonly string[];
  /**
   * Stored properties this declaration types with generic arguments, by
   * property name: `let mutableState: Protected<MutableState>` →
   * `{ mutableState: ["MutableState"] }`. Each argument is the nominal its type
   * text names, `null` where it names none. Absent when no property has any.
   */
  readonly fieldTypeArguments?: Readonly<Record<string, readonly (string | null)[]>>;
  /**
   * Stored properties this declaration initializes with an UNSPECIALISED
   * construction and no annotation, by property name: `let state =
   * Protected(State())` → `{ state: { type: "Protected", arguments: [{ label:
   * null, type: "State" }] } }` — each argument's label and the nominal it
   * constructs, `null` where it constructs none. What the constructed type's
   * {@link genericInitializers} bind its generic arguments from (bd
   * tea-rags-mcp-y99pg.26). Absent when no such property has an argument of
   * known type.
   */
  readonly fieldConstructions?: Readonly<Record<string, SwiftFieldConstruction>>;
  /**
   * A generic type's initializers that take a parameter typed exactly as one
   * of its {@link genericParameters}: each one's argument labels in order
   * (`null` for `_`) and, per position, the generic parameter it binds or
   * `null` — `init(_ value: Value)` → `{ labels: [null], binds: ["Value"] }`
   * (bd tea-rags-mcp-y99pg.26). Absent when none does.
   */
  readonly genericInitializers?: readonly GenericInitializerFact[];
  /**
   * For each method taking ONE function-typed parameter, the types that
   * function's parameters are declared with, by method name:
   * `func write<U>(_ closure: (inout Value) throws -> U)` → `{ write: ["Value"] }`.
   * An entry is a nominal — spelled with its generic arguments when every one
   * is a concrete nominal (`Result<URLRequest, Error>`, bd
   * tea-rags-mcp-y99pg.32) — one of {@link genericParameters} (bound per
   * receiver by its type arguments), or `null`. A method whose overloads disagree maps
   * to `null`. Absent when no method takes a closure.
   */
  readonly memberClosureParameters?: Readonly<Record<string, readonly (string | null)[] | null>>;
  /**
   * The methods whose return IS their closure's result, every overload of the
   * name agreeing: a method generic `U` declared as the return and as what the
   * one closure parameter returns — `func read<U>(_ closure: (Value) throws ->
   * U) rethrows -> U`. A call passing a key path `\.p` there returns the type
   * of `p` on the closure's parameter (bd tea-rags-mcp-y99pg.37). Absent when no
   * method is one.
   */
  readonly closureResultMembers?: readonly string[];
  /**
   * An enum's cases that carry a payload, by case name, each payload slot's
   * nominal type in position order (`case group(ExampleGroup, count: Int)` →
   * `group: ["ExampleGroup", "Int"]`, `null` for a slot no nominal names) —
   * what a `case .group(let g)` pattern in another file binds `g` to (bd
   * tea-rags-mcp-y99pg.16). Absent when no case carries a payload.
   */
  readonly enumCasePayloads?: Readonly<Record<string, readonly (string | null)[]>>;
  /**
   * The id this declaration's members compose under when it differs from
   * {@link typeId}: `extension Collection<String>` composes
   * `Collection<String>#qualityEncoded` while its typeId is `Collection` (bd
   * tea-rags-mcp-y99pg.19). Absent when the two agree.
   */
  readonly spelledAs?: string;
  /**
   * The return type of each FUNCTION-typed alias this declaration's body
   * declares: `typealias Handler = (Callback) -> DataRequest` →
   * `Handler: "DataRequest"` — what calling a stored closure of that alias
   * yields (bd tea-rags-mcp-y99pg.22). Absent when none.
   */
  readonly functionAliasReturns?: Readonly<Record<string, string>>;
  /**
   * What a re-opening's `where` clause says `Self` is inside its body:
   * `extension Download where Self: DataSerializer` → `types: ["DataSerializer"]`
   * (a `Self == X` constraint names `X` the same way), with the declaration's
   * 1-indexed line span — the constraint holds inside THIS body only, and a
   * file routinely re-opens one protocol several times under different
   * constraints. Absent when the clause constrains nothing about `Self`.
   */
  readonly selfConstraints?: SelfConstraintFact;
  /**
   * The UpperCamelCase attribute types each stored property of this
   * declaration carries, in source order: `@Published var result` →
   * `{ result: ["Published"] }`. The candidates for the property's WRAPPER —
   * which one is (if any) is a question about the attribute's type, answered
   * at resolve time — and so for what `$result` projects (bd
   * tea-rags-mcp-y99pg.33). Absent when no property carries one.
   */
  readonly propertyAttributeTypes?: Readonly<Record<string, readonly string[]>>;
  /**
   * The properties this declaration declares OPTIONAL (`let error: AFError?`),
   * in source order — the ones whose value is an `Optional` of the type the
   * field channels publish for them (bd tea-rags-mcp-y99pg.33). Absent when
   * none is.
   */
  readonly optionalProperties?: readonly string[];
  /**
   * The member typealiases this declaration's body declares, each to the
   * nominal path it aliases (`typealias Output = DataStreamRequest.Stream<…>`
   * → `{ Output: "DataStreamRequest.Stream" }`). How a type satisfies an
   * associated type of a protocol it conforms to, and so what `Self.Output`
   * in that protocol's members means on it (bd tea-rags-mcp-y99pg.33). An
   * alias of a function, tuple, optional or metatype is left out. Absent when
   * none is nominal.
   */
  readonly memberTypeAliases?: Readonly<Record<string, string>>;
  /**
   * Stored properties whose declared type IS one of {@link genericParameters},
   * by property name: `var value: Value` inside `Protected<Value>` →
   * `{ value: "Value" }` — what a receiver's generic arguments substitute (bd
   * tea-rags-mcp-y99pg.34). Absent when none is.
   */
  readonly genericFieldParameters?: Readonly<Record<string, string>>;
  /**
   * A re-opening's `where` clause and the lines it scopes (bd
   * tea-rags-mcp-y99pg.34): inside `extension Protected where Value ==
   * Request.MutableState`, `self` is a `Protected<Request.MutableState>`.
   * Absent on a declaration without one.
   */
  readonly whereClause?: SwiftWhereClauseFact;
}

/** A constrained re-opening's `where` clause (`TypeDeclarationFact.whereClause`). */
export interface SwiftWhereClauseFact {
  /** 1-based first and last line of the re-opening the clause scopes. */
  readonly startLine: number;
  readonly endLine: number;
  /** Same-type requirements, type text as written: `Value == Request.MutableState` → `{ Value: "Request.MutableState" }`. */
  readonly sameType?: Readonly<Record<string, string>>;
  /** Conformance / superclass requirements, the nominal named: `ExtendedType: Bundle` → `{ ExtendedType: "Bundle" }`. */
  readonly bounds?: Readonly<Record<string, string>>;
}

/** A re-opening's constraints on `Self` (`TypeDeclarationFact.selfConstraints`). */
export interface SelfConstraintFact {
  /** The nominals `Self` conforms to or equals, in clause order. */
  readonly types: readonly string[];
  readonly startLine: number;
  readonly endLine: number;
}

/** A stored property's initializing construction (`TypeDeclarationFact.fieldConstructions`). */
export interface SwiftFieldConstruction {
  /** The constructed type as written, generic arguments absent. */
  readonly type: string;
  /** Each argument's label (`null` when unlabelled) and the nominal it constructs (`null` when none). */
  readonly arguments: readonly { readonly label: string | null; readonly type: string | null }[];
}

/** One initializer of a generic type (`TypeDeclarationFact.genericInitializers`). */
export interface GenericInitializerFact {
  /** Argument labels in order, `null` for an unlabelled parameter. */
  readonly labels: readonly (string | null)[];
  /** Per position, the type's generic parameter that parameter is typed as, or `null`. */
  readonly binds: readonly (string | null)[];
}

/**
 * One name a `from <module> import <name>` statement binds into its own module's
 * namespace (bd tea-rags-mcp-xpl83.3).
 */
export interface ModuleReexport {
  /**
   * The LOCAL name the statement binds — what an importer of THIS module sees.
   * `"*"` for `from <module> import *`, which binds no single name and stands
   * for whatever the source module exports.
   */
  readonly exportedName: string;
  /** The source module exactly as written: `".object_types"`, `"core.models"`, `".."`. */
  readonly sourceModule: string;
  /**
   * The name the SOURCE module exports it under — the two differ under `as`.
   * Absent for a star entry, which names nothing in particular.
   */
  readonly sourceName?: string;
}

/**
 * Argument types at ONE call site whose callee is known from syntax alone
 * (bd tea-rags-mcp-bvalc).
 */
export interface KnownTargetCallArgs {
  /**
   * Callee coordinate candidates in the symbolId convention
   * (`"Fq::Type#initialize"` / `"Fq::Type.build"`), ordered INNERMOST LEXICAL
   * SCOPE FIRST — Ruby's own constant-lookup order. The barrier picks the first
   * candidate that is a real method definition; a call site whose constant
   * resolves to nothing in-project contributes nothing.
   */
  readonly targets: readonly string[];
  /**
   * Per-POSITION argument type. `null` where the argument shape is not
   * conservatively typeable (a literal, a bare method result, an untyped
   * local). A `null` never votes and never vetoes — it is simply absent
   * evidence. The array is truncated at the first argument that breaks
   * positional correspondence (splat / double-splat / keyword pair).
   */
  readonly argTypes: readonly (RubyTypeRef | null)[];
}

/** The `(method, parameter)` coordinate an `@ivar` copies its value from. */
export interface ClassFieldParamLink {
  /** Short name of the enclosing instance method, e.g. `"initialize"`. */
  readonly method: string;
  /** Parameter name the field is assigned from, e.g. `"firm"`. */
  readonly param: string;
}

export interface ImportRef {
  /** Raw import path as written, e.g. `"./utils"`, `"@/lib/foo"`, `"react"`. */
  importText: string;
  /** Lexical position used by resolvers that need it (TS aliases, Python
   *  relative imports). 1-based line number. */
  startLine: number;
  /**
   * Optional LOCAL binding names introduced by this import statement
   * (bd tea-rags-mcp-2v16). For `import { RankModule, Foo as Bar } from "./m"`
   * this is `["RankModule", "Bar"]` — the names a call receiver can reference
   * in the importing file. Captures named specifiers (local name for
   * aliases), the default import binding, and the `* as ns` namespace
   * binding. Lets a resolver map a receiver DIRECTLY to its source module
   * via an exact name match instead of the kebab→Pascal filename-normalize
   * heuristic. Omitted (undefined) for bare side-effect imports
   * (`import "./polyfill"`) and for languages whose walkers don't populate
   * it — every other-language walker keeps emitting `ImportRef` unchanged.
   */
  importedNames?: string[];
  /**
   * Optional map from each LOCAL binding name to the name the MODULE exports it
   * under (bd tea-rags-mcp-w65s7). `import { create as createAction } from
   * "./repo"` is `{ createAction: "create" }`; an unaliased `{ create }` is the
   * identity entry `{ create: "create" }`, so the map is a COMPLETE binding
   * table for every specifier that names a member.
   *
   * Distinct from {@link importedNames}, which answers "what can a RECEIVER be
   * called here" and is also the dispatch-table gate. This one answers "if this
   * identifier is CALLED, which exported member does it reach" — the question a
   * bare call asks, and the one an alias makes unanswerable from the local name
   * alone. A default import and a `* as ns` namespace bind no single exported
   * member, so they appear in `importedNames` and NOT here.
   *
   * Every shape that introduces a callable module binding feeds it: ESM named
   * specifiers, `require` destructures, destructured dynamic `import()`, and a
   * member destructured off an already-imported namespace
   * (`const { pathIds } = DirectoryHelper`) — the last of which adds a key
   * WITHOUT adding to `importedNames`, since it is neither a receiver name nor
   * a dispatch table.
   */
  importedBindings?: Record<string, string>;
  /**
   * Names this statement takes from the TARGET module's export surface
   * (bd tea-rags-mcp-r8hme.2), in the target's spelling — `import { a as b }`
   * takes `a`. `default` is a default import, `*` the whole module (a
   * namespace import, `import m` in Python, a require bound whole). Absent when
   * the statement names nothing (a side-effect import) or the walker does not
   * record it. Carried onto the persisted file edge; the facade check reads it.
   */
  importedExportNames?: string[];
  /**
   * Names a source re-export forwards from the target (`export { a } from`),
   * in the target's spelling; `*` for `export * from` / `export * as ns from`.
   * Absent on every statement that is not a source re-export.
   */
  reexportedExportNames?: string[];
}

export interface ChunkExtraction {
  symbolId: SymbolId;
  /** Lexical scope chain enclosing this chunk, e.g. `["Acme", "Auth", "User"]`. */
  scope: string[];
  /**
   * The scope this chunk's OWN calls run in, when it is not `scope` — a TYPE
   * chunk, whose declaration sits in its parent's scope while a computed
   * property or a stored-property initializer in its body runs inside the type
   * (bd tea-rags-mcp-3ievc). Absent for every other chunk, and for every chunk
   * of a language whose `nameOf` never sets `opensSelfScope`. Read it through
   * {@link chunkCallerScope}, never directly.
   */
  bodyScope?: string[];
  calls: CallRef[];
  /** 1-based start line of the chunk in the source file. Optional so
   *  walkers that don't track line info keep working. */
  startLine?: number;
  /** 1-based end line of the chunk. Optional, see startLine. */
  endLine?: number;
  /**
   * Per-chunk variable-to-type bindings emitted by walkers that can
   * statically infer the receiver type of a method call (`var.method()`).
   * Currently populated by the Python walker (gated by
   * `CODEGRAPH_PY_LOCAL_TYPE_TRACKING`) from three sources:
   *   - constructor assignments: `var = ClassName(...)` → `{ var: "ClassName" }`
   *   - PEP 526 variable annotations: `var: ClassName = ...` → `{ var: "ClassName" }`
   *   - function argument type hints: `def f(self, req: HttpRequest)` →
   *     `{ req: "HttpRequest" }` for the body of `f`.
   *
   * Resolvers consult this map BEFORE the import-receiver match so an
   * unambiguous local type pins `var.method()` to that type's class even
   * when the short-name has multiple project-wide definitions.
   *
   * Shape: `Record<string, LocalBinding[]>` (NOT `Map`) so the structure
   * round-trips through the NDJSON spill (`JSON.stringify` / `JSON.parse`)
   * — `Map` would serialize to `{}` and silently lose data. Each variable
   * carries an array of position-aware bindings (one per assignment on its
   * path); read via {@link resolveLocalBindingType} at a call's line.
   */
  localBindings?: Record<string, LocalBinding[]>;
  /**
   * Per-chunk `varName → calledFunctionName` map for variables assigned from
   * a function call (`engine := New()` → `{ engine: "New" }`). DISTINCT from
   * `localBindings` (which maps to a TYPE): this maps to the CALLED FUNCTION's
   * short name, because the walker cannot know the function's return type from
   * the chunk alone (the function may be declared in another file). The
   * resolver looks the called name up in `CallContext.functionReturnTypes` to
   * obtain the return type, then resolves `varName.method()` against it.
   *
   * Populated by the Ruby walker (bd tea-rags-mcp-6g9c). It is CHUNK-WIDE — one
   * entry per name, no position — which is why Go moved its call bindings to
   * the position-aware `callResultBindings` (bd tea-rags-mcp-e6xx); the Go
   * resolver still reads an entry here as a binding in scope on every line.
   *
   * Plain Record (NOT Map) for NDJSON-spill round-trip, same as localBindings.
   */
  localCallBindings?: Record<string, string>;
  /**
   * Per-chunk `varName → CallResultBinding[]` — the locals assigned from a call
   * whose RETURN TYPE the walker cannot know, recorded as the callee SPELLING
   * for the resolver to fold (bd tea-rags-mcp-z68v9). See
   * {@link CallResultBinding} for why this is a second channel beside
   * `localCallBindings` rather than a widening of it.
   *
   * Populated by the Python walker under `CODEGRAPH_PY_LOCAL_TYPE_TRACKING`,
   * for single-identifier targets only: tuple unpacking, a chained or
   * subscripted callee, and a module-level assignment are all omitted. And by
   * the Go walker (bd tea-rags-mcp-e6xx) for a single-LHS short var decl whose
   * RHS calls a plain identifier or a package selector (`x := New()`,
   * `x := pkg.New()`), with `endLine` / `scopeEndLine` carrying Go's scope.
   *
   * Plain Record (NOT Map) for NDJSON-spill round-trip, same as localBindings.
   */
  callResultBindings?: Record<string, CallResultBinding[]>;
  /**
   * Positional-arity envelope of the method definition this chunk represents
   * (bd xlnub). Populated by the Ruby walker for `method` / `singleton_method`
   * nodes. Undefined for non-method chunks and for languages whose walkers
   * don't compute arity.
   */
  arity?: AritySignature;
  /**
   * Positional parameter NAMES of the method definition this chunk represents,
   * in declaration order (bd tea-rags-mcp-bvalc). Only the LEADING run of
   * plain required positionals is recorded — the list is truncated at the first
   * optional / splat / keyword / block parameter, past which a call site's
   * argument index no longer corresponds to a fixed parameter. Empty run ⇒
   * undefined.
   *
   * Kept beside {@link AritySignature} rather than inside it: arity is
   * persisted on `SymbolDefinition` and consumed by the arity narrower, while
   * names exist only to map a call site's argument POSITION to a parameter
   * NAME at the pass-1→pass-2 barrier.
   */
  paramNames?: string[];
  /**
   * DECLARED access level of the definition this chunk represents (bd xlnub),
   * mapped per language onto one three-value union. Ruby's walker fills it from
   * the class-body visibility state machine (`private` / `protected` / `public`
   * bare calls, inline `private def`, symbol form); every other native language
   * fills it through its declared-visibility pass (bd tea-rags-mcp-jwjyr.1,
   * `<lang>/walker/passes/declared-visibility.ts`, or the def-signature pass for
   * Python). Undefined wherever the language states no provable level — Java
   * package-private, a Python `_name`, a TypeScript declaration outside a class.
   *
   * The same word means different reach per language (Ruby: no explicit
   * receiver; TypeScript/Java: the declaring class; Swift: the file; Go: the
   * package; Rust: the module tree), so a consumer never reads `"private"`
   * without that language's access rule — see `VisibilityAccessPolicy`.
   */
  visibility?: "public" | "private" | "protected";
  /** Keyword-arg signature of the method this chunk represents (bd d9o7o).
   *  Populated by the Ruby walker; undefined for non-method chunks. */
  kwargs?: KwargSignature;
  /** Method yields or takes an `&block` param (bd d9o7o). `false` = proven
   *  non-yielder; undefined for non-method chunks. */
  acceptsBlock?: boolean;
  /**
   * The method this chunk represents is an ABSTRACT STUB — a declaration with no
   * implementation (bd tea-rags-mcp-bcdfe). Populated by the Ruby walker for the
   * three conservative shapes the self-dispatch spec admits: an empty body, a
   * single-statement `raise NotImplementedError`, or a single-statement `super`.
   * Consumed by the codegraph self-dispatch discovery, where a stub is NOT a
   * concrete definition of its member (so the template's hook stays abstract-in-A
   * and the REDIRECT terminal fires).
   *
   * Only ever `true` — absent means "not a stub / not captured", so the field
   * costs nothing on the ~99% of defs that carry a real body. Detection is
   * deliberately narrow: mis-marking a real base method as a stub would fabricate
   * hook edges (spec "Risks" → abstract-stub conservatism).
   */
  isAbstractStub?: boolean;
}

export interface CallRef {
  /** Source text of the call expression, e.g. `"Foo.bar()"` or `"User.find"`. */
  callText: string;
  /** Receiver part for member calls, `"Foo"` in `"Foo.bar()"`. `null` for
   *  free calls like `"bar()"`. */
  receiver: string | null;
  /** Member part for member calls, `"bar"` in `"Foo.bar()"`. The free-call
   *  name otherwise. */
  member: string;
  startLine: number;
  /**
   * The receiver exactly as the source spells it, where a language's
   * `receiver` normalizes sugar away: Swift strips optional chaining and
   * force unwraps (`a?.b!` → `a.b`) so the receiver matches the names
   * bindings are keyed by, and only this text still says which links read a
   * member off an `Optional` and which off what it wraps (bd
   * tea-rags-mcp-y99pg.33). Absent when identical to `receiver`.
   */
  writtenReceiver?: string;
  /**
   * Present when this call dispatches through a lookup table
   * (bd tea-rags-mcp-n0zj). The resolver expands it to fan-out edges over
   * the run-global tables and SKIPS normal receiver resolution for this
   * call. See `DispatchRef`: `field: null` ⇒ S2 (the entry is the
   * function), `key: null` ⇒ dynamic key (fan-out all entries).
   */
  dispatch?: DispatchRef;
  /**
   * Present when this NORMAL call passes a dispatch candidate-set as an
   * ARGUMENT (bd tea-rags-mcp-n0zj). `receiver`/`member` still identify
   * the callee so the resolver can resolve which function is called, then
   * join `argIndex` against that callee's `callbackParams`: if the callee
   * invokes the parameter at `argIndex`, the callee fans out to the
   * candidates. The candidate mirrors `dispatch` — it may itself be
   * `TABLE[k].field` or a dispatch-bound local.
   */
  dispatchArgs?: { argIndex: number; candidate: DispatchRef }[];
  /**
   * Set by the walker when this call is a dynamic dispatch whose target is NOT a
   * statically-known literal — `send(var)` / `public_send(expr)` / `__send__(x)`
   * with a non-literal first argument. The codegraph counts an UNRESOLVED
   * dynamicSend as `callsUnresolvable` (statically undeterminable), excluded from
   * the resolveSuccessRate denominator — distinct from `externalSkipped`
   * (framework) and from a genuine internal miss (bd cai0).
   */
  dynamicSend?: boolean;
  /**
   * The literal `<receiver>.call(…)` / `.apply(…)` / `.bind(…)` member call the
   * walker UNWRAPPED this ref from (bd tea-rags-mcp-f2u54). `receiver`/`member`
   * above name the invoked function; this names the invoker as written.
   *
   * The unwrap is a syntactic bet that the invoker's receiver is a function. It
   * is wrong whenever the receiver is an OBJECT whose type declares a member of
   * that name — `this.connection.call(fn)` on a class with a real `call` method
   * — and only the resolver, holding the symbol table, can tell the two apart.
   * So the walker keeps both readings and the resolver picks (bd
   * tea-rags-mcp-g7h1y).
   */
  functionInvokerSite?: { receiver: string; member: string };
  /**
   * Set by the walker when this call site is a JSX component tag rather than a
   * call expression — `<Foo prop={x} />`, which is sugar over
   * `React.createElement(Foo, …)` (or the automatic runtime's `jsx(Foo, …)`).
   * `member` is the tag's own name and `receiver` the qualifier of a dotted tag
   * (`<UI.Panel />` → `UI` / `Panel`), so every receiver-shaped pass reads the
   * site exactly as it reads `UI.Panel()`.
   *
   * Load-bearing for the JSX resolution pass, which locates the site by JSX AST
   * shape (`JsxOpeningElement` / `JsxSelfClosingElement`) rather than by
   * `CallExpression` and must not pay for a Program build on ordinary calls
   * (bd tea-rags-mcp-b4pvp).
   */
  jsx?: boolean;
  /** Positional argument count at the call site (bd xlnub). */
  argCount?: number;
  /** Keyword-arg key names at the call site (bd d9o7o). */
  kwargKeys?: string[];
  /** Call passes a `**opts` double-splat — unknown runtime keys (bd d9o7o). */
  hasKwargSplat?: boolean;
  /** Call passes a block (`{ … }` / `do … end`) (bd d9o7o). */
  passesBlock?: boolean;
}

/**
 * Sink the chunker writes to. The codegraph enrichment provider implements
 * it. Call order: `write(extraction)` once per file → `finish()` once per
 * ingest batch.
 */
export interface ExtractionSink {
  write: (extraction: FileExtraction) => Promise<void>;
  finish: () => Promise<void>;
}

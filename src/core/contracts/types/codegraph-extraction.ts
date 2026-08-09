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
import type { LocalBinding } from "./codegraph-local-binding.js";
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
}

export interface ChunkExtraction {
  symbolId: SymbolId;
  /** Lexical scope chain enclosing this chunk, e.g. `["Acme", "Auth", "User"]`. */
  scope: string[];
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
   * Populated by the Go walker for single-LHS short-var-decls whose RHS is a
   * call to a plain identifier (`New()`) or a package selector (`pkg.New()` →
   * records the bare last segment `New`). Multi-LHS (`a, b := f(), g()`) and
   * chained-call RHS (`New().Configure()`) are OMITTED — the var↔return pairing
   * is not unambiguous. bd tea-rags-mcp-6g9c.
   *
   * Plain Record (NOT Map) for NDJSON-spill round-trip, same as localBindings.
   */
  localCallBindings?: Record<string, string>;
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
   * Visibility of the method definition this chunk represents (bd xlnub).
   * Populated by the Ruby walker using the class-body visibility state machine
   * (`private` / `protected` / `public` bare calls, inline `private def`,
   * symbol form). Undefined for non-method chunks and non-Ruby languages.
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

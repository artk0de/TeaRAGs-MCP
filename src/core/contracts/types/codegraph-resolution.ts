/**
 * Codegraph resolution contracts — the pass-2 half of the pipeline, where an
 * extracted `CallRef` becomes a graph edge. `CallContext` is everything a
 * resolver may read at a call site (the run-global symbol table, the caller's
 * imports and scope, and the merged per-language type / ancestor / dispatch
 * maps the pass-1→pass-2 barrier assembled); `CallResolver` is the one
 * interface each language implements against it.
 *
 * `AmbiguousResolveMode` and `pickSingleCandidate` live here because the
 * cardinality guard — drop rather than guess when a short name has N
 * definitions — is the same in every resolver and must change in one place.
 * Re-exported verbatim by the `codegraph.ts` barrel.
 */

import type { DispatchFanoutOutcome, DispatchTableDef } from "./codegraph-dispatch.js";
import type { CallRef, FileExtraction, ImportRef } from "./codegraph-extraction.js";
import type { GraphEdges } from "./codegraph-graph.js";
import type { HierarchyView } from "./codegraph-hierarchy.js";
import type { LocalBinding } from "./codegraph-local-binding.js";
import type { GlobalSymbolTable, RelPath, SymbolId } from "./codegraph-symbols.js";
import type { RubyTypeRef } from "./language.js";

/**
 * What a pass-2 run tells one language's resolver BEFORE its first call site —
 * the shape of the work about to arrive, not any one call (bd tea-rags-mcp-6aytq).
 *
 * Pass-1 has already walked every file the run will resolve, so the volume is a
 * FACT at the pass-2 barrier rather than something a resolver must infer from
 * the calls it has seen so far. A resolver whose caches are worth priming in
 * one go — TypeScript's `ts.Program` above all, where per-entry construction is
 * 16x the cost of building the project once — reads this instead of waiting for
 * a warm-up heuristic to conclude the same thing 66 builds later.
 */
export interface SymbolResolutionPassPlan {
  /**
   * Files of THIS resolver's language the pass will resolve. Per language, not
   * per run: a run of 10,000 Ruby files and 40 TypeScript ones is not a bulk
   * pass for TypeScript, and priming a whole-project Program for it would pay
   * the build the volume does not justify.
   */
  expectedFileCount: number;
  /**
   * The very files {@link expectedFileCount} counts, repo-relative — this
   * pass's own corpus (bd tea-rags-mcp-6aytq).
   *
   * The count and the list answer different questions and a resolver may need
   * both. The count says whether a cache only a bulk pass repays is worth
   * building at all; the list says what that cache must be built OVER, which
   * nothing else can supply: a project's declared file set is not the set a run
   * resolves. Measured on taxdome — the tsconfig expansion names 12,335 files,
   * the run resolves 10,912, and 936 of those are outside the expansion, each
   * one costing TypeScript a `ts.createProgram` its whole-project Program was
   * supposed to have removed.
   *
   * Optional because it is an OPTIMISATION channel, not a contract a resolver
   * may require: a caller with only a count still primes correctly, just
   * against the project's own idea of itself.
   */
  expectedRelPaths?: readonly RelPath[];
  /**
   * Project root the pass resolves against — the same value every
   * `CallContext` of the pass carries. Present here because a resolver bound
   * lazily to a root (TypeScript: `tsconfig.json`, the file probe, the
   * Program) has no call site to read it off yet.
   */
  projectRoot?: string;
}

/**
 * Language-specific call resolver. One implementation per language. Slice 1
 * ships `TSCallResolver`; slice 3 adds Ruby/Python/Elixir.
 */
export interface CallResolver {
  readonly language: string;
  resolve: (call: CallRef, ctx: CallContext) => SymbolResolutionTarget | null;
  /**
   * Optional: the pass is about to start, and this is what it will ask for
   * (bd tea-rags-mcp-6aytq). Called at most once per language per pass-2,
   * before the first `resolve`.
   *
   * Advisory by construction — the plan says how much work is coming, never
   * what to do about it. A resolver with nothing to prime omits the method and
   * behaves identically; one that primes must still degrade to its per-call
   * path when the priming fails, because nothing downstream is told either way.
   * Mirrors `LanguageSymbolResolver.prepareResolvePass`.
   */
  prepareResolvePass?: (plan: SymbolResolutionPassPlan) => void;
  /**
   * Optional: what this resolver's run-scoped caches did, as a JSON-able record
   * for the pass's progress log (bd tea-rags-mcp-6aytq).
   *
   * Deliberately opaque — the seam is language-agnostic and the field names are
   * the resolver's own, so a TypeScript `ts.Program` observable never becomes
   * part of the contract every other language implements against. Read at most
   * once per progress line, never on the resolve path; a resolver with nothing
   * to report omits the method and its language is simply absent from the line.
   * Mirrors `LanguageSymbolResolver.diagnostics`.
   */
  diagnostics?: () => Record<string, unknown> | undefined;
  /**
   * Optional fan-out resolution for lookup-table dispatch
   * (bd tea-rags-mcp-n0zj). Given a `CallRef` carrying `dispatch` and/or
   * `dispatchArgs`, returns every fan-out edge the call implies:
   *   - `dispatch` → one edge per resolved candidate, `sourceSymbolId:
   *     null` (the provider fills the caller's symbolId).
   *   - `dispatchArgs` → the bounded inter-procedural join: edges from the
   *     resolved CALLEE to each candidate (non-null `sourceSymbolId`).
   * Resolvers that don't support dispatch tables omit this method; the
   * provider guards with `?.` so other-language resolvers are unaffected.
   */
  resolveDispatch?: (call: CallRef, ctx: CallContext) => DispatchFanoutOutcome;
  /**
   * Optional per-file edge resolution (tea-rags-mcp Ruby Zeitwerk +
   * inheritance). Returns file→file edges for `extraction`, owning the
   * language's full set of file-coupling channels: explicit imports, any
   * convention-based references (Ruby `zeitwerk:` constant refs), AND
   * inheritance/mixin coupling (`classAncestors` / `classPrependedAncestors`)
   * — all folded into one `fileEdges[]` so they share fanIn/fanOut.
   *
   * When a resolver omits this method the provider falls back to the generic
   * synthesised-call import loop (`defaultImportFileEdges`). That fallback is
   * correct for languages whose file graph comes purely from explicit imports
   * (TypeScript/Python/Go/Java/Rust/JS); it CANNOT see the `zeitwerk:` channel
   * (the prefix is the walker↔resolver contract, opaque to the provider) nor
   * inheritance edges, which is exactly why Ruby implements this method.
   */
  resolveFileEdges?: (extraction: FileExtraction, ctx: CallContext) => GraphEdges["fileEdges"];
  /**
   * Optional: does this UNRESOLVED call target an external library / runtime
   * import rather than an in-project resolver miss? (tea-rags-mcp-ykj7). The
   * codegraph provider consults it ONLY for calls `resolve`/`resolveDispatch`
   * could not pin to a target, so it never reclassifies a resolved call.
   * Returning `true` excludes the call from the `resolveSuccessRate` denominator
   * (counted separately as `callsExternalSkipped`), so the metric reflects the
   * resolver's capability on PROJECT-INTERNAL calls rather than the unresolvable
   * external-library noise (`Math.max`, `fs.readFile`, `Net::HTTP.get`, …).
   *
   * Mirrors `LanguageSymbolResolver.targetsExternalImport`. Resolvers that omit
   * it keep every unresolved call in the denominator (conservative — never
   * over-shrinks).
   */
  targetsExternalImport?: (call: CallRef, ctx: CallContext) => boolean;
  /**
   * Optional: is this UNRESOLVED, non-external call a CORE HOMONYM
   * (tea-rags-mcp-83cl7)? True when the member belongs to the language's core /
   * runtime vocabulary (`each`, `to_s`, `first`) AND the receiver is UNTYPED —
   * the real callee is the runtime, but a project class defining the same short
   * name defeats the `lookupByShortName === 0` gate and manufactures a phantom
   * recall hole. Counted as `callsCoreAmbiguous` and excluded from the
   * `inProjectEdgeRecall` / `resolveSuccessRate` denominators, exactly like
   * `callsExternalSkipped`.
   *
   * Consulted ONLY after `targetsExternalImport` and the no-in-project-def gate,
   * and never for a resolved call. A TYPED receiver whose class genuinely
   * defines the member must answer `false` — precision runs in reverse here, a
   * wrong `true` HIDES a real miss. Mirrors
   * `LanguageSymbolResolver.targetsCoreAmbiguousMember`; resolvers that omit it
   * keep every such call in the denominator.
   */
  targetsCoreAmbiguousMember?: (call: CallRef, ctx: CallContext) => boolean;
}

/**
 * Behavior for short-name lookups that return more than one candidate
 * (e.g. `serializer.is_valid()` where `is_valid` is defined on N classes).
 *
 *   - `strict` (default): exactly one candidate is required, else the edge
 *     is dropped. Eliminates false positives like the DRF `is_valid()` call
 *     being attributed to an unrelated model class.
 *   - `first`: legacy behavior — pick the first candidate when multiple
 *     match. Higher recall, more false positives. Use only when downstream
 *     consumers depend on arbitrary-but-non-null edges.
 *
 * Wired through `CODEGRAPH_AMBIGUOUS_RESOLVE_MODE`; resolvers consume the
 * mode via constructor injection so the choice is fixed at composition
 * time, not per-call.
 */
export type AmbiguousResolveMode = "strict" | "first";

export const DEFAULT_AMBIGUOUS_RESOLVE_MODE: AmbiguousResolveMode = "strict";

/**
 * Picks a single resolution from a candidate list. The cardinality guard
 * is the same in every resolver — extracted so a global behavior change
 * (e.g. flipping default mode, adding `unique-by-file`) lands in one spot.
 *
 * - `strict`: returns the sole element when `candidates.length === 1`,
 *   else `null`. Drops both empty AND ambiguous results.
 * - `first`: returns `candidates[0]` if any. Drops only empty results.
 */
export function pickSingleCandidate<T>(candidates: readonly T[], mode: AmbiguousResolveMode): T | null {
  if (candidates.length === 0) return null;
  if (mode === "first") return candidates[0];
  return candidates.length === 1 ? candidates[0] : null;
}

export interface CallContext {
  callerFile: RelPath;
  callerScope: string[];
  /**
   * The caller chunk's own symbolId. For a CLASS/MODULE-body chunk this is the
   * class FQ (`Ns::Klass` — `::` namespace only, no `#`/`.`), which `callerScope`
   * OMITS by convention (a class chunk's scope excludes its own name, and is
   * empty for a top-level class). bareCall MRO narrowing anchors on this for
   * class-body edges (callbacks/associations) that `callerScope` cannot pin. A
   * method chunk's symbolId carries `#`/`.` and is ignored — `callerScope` (the
   * full class path) wins there. Set by the provider per-call from `chunk.symbolId`.
   */
  callerSymbolId?: string;
  /** May be empty for autoload-based languages (Ruby/Rails). */
  imports: ImportRef[];
  symbolTable: GlobalSymbolTable;
  /** Optional language-specific config (tsconfig paths, Zeitwerk root, etc.). */
  languageConfig?: unknown;
  /**
   * Optional per-class field-type map propagated from `FileExtraction`.
   * Resolvers use it to handle `this.<field>.<method>()` cross-class calls
   * (TypeScript / Java): look up `<field>` in `classFieldTypes[callerScope]`
   * to obtain the receiver type, then resolve the method against that type
   * in the global symbol table.
   */
  classFieldTypes?: Record<string, Record<string, string>>;
  /**
   * Optional per-class Rails association map (`className → accessor →
   * modelType`) propagated from `FileExtraction.associationTypes`. The walker
   * consumes it directly to type compound-receiver chains into `localBindings`;
   * it is also carried on the context for resolvers that want association-aware
   * receiver typing without re-deriving the map.
   */
  associationTypes?: Record<string, Record<string, string>>;
  /**
   * Per-chunk local variable bindings (`varName → typeName`) inferred by
   * the walker from assignments / type annotations within the enclosing
   * function or method body. Set by the provider per-call from the
   * caller chunk's `ChunkExtraction.localBindings`.
   *
   * Resolvers consult this BEFORE the receiver-matches-import path so a
   * locally-typed variable wins over ambiguous short-name resolution.
   * Position-aware (`Record<string, LocalBinding[]>`): read via
   * {@link resolveLocalBindingType} at the call's `startLine`.
   */
  localBindings?: Record<string, LocalBinding[]>;
  /**
   * Per-chunk `varName → calledFunctionName` map propagated from
   * `ChunkExtraction.localCallBindings`. Resolvers combine this with
   * `functionReturnTypes` to bind `x := New(); x.method()` to
   * `<New's return type>#method`. Set by the provider per-call from the
   * caller chunk's `localCallBindings`. bd tea-rags-mcp-6g9c.
   */
  localCallBindings?: Record<string, string>;
  /**
   * Run-global `functionName → declaredReturnTypeName` map propagated from
   * `FileExtraction.functionReturnTypes` (merged across all pass-1 files so
   * a call's return type is available even when the function is declared in
   * another file). Resolvers use it together with `localCallBindings` to
   * resolve `x := New(); x.method()`. The resolver MUST still verify the
   * return type exists as a concrete type symbol before binding — the walker
   * records the declared name verbatim and does no symbol-table check.
   * bd tea-rags-mcp-6g9c.
   */
  functionReturnTypes?: Record<string, string>;
  /**
   * Optional `className → ancestor[]` map propagated from
   * `FileExtraction.classAncestors`. Resolvers walk this list when a
   * receiver-typed method lookup misses on the bound class so inherited
   * methods (`User.find(id).save` where `save` lives on
   * `ApplicationRecord`) still produce edges. First entry = direct
   * superclass; subsequent entries = mixins in declaration order.
   * Plain Record (NOT Map) for NDJSON-spill round-trip.
   */
  classAncestors?: Record<string, readonly string[]>;
  /**
   * FQs declared in COMPACT form (`class A::B::C`) — the intermediate namespaces
   * are not open lexical scopes. Read by `canonicalizeAncestorFq` to skip the
   * nesting prefix-walk for these classes (bd lawlq.3.7). Set (fast membership),
   * built by the provider from `FileExtraction.compactDeclaredClasses`.
   */
  compactDeclaredClasses?: ReadonlySet<string>;
  /**
   * Raw contents of the project's `Gemfile` (Ruby dependency manifest), read once
   * per run by the codegraph provider from the project root and attached to every
   * call context. The Ruby resolver reads it via `catalogueForGemfile` (parse +
   * compose, memoised by content) to gate DSL grammar to the gems THIS project
   * declares. Raw string, not a parsed Set — the parse lives in `domains/language`
   * where the catalogue lives, so the provider never imports it. Undefined when no
   * Gemfile exists → the FULL catalogue (gating off, byte-identical to pre-gating).
   * Only the Ruby resolver reads it today (bd tea-rags-mcp-adx5p.1).
   */
  gemfileContent?: string;
  /**
   * Absolute root of the project THIS run is indexing, threaded per run by the
   * codegraph provider exactly like {@link gemfileContent}. A resolver whose
   * answers depend on project-rooted state reads it here rather than capturing
   * a root when it was constructed: the provider is built once, before any
   * collection is bound, so construction time is strictly too early to know
   * which repository the calls belong to.
   *
   * The TypeScript resolver is the consumer today — `tsconfig.json` (path
   * aliases + `baseUrl`), the on-disk file probe, and the `ts.Program` the
   * typeChecker passes build all hang off this root. Undefined ⇒ the resolver
   * falls back to whatever root it was constructed with, which is what direct
   * construction (scripts, tests running inside the target repo) relies on.
   */
  projectRoot?: string;
  /**
   * Optional `className → parentClass` map propagated from
   * `FileExtraction.classExtends`. Resolvers walk this on `super()` /
   * `super.foo()` calls so the edge lands on the PARENT class's method
   * instead of self-looping back to the enclosing class. Single value
   * per class (TS / JS / Java single inheritance); `null` parent means
   * an external library / unresolved class — resolver should return null
   * or a file-only edge rather than fabricating a wrong target.
   * Plain Record (NOT Map) for NDJSON-spill round-trip.
   */
  classExtends?: Record<string, string>;
  /**
   * Optional `className → prepended[]` map propagated from
   * `FileExtraction.classPrependedAncestors`. Ruby `prepend M` overrides
   * the class's own methods: resolvers MUST check prepended ancestors
   * BEFORE the class itself in instance-method dispatch, then fall
   * through to the class, then to regular ancestors. Last prepend wins
   * in MRO so the resolver walks the array in REVERSE order.
   */
  classPrependedAncestors?: Record<string, readonly string[]>;
  /**
   * Optional reverse include-by index (bd cai0/2oky5): `fqName → classes that
   * have it as a direct ancestor` (superclass/include/prepend). Derived by the
   * provider from the run-global ancestor maps and injected for pass-2. The Ruby
   * `super` strategy reads `includedBy[M]` to resolve a `super` inside module
   * M's method against each including class's MRO-after-M (consensus). Plain
   * Record for NDJSON-spill parity with the other ancestor maps.
   */
  includedBy?: Record<string, readonly string[]>;
  /**
   * Run-global `templateMethodSymbolId → abstractHookMember` map (bd
   * tea-rags-mcp — DEFECT 2, self-receiver abstract-hook dispatch). Built at the
   * pass-1→pass-2 barrier by `discoverSelfDispatchTemplates`: a method `M` is a
   * self-dispatch template when its body reaches a hook `H` on `self` that `M`'s
   * enclosing type does NOT concretely define but a related concrete type
   * (subclass / includer / prepender / extender) does. The Ruby self-dispatch
   * entry strategy reads it at an entry call `Const.member`: when `member`
   * resolves to a template `M` here, the concrete constant receiver narrows the
   * abstract hook to exactly `Const#H` (entry-anchored, no fan-out). Plain Record
   * for NDJSON-spill parity with the other run-global ancestor maps.
   */
  selfDispatchTemplates?: Record<string, string>;
  /**
   * Run-global list of CLASS-form method symbolIds that self-INSTANTIATE (bd
   * tea-rags-mcp — DEFECT 2 v2, self-instance delegation). Built at the
   * pass-1→pass-2 barrier by `collectSelfInstantiatingClassMethods` from the same
   * `SelfDispatchMethod[]` the template discovery folds over: a class method whose
   * body does `instance = new(*args); instance.member` (the `self.call → new.call`
   * service idiom) has `new` as its only self-hook, so it is NOT itself a
   * template — but it BRIDGES an entry constant to the SAME-named instance
   * template. The entry strategy's v2 branch reads it: at `Const.member` resolving
   * to such a class method, it re-resolves `Const#member` (instance form) and, when
   * THAT is a `selfDispatchTemplates` key, narrows the abstract hook to `Const#H`.
   * Plain array for NDJSON-spill parity with the other run-global maps.
   */
  selfInstantiatingClassMethods?: readonly string[];
  /**
   * Run-global `tableName → DispatchTableDef[]` map propagated from every
   * file's `FileExtraction.dispatchTables` (bd tea-rags-mcp-n0zj). Keyed
   * by table NAME; the value is a LIST because the same name may be
   * declared in more than one file. The resolver disambiguates by the
   * caller's import map (prefers the imported file, falls back to a sole
   * global, else drops). Consumed by `CallResolver.resolveDispatch`.
   */
  dispatchTables?: Record<string, DispatchTableDef[]>;
  /**
   * Run-global `fnSymbolId → invokedParamIndices` map merged across every
   * file's `FileExtraction.callbackParams` (bd tea-rags-mcp-n0zj). The
   * resolver reads it during the bounded inter-procedural join: when a
   * call resolves to a callee `F` listed here and the call passed a
   * dispatch candidate-set at one of `F`'s invoked param positions, `F`
   * fans out to the candidates.
   */
  callbackParams?: Record<string, number[]>;
  /**
   * Optional bidirectional hierarchy snapshot (bd tea-rags-mcp-f10y). Built by
   * the provider at the pass-1→pass-2 barrier and injected for pass-2. CHA /
   * STI fan-out reads `getDescendants`; the phased follow-up migrates the
   * forward Records onto `getAncestors`. Sync — no DB access on the resolve path.
   */
  hierarchy?: HierarchyView;
  // ── Ruby type-source propagation engine (Increment 1, Task 1.1) ────────────
  /**
   * Optional per-class instance-variable type map: `fqClassName → ivarName →
   * typeName`. Merged run-global from `FileExtraction.ivarTypes` by the
   * codegraph provider (pass-1 barrier, mirrors `functionReturnTypes`). The
   * ivar name is recorded with the leading `@` (`"@account"`, `"@user"`). The
   * resolver binds `@ivar.method()` calls to `<typeName>#method` for
   * annotated Ruby code. Undefined for languages without ivar annotations and
   * for Ruby files not covered by a type source.
   *
   * Read it through `ivarTypeName` (`ruby/resolver/type-propagation.ts`), never
   * inline: that helper is the single authority ordering this map ahead of the
   * inference-based {@link CallContext.classFieldTypes}. See
   * {@link FileExtraction.ivarTypes} for why the map is empty today.
   *
   * Plain Record (NOT Map) for NDJSON-spill round-trip.
   */
  ivarTypes?: Record<string, Record<string, string>>;
  /**
   * Run-global `fqMethodKey → RubyTypeRef` map populated by the Ruby
   * type-source propagation engine. The engine writes the RICHER structured
   * return reference here (`{ form: "union", members: […] }`, container types,
   * class vs instance form) while the EXISTING flat `functionReturnTypes` map
   * (a bare type-name string) remains UNTOUCHED for backward compatibility.
   * Resolvers that support `RubyTypeRef` read this map; resolvers that don't
   * fall through to `functionReturnTypes`. The key format is
   * `"ClassName#method"` for instance methods and `"ClassName.method"` for
   * class methods. Undefined when the engine has not run or no annotations
   * were found for this file.
   */
  structuredReturnTypes?: Record<string, RubyTypeRef>;
  /**
   * Run-global instantiation set merged from every file's
   * `FileExtraction.instantiatedTypes` (bd tea-rags-mcp-pffv). Built by the
   * provider at the pass-1→pass-2 barrier, mirroring `functionReturnTypes`.
   * `ConeDispatchResolver` reads it to prune the CHA cone via RTA: a cone
   * member survives only when it is `nearestDefiner(U, m)` for some
   * instantiated `U <: T`. Absent / empty ⇒ the cone engine keeps its full
   * pre-pffv fan-out (the gate). Key form matches `HierarchyView` fq names.
   */
  instantiatedTypes?: ReadonlySet<string>;
}

export interface SymbolResolutionTarget {
  targetRelPath: RelPath;
  /** `null` when the resolver can determine the file but not the specific
   *  method (dynamic dispatch). */
  targetSymbolId: SymbolId | null;
}

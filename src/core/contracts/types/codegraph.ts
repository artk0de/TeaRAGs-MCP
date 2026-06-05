/**
 * Codegraph slice 1 contracts — language-agnostic types shared between the
 * chunker (which emits extractions), the codegraph trajectory (which
 * resolves them and writes to the graph DB), and the graph DB adapter
 * (DuckDB for slice 1, PostgreSQL planned for slice 4).
 *
 * Lives in `contracts/` per `.claude/rules/domain-boundaries.md`:
 * foundation layer, no runtime, no Zod, type-only re-exports.
 *
 * Spec: `docs/superpowers/specs/2026-04-25-codegraph-symbols-vertical-slice.md`
 */

// `common.ts` does not yet exist in this codebase. The two path/symbol
// aliases are introduced here as nominal string aliases (no runtime impact)
// and may be moved to `common.ts` in a later cleanup once another contract
// file needs them.

/** Repository-relative path of a source file, POSIX-style separators. */
export type RelPath = string;

/** Stable identifier for a symbol (function, method, class). Composed by the
 *  chunker; stable across rechunking of the same source. */
export type SymbolId = string;

/**
 * A const dispatch table defined in one file (bd tea-rags-mcp-n0zj).
 * `entries` preserves the source key→value mapping so a static
 * string-literal key (`TABLE["ts"]`) resolves to the ONE matching entry
 * while a dynamic key (`TABLE[ext]`) fans out to ALL of them. The value
 * is either a function name (S2 direct-function map `{ k: fn }`) or a
 * `fieldName → fnName` map (S1 wrapper-object map `{ k: { field: fn } }`).
 * Only entries / fields whose value is a plain identifier are recorded —
 * inline arrows, spreads, and computed values carry no symbol to point at
 * and are dropped (m46z safety rule).
 */
export interface DispatchTable {
  entries: Record<string, string | Record<string, string>>;
}

/**
 * A `DispatchTable` paired with the repo-relative path of the file that
 * declared it. The run-global aggregate keys these by table NAME (a name
 * may be declared in more than one file), so the resolver disambiguates
 * by the caller's import map before binding — and drops rather than
 * guesses when the name is ambiguous across files with no import edge.
 */
export interface DispatchTableDef {
  relPath: RelPath;
  table: DispatchTable;
}

/**
 * A reference to a dispatch candidate set, emitted by the walker and
 * resolved by the resolver against the run-global tables.
 *   - `field: null`  ⇒ S2: the entry IS the function (call `TABLE[k](x)`).
 *   - `field: "fn"`  ⇒ S1: select that field of the entry object.
 *   - `key: null`    ⇒ dynamic key: fan out to ALL entries.
 *   - `key: "ts"`    ⇒ static string-literal key: the ONE matching entry.
 */
export interface DispatchRef {
  table: string;
  field: string | null;
  key: string | null;
}

/**
 * One fan-out edge produced by dispatch / callback-param resolution.
 * `sourceSymbolId: null` ⇒ the edge originates from the calling chunk
 * (the provider fills in the caller's symbolId). A non-null
 * `sourceSymbolId` OVERRIDES the source — used by the bounded
 * inter-procedural join where the edge originates from the CALLEE that
 * invokes the passed-in callback, not from the call site.
 */
export interface DispatchEdge {
  sourceSymbolId: SymbolId | null;
  targetRelPath: RelPath;
  targetSymbolId: SymbolId | null;
}

/**
 * A symbol descriptor produced by a language walker's `nameOf(node)`. Names a
 * single declaration (function, method, class, namespace) the walker found at
 * the current AST node, plus the flags that drive symbolId composition and
 * scope descent. Relocated to `contracts/` (from the codegraph provider) so the
 * per-language `LanguageWalker` interface in `types/language.ts` can reference
 * it without a domain→domain import.
 */
export interface NamedSymbol {
  name: string;
  descendsInto: boolean;
  /**
   * Distinguishes the universal class/method separator from the
   * language's namespace separator. `"instance"` uses `#`; `"static"`
   * uses `.`. Both override the language's `scopeSeparator` (which
   * applies to namespaces / nested classes / top-level chains).
   * Per `.claude/rules/symbolid-convention.md`.
   */
  methodKind?: "instance" | "static";
  /**
   * When `true`, `collectSymbols` synthesizes a `<name>#constructor`
   * symbol after walking this node's children IF the children did NOT
   * declare an explicit `constructor` member. Required for languages
   * where a class without an explicit `constructor() {}` body still has
   * an implicit constructor that `new Class()` and `super()` resolve to
   * (TS/JS — see bd `tea-rags-mcp-vw1u`). Without this synthetic, the
   * resolver walks `classExtends` to a parent, looks up
   * `Parent#constructor`, finds nothing, and `get_callers` returns [].
   */
  syntheticConstructorIfMissing?: boolean;
  /**
   * When `true`, `joinSymbol` emits `child.name` verbatim regardless of
   * the enclosing `composed` scope. Used by `nameOf` results whose name
   * is already fully resolved (e.g. `Object.defineProperty(this, …)`
   * inside `app.init = function () {}` — the `this`-resolution rewrites
   * the receiver to `app`, producing an absolute `app.router` that
   * should NOT be composed under the surrounding `app.init` scope).
   * bd tea-rags-mcp-d1f8 this-resolve.
   */
  absolute?: boolean;
}

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
   * Shape: `Record<string, string>` (NOT `Map`) so the structure
   * round-trips through the NDJSON spill (`JSON.stringify` / `JSON.parse`)
   * — `Map` would serialize to `{}` and silently lose data.
   */
  localBindings?: Record<string, string>;
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

/**
 * Language-agnostic symbol table populated by the chunker pass.
 *
 * Key shape: fully-qualified name with language-specific separators
 * preserved (TS: `"Foo.bar"`, `"Module.Foo"`; Ruby: `"Acme::Auth::User"`;
 * Python: `"package.module.Foo"`).
 */
export interface GlobalSymbolTable {
  upsertFile: (relPath: RelPath, definitions: SymbolDefinition[]) => void;
  removeFile: (relPath: RelPath) => void;
  /** Lookup by fully qualified name. Returns all matches across files —
   *  rare but possible for monkey-patched modules. */
  lookup: (fqName: string) => SymbolDefinition[];
  /** Lookup by short name; returns all candidates for scope-walk
   *  resolution. */
  lookupByShortName: (name: string) => SymbolDefinition[];
  size: () => number;
  /** Bulk-load symbol definitions, typically from disk-backed storage on
   *  cold start. Equivalent to calling `upsertFile` once per file —
   *  implementations may optimise the bulk path but are not required to. */
  hydrate: (definitions: SymbolDefinition[]) => void;
}

export interface SymbolDefinition {
  symbolId: SymbolId;
  fqName: string;
  shortName: string;
  relPath: RelPath;
  scope: string[];
}

/**
 * Language-specific call resolver. One implementation per language. Slice 1
 * ships `TSCallResolver`; slice 3 adds Ruby/Python/Elixir.
 */
export interface CallResolver {
  readonly language: string;
  resolve: (call: CallRef, ctx: CallContext) => SymbolResolutionTarget | null;
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
  resolveDispatch?: (call: CallRef, ctx: CallContext) => DispatchEdge[];
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
   * Per-chunk local variable bindings (`varName → typeName`) inferred by
   * the walker from assignments / type annotations within the enclosing
   * function or method body. Set by the provider per-call from the
   * caller chunk's `ChunkExtraction.localBindings`.
   *
   * Resolvers consult this BEFORE the receiver-matches-import path so a
   * locally-typed variable wins over ambiguous short-name resolution.
   */
  localBindings?: Record<string, string>;
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
}

export interface SymbolResolutionTarget {
  targetRelPath: RelPath;
  /** `null` when the resolver can determine the file but not the specific
   *  method (dynamic dispatch). */
  targetSymbolId: SymbolId | null;
}

/**
 * Driver-agnostic graph DB client.
 *
 * Slice 1 ships `DuckDbGraphClient`; slice 4 ships `PostgresGraphClient`.
 * The interface is the contract — driver-specific concerns (transaction
 * style, prepared statement caching) are implementation details.
 */
export interface GraphDbClient {
  init: () => Promise<void>;
  close: () => Promise<void>;

  /** Atomic upsert of file row + all outgoing edges. Used by the streaming
   *  write path. */
  upsertFile: (node: GraphFileNode, edges: GraphEdges) => Promise<void>;

  /** Used by incremental reindex when a file is removed from disk. */
  removeFile: (relPath: RelPath) => Promise<void>;

  /** Reads for metric computation (Tier 1) and MCP tools. */
  getFanIn: (relPath: RelPath) => Promise<number>;
  getFanOut: (relPath: RelPath) => Promise<number>;

  /**
   * Collection-wide p95 of per-file fanIn over the FULL file universe
   * (every row in `cg_symbols_files`, including files with zero incoming
   * edges). Used at index time to finalise `codegraph.file.isHub`
   * (`fanIn > p95`). Computed against the whole graph — not the
   * incremental-reindex subset — so hub classification stays correct when
   * only a few files changed. Returns 0 on an empty/single-file graph so
   * the `fanIn > p95` comparison degenerates sanely.
   */
  getFanInP95: () => Promise<number>;
  getCallers: (symbolId: SymbolId) => Promise<CallerEdge[]>;
  getCallees: (symbolId: SymbolId) => Promise<CalleeEdge[]>;
  getCalledByCount: (symbolId: SymbolId) => Promise<number>;
  getCallSiteCount: (symbolId: SymbolId) => Promise<number>;

  /** Returns true if at least one row exists in `cg_symbols_files`. Used
   *  by drift detection. */
  hasData: () => Promise<boolean>;

  // ── Symbol-table persistence (Slice 2 / A4c) ──
  // The in-memory GlobalSymbolTable needs a disk-backed copy so cold
  // starts and partial reindexes can hydrate without re-walking every
  // file in the repo. Persistence is keyed by `(relPath, symbolId)`
  // exactly like the in-memory map.

  /** Atomic replacement of all symbols for a file (DELETE+INSERT inside
   *  a transaction). Idempotent: empty `definitions` clears the file. */
  upsertSymbols: (relPath: RelPath, definitions: SymbolDefinition[]) => Promise<void>;

  /** Drop all persisted symbols for a file. Called by `handleDeletedPaths`. */
  removeSymbolsForFile: (relPath: RelPath) => Promise<void>;

  /** Bulk read for bootstrap hydration. Returns every persisted symbol
   *  definition; consumer is expected to feed them through
   *  `GlobalSymbolTable.hydrate`. */
  listAllSymbols: () => Promise<SymbolDefinition[]>;

  // ── Tier 2 graph metrics (Slice 2 / B1) ──

  /**
   * Count of distinct files that transitively depend on `relPath` via
   * import edges (reverse BFS). Bounded by `maxDepth` to keep cost
   * predictable on large repos — depth 1 = direct fanIn, depth 5
   * (default) captures most realistic blast radii.
   */
  getTransitiveImpact: (relPath: RelPath, maxDepth?: number) => Promise<number>;

  // ── Cycle detection (Slice 2 / B2) ──

  /**
   * Read the persisted cycles table. Each `CycleEntry` is one
   * strongly-connected component of length >= 2 (single-node "cycles"
   * are excluded — they're either harmless or surfaced by other
   * signals). Sub-millisecond read for the MCP `find_cycles` tool.
   *
   * When `pathPattern` (a picomatch glob) is given, a cycle is kept iff
   * AT LEAST ONE member resolves to a matching file path. Cross-boundary
   * cycles (one member inside the scope, one outside) are retained.
   */
  findCycles: (scope: CycleScope, pathPattern?: string) => Promise<CycleEntry[]>;

  /**
   * Read the adjacency (source -> target[]) for `scope` from the
   * appropriate edge table. Domain orchestrators (codegraph provider,
   * metrics service) consume this to run Tarjan / PageRank without
   * the adapter knowing about either algorithm — keeps the adapter
   * layer pure CRUD.
   *
   * Prefer `streamAdjacency` for new callers — it lets the consumer
   * build a compact id-keyed representation without the adapter
   * pre-bucketing into `Map<string, string[]>`.
   */
  listAdjacency: (scope: CycleScope) => Promise<Map<string, string[]>>;

  /**
   * Stream the adjacency for `scope` one `[source, target]` pair at a
   * time. Slice 2 hot-path replacement for `listAdjacency` — gives the
   * domain layer freedom to bucket into a compact id-keyed structure
   * (e.g. `Map<number, number[]>` with a separate id-table) instead of
   * paying the string-keyed `Map<string, string[]>` overhead twice.
   */
  streamAdjacency: (scope: CycleScope) => AsyncIterableIterator<[string, string]>;

  /**
   * Flush the WAL to the main database file. Slice 2 streaming
   * pass-2 issues this every N files so the WAL does not grow
   * unbounded during a long indexing pass. Idempotent — a no-op
   * checkpoint when the WAL is empty is cheap.
   */
  checkpoint: () => Promise<void>;

  /**
   * Atomically replace the cycles table for `scope` with the supplied
   * SCC list. Domain runs Tarjan; adapter persists the result.
   * Each inner array is one SCC's members in walk order; cycle_id is
   * assigned by the adapter using the array index. Single-node SCCs
   * are caller-filtered.
   */
  replaceCycles: (scope: CycleScope, sccs: readonly (readonly string[])[]) => Promise<void>;

  // ── Tier 3 graph metric (Slice 2 / B3) ──

  /**
   * Atomically replace the per-symbol PageRank table with the supplied
   * ranks. Domain runs the iterative algorithm; adapter persists.
   * Empty input wipes the table — useful after a force-reindex when
   * the method graph is fully rebuilt.
   */
  replacePageRanks: (ranks: ReadonlyMap<string, number>) => Promise<void>;

  /**
   * Look up the PageRank of a single symbol. Returns 0 when the symbol
   * is unknown or the metrics table hasn't been populated yet — both
   * cases are treated as "rank-irrelevant".
   */
  getPageRank: (symbolId: SymbolId) => Promise<number>;

  /**
   * Run Tarjan SCC over both scopes + PageRank over the method graph and
   * persist the results, all in one round-trip. Optional because only the
   * daemon-routed client (`DaemonGraphDbClient`) implements it — the
   * in-process `DuckDbGraphClient` leaves it undefined so the provider's
   * direct-mode path runs the analysis inline (one streamAdjacency pass per
   * scope). When present, the provider delegates the whole 30 GB graph build
   * to the single daemon process instead of every MCP client.
   */
  computeAndPersistCyclesAndSignals?: () => Promise<void>;
}

export type CycleScope = "file" | "method";

export interface CycleEntry {
  /** Numeric id assigned at recompute time; stable within a single recompute, NOT across recomputes. */
  cycleId: number;
  scope: CycleScope;
  /** Members in walk order (the order returned by Tarjan's pop sequence). */
  members: string[];
}

export interface GraphFileNode {
  relPath: RelPath;
  language: string;
}

export interface GraphEdges {
  fileEdges: { targetRelPath: RelPath; importText: string | null }[];
  methodEdges: {
    sourceSymbolId: SymbolId;
    targetSymbolId: SymbolId | null;
    targetRelPath: RelPath;
    callExpression: string;
  }[];
}

export interface CallerEdge {
  sourceSymbolId: SymbolId;
  sourceRelPath: RelPath;
  callExpression: string;
}

export interface CalleeEdge {
  targetSymbolId: SymbolId | null;
  targetRelPath: RelPath;
  callExpression: string;
}

/** Minimal chunk preview returned by graph MCP tools (`get_callers`,
 *  `get_callees`) alongside each edge so callers can display the source
 *  line of the call site without a follow-up `find_symbol` round-trip. */
export interface GraphChunkPreview {
  symbolId: SymbolId;
  relPath: RelPath;
  startLine: number;
  endLine: number;
  preview: string;
}

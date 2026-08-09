/**
 * Codegraph symbol vocabulary — the identity aliases every other codegraph
 * contract is phrased in (`RelPath`, `SymbolId`), the shape of one extracted
 * declaration (`SymbolDefinition` plus its positional / keyword arity
 * envelopes), the run-global table those definitions are looked up in, and the
 * per-AST-node descriptor (`NamedSymbol`) a walker's `nameOf` returns.
 *
 * The base layer of the codegraph contract set: it imports nothing. Re-exported
 * verbatim by the `codegraph.ts` barrel — see that file for the whole cut.
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
   *  resolution. SCHEMA COLUMNS ARE EXCLUDED unless `options` opts in — see
   *  {@link SymbolLookupOptions}. */
  lookupByShortName: (name: string, options?: SymbolLookupOptions) => SymbolDefinition[];
  /**
   * Replace the run's schema-column index with `definitions` (each carrying
   * `isSchemaColumn: true`). Optional capability: a table that omits it simply
   * never holds synthesized columns, and the pre-pass no-ops (bd
   * tea-rags-mcp-8l5fo).
   *
   * Held in a SEPARATE index from the real definitions, so `lookup`,
   * `size`, `shortNameDefCounts` and the default `lookupByShortName` are
   * byte-identical to a run with no schema — the whole anti-explosion
   * guarantee is structural, not a per-consumer filter.
   */
  setSchemaColumns?: (definitions: SymbolDefinition[]) => void;
  size: () => number;
  /** Bulk-load symbol definitions, typically from disk-backed storage on
   *  cold start. Equivalent to calling `upsertFile` once per file —
   *  implementations may optimise the bulk path but are not required to. */
  hydrate: (definitions: SymbolDefinition[]) => void;
  /** Definition count per shortName across the corpus — the distribution the
   *  DispatchFanoutPolicy p99 cap derives from (bd tea-rags-mcp-f2jsb). */
  shortNameDefCounts: () => ReadonlyMap<string, number>;
}

/**
 * Options for {@link GlobalSymbolTable.lookupByShortName} (bd tea-rags-mcp-8l5fo).
 *
 * The default (omitted / `false`) is the ONLY safe setting for a global
 * short-name fan-out or an ambiguity aggregate: a synthesized AR column
 * accessor such as `name` exists on every model that has the column, so
 * admitting them into a global candidate set multiplies it by hundreds. Opt in
 * ONLY from a lookup already narrowed to a receiver type / MRO class.
 */
export interface SymbolLookupOptions {
  /** Include schema-synthesized column accessors (`isSchemaColumn`). Default false. */
  includeSchemaColumns?: boolean;
}

/** Positional-arity envelope of a method definition (bd xlnub). `maxPositional`
 *  is required+optional positional params; `hasSplat` (a `*args` rest param)
 *  makes the upper bound unbounded. Kwargs / block params do NOT affect it. */
export interface AritySignature {
  minRequired: number;
  maxPositional: number;
  hasSplat: boolean;
}

/** Keyword-arg envelope of a method definition (bd d9o7o). `required` = kwarg
 *  names with NO default (must be supplied at the call site); `hasSplat` = a
 *  `**opts` rest param (accepts arbitrary keys). Positional arity lives in
 *  AritySignature — this is the keyword axis, kept separate. */
export interface KwargSignature {
  required: string[];
  /** Declared OPTIONAL (defaulted) kwarg names (bd d9o7o extra-unknown). Full
   *  declared set = `required ∪ optional`. Optional field: when undefined the
   *  full declared set is unknown and the extra-unknown-key narrowing is
   *  skipped (conservative keep). The walker always populates it (possibly
   *  `[]`) going forward. */
  optional?: string[];
  hasSplat: boolean;
}

export interface SymbolDefinition {
  symbolId: SymbolId;
  fqName: string;
  shortName: string;
  relPath: RelPath;
  scope: string[];
  arity?: AritySignature;
  visibility?: "public" | "private" | "protected";
  /** Keyword-arg signature of this method definition (bd d9o7o). Undefined for
   *  non-method chunks / methods with no kwargs. */
  kwargs?: KwargSignature;
  /** Method yields or takes an `&block` param (statically visible). `false` =
   *  PROVEN non-yielder; `undefined` = not captured / non-method (bd d9o7o). */
  acceptsBlock?: boolean;
  /**
   * This definition is an ABSTRACT STUB — see {@link ChunkExtraction.isAbstractStub}
   * for the (deliberately narrow) shapes that qualify. Threaded from the chunk
   * extraction by the codegraph provider so the self-dispatch probe can answer
   * "concretely defines" rather than merely "a body exists" (bd tea-rags-mcp-bcdfe).
   *
   * Only ever `true`; absent means not-a-stub. PERSISTED in `cg_symbols`
   * (`is_abstract_stub`, migration 016, bd tea-rags-mcp-eikry), so a def
   * hydrated from disk — an unchanged file on an incremental run — carries the
   * same verdict as a freshly walked one. A row written before that migration
   * has the column NULL and hydrates as non-stub, the pre-flag behaviour
   * (under-coverage, never a wrong target), until its file is next walked.
   */
  isAbstractStub?: boolean;
  /**
   * This definition was SYNTHESIZED by the project-scope schema pre-pass from a
   * persisted schema snapshot (`db/schema.rb`) rather than extracted from a
   * `def` — an ActiveRecord column accessor (`name` / `name=` / `name?`) that
   * exists at runtime and nowhere in source (bd tea-rags-mcp-8l5fo).
   *
   * Only ever `true`; absent means a real definition. Load-bearing: the symbol
   * table keeps these in a SEPARATE index so they reach ONLY the typed-receiver
   * and MRO lookups that opt in via {@link SymbolLookupOptions}, and never a
   * global short-name fan-out or an ambiguity aggregate.
   *
   * NOT persisted in `cg_symbols` — the pre-pass rebuilds the index at every
   * run's pass-1→pass-2 barrier, same lifecycle as `hierarchyView`.
   */
  isSchemaColumn?: boolean;
}

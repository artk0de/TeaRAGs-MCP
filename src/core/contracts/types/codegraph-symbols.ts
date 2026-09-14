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
 * A symbol pinned to the file that declares it (bd tea-rags-mcp-oxnvl).
 *
 * A `SymbolId` is unique per FILE, not per repository: top-level declarations
 * (React function components, a `BaseTable` living in three directories) get a
 * bare, unqualified id, so joining the call graph on `symbolId` alone merges
 * every namesake into one node. Graph traversal whose node identity has to
 * survive that — `trace_path` — is phrased in this pair instead.
 */
export interface FileScopedSymbolRef {
  relPath: RelPath;
  symbolId: SymbolId;
}

/**
 * Composite map key for a {@link FileScopedSymbolRef}: `${relPath}|${symbolId}`.
 * Opaque — build it with {@link fileScopedSymbolKey}, read it back with
 * {@link parseFileScopedSymbolKey}, and never hand-assemble or split the string
 * elsewhere (same reason `.claude/rules/symbolid-convention.md` bans hardcoding
 * the `#` / `.` separator outside its canonical helpers).
 */
export type FileScopedSymbolId = string;

/**
 * Separator between the two halves of a {@link FileScopedSymbolId}.
 *
 * `|`, and not `::`, because Ruby symbolIds contain `::` natively
 * (`Acme::Auth::User#save`) — `::` cannot delimit anything.
 */
const FILE_SCOPED_SYMBOL_SEPARATOR = "|";

/**
 * Compose the composite traversal key for a file-scoped symbol.
 *
 * relPath goes FIRST, and that ordering is load-bearing rather than
 * cosmetic — see {@link parseFileScopedSymbolKey} for why the decode side
 * depends on it.
 */
export function fileScopedSymbolKey(ref: FileScopedSymbolRef): FileScopedSymbolId {
  return `${ref.relPath}${FILE_SCOPED_SYMBOL_SEPARATOR}${ref.symbolId}`;
}

/**
 * Split a {@link FileScopedSymbolId} back into its parts.
 *
 * Splits on the FIRST separator, never the last, and that is a correctness
 * invariant: the symbolId half CAN legally contain `|`. Ruby operator methods
 * are ordinary method definitions, so `def |(other)` inside `class Matrix`
 * yields the symbolId `Matrix#|` — split-on-last would hand back `Matrix#` and
 * an empty file. The relPath half is what must stay `|`-free, which is why it
 * is encoded first; a repo-relative path containing a pipe is the one residual
 * shape this key cannot represent, and that risk is accepted (no filesystem in
 * use here produces one).
 *
 * A key with no separator at all (never produced by
 * {@link fileScopedSymbolKey}) reads as a bare symbolId with an unknown file
 * rather than throwing — path rendering degrades to an empty string, traversal
 * identity stays intact.
 */
export function parseFileScopedSymbolKey(key: FileScopedSymbolId): FileScopedSymbolRef {
  const cut = key.indexOf(FILE_SCOPED_SYMBOL_SEPARATOR);
  if (cut < 0) return { relPath: "", symbolId: key };
  return { relPath: key.slice(0, cut), symbolId: key.slice(cut + 1) };
}

/**
 * A symbol descriptor produced by a language walker's `nameOf(node)`. Names a
 * single declaration (function, method, class, namespace) the walker found at
 * the current AST node, plus the flags that drive symbolId composition.
 * Relocated to `contracts/` (from the codegraph provider) so the per-language
 * `LanguageWalker` interface in `types/language.ts` can reference it without a
 * domain→domain import.
 */
export interface NamedSymbol {
  name: string;
  /**
   * Whether the declaration is a scope CONTAINER (class, module, namespace,
   * const-object namespace) rather than a leaf (function, method).
   *
   * DESCRIPTIVE ONLY — no collector reads it (bd tea-rags-mcp-czoif). It used
   * to gate descent: `collectSymbols` recursed with an EXTENDED scope when the
   * flag was set and with the SAME scope otherwise, so a function's interior
   * composed nothing under it. `e8d96a55b` replaced that with unconditional
   * descent — every named node extends `scope` / `composed` for its children,
   * whatever the flag says — because two same-named helpers nested in different
   * outer functions need distinct fully-qualified ids. That is also what lets
   * `useThing.doIt` compose off a `descendsInto: false` declarator
   * (bd tea-rags-mcp-29m75).
   *
   * So a walker author picking a value is describing the declaration, not
   * steering the walk: both values produce the same symbol set today. Keep it
   * honest anyway — the container/leaf distinction is the one fact a future
   * consumer would need, and a walker that lies about it would be the harder
   * bug to find.
   */
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
   * Is this exact file part of the project the table describes?
   *
   * The question the import mappers could not ask (bd tea-rags-mcp-q9u85):
   * `mapPythonImportToFile` and `mapJavaImportToFile` SYNTHESISE a target path
   * from the import text without probing disk, so `re.py` and
   * `java/util/Objects.java` are perfectly ordinary answers. Without this the
   * only way to tell a real first-party target from a synthesised external one
   * was to hit the filesystem, which the resolver must not do.
   *
   * Membership, NOT symbol count (bd tea-rags-mcp-o7ifx). A file the table was
   * told about answers `true` even when it declared nothing: an empty
   * `__init__.py` is what makes `pkg` a package, and reading it as "absent" put
   * every import of that package outside the project. `size()` still counts
   * definitions, so a symbol-free file moves no aggregate.
   */
  hasFile: (relPath: RelPath) => boolean;
  /**
   * Does any file UNDER this directory belong to the project? `""` asks about
   * the whole table. A trailing slash is ignored; a path PREFIX is not a parent
   * (`pkg/a` is not under `pkg/ab`).
   *
   * Needed because a Python package import resolves to a DIRECTORY as often as
   * to a file — PEP 420 namespace packages have no `__init__.py` at all — so
   * `hasFile` alone cannot tell "this package is ours" from "this package is a
   * dependency". O(1), maintained as an index, never a scan.
   */
  hasFilesUnder: (dirRelPath: string) => boolean;
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
  /**
   * Register project files that persisted NO symbol, typically the `rel_path`
   * column of the graph's file table on cold start (bd tea-rags-mcp-o7ifx).
   *
   * `hydrate` can only see files that own a row in the symbol store, so an
   * incremental run rebuilds the definitions of every unchanged file and none
   * of its empty package markers. A path already present keeps its definitions.
   *
   * Optional capability: a table that omits it answers `hasFile` false for
   * symbol-free files on a cold pass, which is the pre-o7ifx behaviour.
   */
  hydrateFiles?: (relPaths: readonly RelPath[]) => void;
  /**
   * Every file path the table holds, in no guaranteed order (bd
   * tea-rags-mcp-60nss).
   *
   * `hasFile` and `hasFilesUnder` answer about a path the caller already has;
   * this is the only way to ask what the SHAPE of the project is. Python's
   * import mapper needs it to find the source roots — `src/flask/__init__.py`
   * says `src` is a root, and no ancestor of `examples/app.py` ever will.
   *
   * Optional capability: a table that omits it makes root inference fall back
   * to the importing file's ancestors, which is the pre-60nss behaviour.
   * Consumers must treat it as a per-generation scan and memoise accordingly —
   * it is O(files), never O(1).
   */
  listFiles?: () => Iterable<RelPath>;
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
   * The walker's 1-based, inclusive line range of this definition's AST node
   * (bd tea-rags-mcp-9i2ow). Both-or-neither. PERSISTED in `cg_symbols`
   * (`start_line` / `end_line`, migration 024) so the payload healer — which
   * runs outside any walk — maps a stored chunk to the symbol that owns it by
   * the same rule the deferred chunk pass uses. Absent on a row written before
   * that migration and on a walker that tracks no lines; the owner rule then
   * keeps the chunk's own payload symbolId.
   */
  startLine?: number;
  endLine?: number;
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

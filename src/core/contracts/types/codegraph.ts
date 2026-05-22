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
  classFieldTypes?: ReadonlyMap<string, ReadonlyMap<string, string>>;
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
   */
  classAncestors?: ReadonlyMap<string, readonly string[]>;
}

export interface ImportRef {
  /** Raw import path as written, e.g. `"./utils"`, `"@/lib/foo"`, `"react"`. */
  importText: string;
  /** Lexical position used by resolvers that need it (TS aliases, Python
   *  relative imports). 1-based line number. */
  startLine: number;
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
  resolve: (call: CallRef, ctx: CallContext) => ResolvedTarget | null;
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
  classFieldTypes?: ReadonlyMap<string, ReadonlyMap<string, string>>;
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
   * Optional `className → ancestor[]` map propagated from
   * `FileExtraction.classAncestors`. Resolvers walk this list when a
   * receiver-typed method lookup misses on the bound class so inherited
   * methods (`User.find(id).save` where `save` lives on
   * `ApplicationRecord`) still produce edges. First entry = direct
   * superclass; subsequent entries = mixins in declaration order.
   */
  classAncestors?: ReadonlyMap<string, readonly string[]>;
}

export interface ResolvedTarget {
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
   */
  findCycles: (scope: CycleScope) => Promise<CycleEntry[]>;

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

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

export interface CallContext {
  callerFile: RelPath;
  callerScope: string[];
  /** May be empty for autoload-based languages (Ruby/Rails). */
  imports: ImportRef[];
  symbolTable: GlobalSymbolTable;
  /** Optional language-specific config (tsconfig paths, Zeitwerk root, etc.). */
  languageConfig?: unknown;
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
   * Recompute Tarjan SCC from current edges for `scope` and rewrite
   * the cycles table for that scope. Atomic: DELETE+INSERT in a
   * transaction. Called by the codegraph provider at sink.finish() so
   * cycles stay in sync with the graph after every full enrichment
   * cycle; can also be invoked manually after a force_reindex.
   */
  recomputeCycles: (scope: CycleScope) => Promise<void>;

  // ── Tier 3 graph metric (Slice 2 / B3) ──

  /**
   * Recompute PageRank over the method call graph and rewrite
   * `cg_symbols_metrics`. Iterative algorithm (damping 0.85, ε 1e-6,
   * up to 50 iters). Called by the codegraph provider at sink.finish()
   * so ranks stay in sync after every full enrichment cycle.
   */
  recomputePageRank: () => Promise<void>;

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

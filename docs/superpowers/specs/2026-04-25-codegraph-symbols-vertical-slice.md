# Codegraph Symbols Sub-Trajectory — Vertical Slice 1 Design

**Status:** Approved (brainstorming complete, 2026-04-25) **Epic:**
`tea-rags-mcp-l26` **Supersedes:**
`docs/plans/2026-02-24-code-graph-enrichment-design.md` (treated as old draft;
this spec restates decisions for the current architecture)

## Motivation

The `tea-rags-mcp` reranker today scores chunks by content similarity,
structural features, and git signals. It has no visibility into the **dependency
structure** of the codebase: which file imports which, which method calls which.
As a result it cannot answer questions like "what blast radius does changing
`Foo` produce", "which files are hubs", "where are the entry points". The
`imports[]` payload field that exists today is a regex artifact,
language-incomplete, and not namespaced.

The codegraph epic introduces a dedicated trajectory that owns the dependency
graph, exposes graph-derived signals to the reranker, and offers MCP tools for
direct graph traversal. Because the work is large (multiple languages, multiple
sub-graphs, multiple metric tiers), it is split into vertical slices. **Slice 1
validates the full architecture end-to-end with the smallest non-trivial scope:
TypeScript only, the symbols sub-graph only, Tier 1 metrics only.** Subsequent
slices add languages, metric tiers, MCP tools, additional sub-graphs, and
self-hosted server storage.

## Goal

Ship a vertical slice that:

1. Extracts file imports and method calls from TypeScript chunker output without
   double-parsing.
2. Resolves the extracted references using a language-agnostic `CallResolver`
   contract and a `GlobalSymbolTable`.
3. Persists nodes and edges in DuckDB through a driver-agnostic `GraphDbClient`
   interface.
4. Computes Tier 1 graph metrics (file-level: `fanIn`, `fanOut`, `instability`,
   `isHub`, `isLeaf`; method-level: `calledByCount`, `callSiteCount`).
5. Exposes those metrics as payload signals to the reranker (consumable through
   the existing `semantic_search`, `hybrid_search`, `rank_chunks` tools via
   custom rerank weights).
6. Adds two MCP tools: `get_callers(symbolId)`, `get_callees(symbolId)`.
7. Operates as a fire-and-forget enrichment provider (search remains available
   while graph builds).
8. Supports incremental delta-based reindex (graph DB is the source of truth, no
   full rebuild on every change).
9. Lays in extension points for Slice 2-5 without committing implementation cost
   to them.

## Non-goals

- **PostgreSQL adapter.** Deferred to Slice 4. Slice 1 ships DuckDB-only behind
  a driver-agnostic `GraphDbClient` interface so Slice 4 plugs in without
  refactor.
- **Languages other than TypeScript.** Python, Ruby, Elixir, regex-fallback
  hooks belong to Slice 3.
- **Tier 2-3 metrics.** `transitiveImpact`, `pageRank`, `betweenness`, cycle
  detection belong to Slice 2.
- **MCP tools beyond `get_callers` / `get_callees`.** `get_dependencies`,
  `get_dependents`, `find_cycles` belong to Slice 2.
- **Temporal coupling and other sub-graphs.** `cg_temporal_*`, `cg_<other>_*`
  belong to Slice 5+.
- **Auto background backfill.** Activation on an existing index produces a drift
  prompt to run `index_codebase --forceReindex=true`. Background backfill is a
  Slice 2 candidate.
- **Replacing `imports[]` payload field today.** That cleanup is a separate
  ticket on the epic; codegraph writes its own namespaced fields and leaves the
  legacy field untouched.
- **Cross-language graph edges.** Slice 1 graph is per-language scoped (TS files
  reference TS files). Cross-language imports (TS → JSON, TS → schema) are out
  of scope.

## Architecture overview

```
┌─────────────────────────────────────────────────────────────────────────┐
│                         file processing loop                            │
│  (domains/ingest/pipeline/file-processor.ts)                            │
└──────────────┬──────────────────────────────────────────────────────────┘
               │
               ▼
        chunker (per language hooks)
        ├── builds chunks + symbolId + chunkType + navigation (existing)
        └── builds FileExtraction { imports[], chunks: [{ symbolId, calls[] }] }    NEW
                                                  │
                                                  ▼
                                       ExtractionSink (in-memory)
                                                  │
                                                  ▼
                            CodegraphEnrichmentProvider (fire-and-forget)
                            ├── GlobalSymbolTable.upsert(file)
                            ├── CallResolver.resolve(call, ctx)
                            └── GraphDbClient.write(nodes, edges)
                                                  │
                                                  ▼
                                      DuckDB cg_symbols_* tables
                                                  │
                  ┌───────────────────────────────┴──────────────────────┐
                  ▼                                                      ▼
           graph metrics                                       MCP graph tools
           (file/chunk Tier 1)                                 (get_callers,
           ├── written into Qdrant payload                      get_callees)
           └── consumed by reranker as signals
```

### Key concepts

- **Sub-graph naming convention:** all graph DB tables follow `cg_<subtype>_*`.
  Slice 1 owns `cg_symbols_*`. Slice 5 introduces `cg_temporal_*`.
- **L1 / L2 trajectory grouping:** each sub-graph (`symbols`, `temporal`, …) is
  its own L2 `Trajectory` with one `EnrichmentProvider`, registered directly in
  `TrajectoryRegistry`. The "L1" codegraph family exists only as a
  composition-time factory (`createCodegraphTrajectories`) that returns the L2
  array; `TrajectoryRegistry` never sees an L1 entry. This keeps the shared
  `Trajectory` contract unchanged while still letting one flag
  (`CODEGRAPH_DISABLED`) toggle the entire family on or off.
- **`FileExtraction`** — language-agnostic structure emitted by chunker hooks
  describing imports and method calls discovered while parsing.
- **`ExtractionSink`** — DI-injected sink that the chunker writes to. The
  codegraph enrichment provider implements it.
- **`GlobalSymbolTable`** — language-agnostic in-memory map from fully qualified
  symbol name to `{ symbolId, relPath, scope }`. Built by the chunker pass,
  consumed by `CallResolver`. Critical for autoload-based languages (Slice 3).
- **`CallResolver`** — language-specific resolver that translates a call
  expression plus caller context into a `ResolvedTarget`. Slice 1 ships
  `TSCallResolver`. Slice 3 adds `RubyCallResolver`, `PythonCallResolver`,
  `ElixirCallResolver`.
- **`GraphDbClient`** — driver-agnostic interface for graph DB read/write. Slice
  1 ships `DuckDbGraphClient`. Slice 4 ships `PostgresGraphClient`.
- **Edges by symbolId, not chunk_id.** Method-level edges reference
  `source_symbol_id` and `target_symbol_id`. SymbolId is stable across
  rechunking and integrates with the existing MCP navigation layer.

## Schema (DuckDB DDL)

Three tables. All names prefixed with `cg_symbols_` per the convention.

```sql
CREATE TABLE cg_symbols_files (
  rel_path  VARCHAR PRIMARY KEY,
  language  VARCHAR NOT NULL
);

CREATE TABLE cg_symbols_edges_file (
  source_rel_path  VARCHAR NOT NULL REFERENCES cg_symbols_files(rel_path) ON DELETE CASCADE,
  target_rel_path  VARCHAR NOT NULL REFERENCES cg_symbols_files(rel_path) ON DELETE CASCADE,
  import_text      VARCHAR,
  PRIMARY KEY (source_rel_path, target_rel_path)
);

CREATE INDEX idx_cg_symbols_edges_file_target
  ON cg_symbols_edges_file (target_rel_path);

CREATE TABLE cg_symbols_edges_method (
  source_symbol_id VARCHAR NOT NULL,
  source_rel_path  VARCHAR NOT NULL REFERENCES cg_symbols_files(rel_path) ON DELETE CASCADE,
  target_symbol_id VARCHAR,
  target_rel_path  VARCHAR NOT NULL REFERENCES cg_symbols_files(rel_path) ON DELETE CASCADE,
  call_expression  VARCHAR NOT NULL,
  PRIMARY KEY (source_symbol_id, call_expression, target_symbol_id)
);

CREATE INDEX idx_cg_symbols_edges_method_target_symbol
  ON cg_symbols_edges_method (target_symbol_id);

CREATE INDEX idx_cg_symbols_edges_method_target_rel_path
  ON cg_symbols_edges_method (target_rel_path);
```

Notes:

- `target_symbol_id` is nullable: when the resolver narrows a call to a file but
  not to a specific method (e.g. dynamic dispatch), the edge is recorded
  file-level only.
- `ON DELETE CASCADE` on `source_rel_path` and `target_rel_path` makes
  incremental reindex correct: deleting a file row removes all incoming and
  outgoing edges automatically.
- No `cg_symbols_chunks` table. Method-level information lives in Qdrant payload
  (single source of truth for chunk metadata).

## Contracts

All contracts live in `core/contracts/types/` per the project's foundation
layering rules.

### `core/contracts/types/codegraph.ts` (new file)

```typescript
import type { ChunkId, RelPath, SymbolId } from "./common.js";

/**
 * Per-file extraction emitted by chunker hooks for graph construction.
 * The chunker calls ExtractionSink.write(extraction) once per file after
 * chunking completes for that file.
 */
export interface FileExtraction {
  relPath: RelPath;
  language: string;
  imports: ImportRef[];
  chunks: ChunkExtraction[];
  /** Lexical scope chain at file top level — usually [] for TS, may be ["module Acme"] for Ruby. */
  fileScope: string[];
}

export interface ImportRef {
  /** Raw import path as written, e.g. "./utils", "@/lib/foo", "react". */
  importText: string;
  /** Lexical position used by resolvers that need it (TS aliases, Python relative imports). */
  startLine: number;
}

export interface ChunkExtraction {
  symbolId: SymbolId;
  /** Lexical scope chain enclosing this chunk, e.g. ["Acme", "Auth", "User"] for Ruby. */
  scope: string[];
  calls: CallRef[];
}

export interface CallRef {
  /** Source text of the call expression, e.g. "Foo.bar()" or "User.find". */
  callText: string;
  /** Receiver part for member calls, "Foo" in "Foo.bar()". null for free calls like "bar()". */
  receiver: string | null;
  /** Member part for member calls, "bar" in "Foo.bar()". The free-call name otherwise. */
  member: string;
  startLine: number;
}

/**
 * Sink the chunker writes to. Codegraph enrichment provider implements it.
 * Call order: write(extraction) once per file → finish() once per ingest batch.
 */
export interface ExtractionSink {
  write(extraction: FileExtraction): Promise<void>;
  finish(): Promise<void>;
}

/**
 * Language-agnostic symbol table populated by the chunker pass.
 * Key shape: fully-qualified name with language-specific separators preserved
 * (TS: "Foo.bar", "Module.Foo"; Ruby: "Acme::Auth::User"; Python: "package.module.Foo").
 */
export interface GlobalSymbolTable {
  upsertFile(relPath: RelPath, definitions: SymbolDefinition[]): void;
  removeFile(relPath: RelPath): void;
  /** Lookup by fully qualified name. Returns all matches across files (rare but possible for monkey-patched modules). */
  lookup(fqName: string): SymbolDefinition[];
  /** Lookup by short name; returns all candidates for scope-walk resolution. */
  lookupByShortName(name: string): SymbolDefinition[];
  size(): number;
}

export interface SymbolDefinition {
  symbolId: SymbolId;
  fqName: string;
  shortName: string;
  relPath: RelPath;
  scope: string[];
}

/**
 * Language-specific call resolver. One implementation per language.
 * Slice 1 ships TSCallResolver; Slice 3 adds Ruby/Python/Elixir.
 */
export interface CallResolver {
  readonly language: string;
  resolve(call: CallRef, ctx: CallContext): ResolvedTarget | null;
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
  /** Null when the resolver can determine the file but not the specific method. */
  targetSymbolId: SymbolId | null;
}

/**
 * Driver-agnostic graph DB client.
 * Slice 1: DuckDbGraphClient.
 * Slice 4: PostgresGraphClient.
 */
export interface GraphDbClient {
  init(): Promise<void>;
  close(): Promise<void>;

  /** Atomic upsert of file row + all outgoing edges. Used by streaming write path. */
  upsertFile(node: GraphFileNode, edges: GraphEdges): Promise<void>;

  /** Used by incremental reindex when a file is removed from disk. */
  removeFile(relPath: RelPath): Promise<void>;

  /** Reads for metric computation (Tier 1) and MCP tools. */
  getFanIn(relPath: RelPath): Promise<number>;
  getFanOut(relPath: RelPath): Promise<number>;
  getCallers(symbolId: SymbolId): Promise<CallerEdge[]>;
  getCallees(symbolId: SymbolId): Promise<CalleeEdge[]>;
  getCalledByCount(symbolId: SymbolId): Promise<number>;
  getCallSiteCount(symbolId: SymbolId): Promise<number>;

  /** Returns true if at least one row exists in cg_symbols_files. Used by drift detection. */
  hasData(): Promise<boolean>;
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
```

### Codegraph trajectory family — L1 factory, L2 registration

**The `Trajectory` interface does not change.** Existing
`enrichment?: EnrichmentProvider` semantics are preserved. Each L2 sub-graph
trajectory (Symbols, Temporal, …) is a regular `Trajectory` with its own single
enrichment provider and is registered directly in `TrajectoryRegistry`.

The codegraph "L1" is purely a **composition-time grouping**: a factory that
returns the array of L2 trajectories belonging to the codegraph family. It
exists for one reason — to enable/disable the whole family with one flag without
leaking a `family` marker into the shared contract.

```typescript
// core/domains/trajectory/codegraph/index.ts (new)
export interface CodegraphDeps {
  graphDb: GraphDbClient;
  symbolTable: GlobalSymbolTable;
  resolvers: Map<string, CallResolver>;
  // …other shared deps for codegraph L2 trajectories
}

/**
 * L1 codegraph family factory.
 * Returns the list of L2 trajectories that belong to the codegraph family.
 * Slice 1: SymbolsTrajectory only.
 * Slice 5+: append additional L2 trajectories (TemporalTrajectory, …).
 */
export function createCodegraphTrajectories(deps: CodegraphDeps): Trajectory[] {
  return [
    createSymbolsTrajectory(deps),
    // Slice 5: createTemporalTrajectory(deps),
  ];
}
```

`createComposition()` calls the factory once when codegraph is enabled and
registers each returned L2 trajectory directly:

```typescript
// core/api/internal/composition.ts (modified)
if (!config.codegraphDisabled) {
  for (const trajectory of createCodegraphTrajectories(codegraphDeps)) {
    registry.register(trajectory);
  }
}
```

`TrajectoryRegistry` only ever sees L2 trajectories. There is no L1 registry
entry to special-case downstream. `EnrichmentCoordinator` receives one provider
per L2 (the `enrichment` field of each registered trajectory) — no change.

This pattern mirrors the existing composition style (`composition.ts` is already
a factory) and adds zero abstraction surface for Slices 2-5.

**`GitTrajectory` and `StaticTrajectory` are not modified.** Wrapping in arrays
was the wrong fix; they remain `Trajectory` instances with their existing single
`enrichment` field.

## Data flow

### Ingest path

1. **`processFiles`** (existing) iterates files, runs chunker pool per file.
2. **Chunker hooks** (extended) populate `FileExtraction` from the AST while
   chunking. TS hook reads `import_statement` nodes for imports and
   `call_expression` nodes per chunk for calls.
3. **Chunker** writes `FileExtraction` to the injected `ExtractionSink` after
   the file's chunks are emitted.
4. **`CodegraphEnrichmentProvider.startFileExtraction(...)`** receives the
   extraction: a. Derives symbol definitions from chunk metadata + scope and
   feeds `GlobalSymbolTable.upsertFile(...)`. b. Buffers the extraction until
   `finish()` is called (resolution needs the full symbol table; resolving on
   the fly produces incomplete edges for forward references).
5. **`CodegraphEnrichmentProvider.finish()`** runs after all files of the batch
   have been chunked: a. For each buffered extraction, resolve each `ImportRef`
   and `CallRef` using the appropriate `CallResolver` (selected by language). b.
   Write the file node + resolved edges to `GraphDbClient.upsertFile(...)`.
6. **`buildFileSignals`** / **`buildChunkSignals`** read from `GraphDbClient` to
   produce `FileSignalOverlay` / `ChunkSignalOverlay` for the standard
   enrichment pipeline. The overlays attach `codegraph.file.*` and
   `codegraph.chunk.*` fields to the Qdrant payload.

### Streaming and memory

- The buffer of `FileExtraction` objects in step 4 is bounded: at 15M LOC (~150k
  files), each extraction averages ~5 imports + ~30 calls, ~2KB of JSON. Total
  buffer ~300MB. Acceptable peak.
- For larger codebases the provider can flush in chunks (resolve and write a
  batch of files once the symbol table has stabilized for those files'
  dependencies). Slice 1 ships the simple "buffer until finish" implementation;
  the chunked-flush variant is a Slice 2 optimization.

### Incremental reindex

When a file changes:

1. The reindex loop calls `GraphDbClient.removeFile(relPath)` before
   re-processing. `ON DELETE CASCADE` cleans up incoming and outgoing edges.
2. The chunker re-emits a new `FileExtraction`.
3. `CodegraphEnrichmentProvider` re-resolves and re-inserts via `upsertFile`.

The graph DB is the source of truth. Full rebuilds are not part of the normal
flow.

### Read path (MCP tools)

`get_callers(symbolId)` and `get_callees(symbolId)` are thin wrappers around
`GraphDbClient.getCallers` / `getCallees` plus a `find_symbol` lookup for each
returned symbolId to attach the chunk for client display.

```
MCP get_callers
  → GraphFacade.getCallers(symbolId)
    → GraphDbClient.getCallers(symbolId)               // SQL query
    → for each CallerEdge:
        ExploreFacade.findSymbolByIds([sourceSymbolId]) // existing tool
        attach chunk preview
  → MCP response
```

## Slice 1 implementation

### TS chunker hook extension

`pipeline/chunker/hooks/typescript/` gains an extraction hook that accumulates
imports and calls during the existing AST walk:

```typescript
// pipeline/chunker/hooks/typescript/extraction-hook.ts (new)
export class TypeScriptExtractionHook implements ChunkingHook {
  process(ctx: HookContext): void {
    // Walks tree-sitter nodes:
    //   - import_statement / import_clause → ImportRef[]
    //   - call_expression scoped to current chunk → CallRef[]
    // Stores results on ctx.extraction (a FileExtraction in progress).
  }
}
```

The chunker's `processFile` writes `ctx.extraction` to the injected
`ExtractionSink` after chunking finishes for the file.

### symbolId stability fix

`tree-sitter.ts:194-219` (`chunkOversizedNode`) currently calls the character
chunker for split methods, which produces subChunks with `chunkType: "block"`
and `symbolId: undefined`. Fix:

```typescript
// pipeline/chunker/tree-sitter.ts, modified chunkOversizedNode
for (const subChunk of subChunks) {
  chunks.push({
    ...subChunk,
    startLine: ...,
    endLine: ...,
    metadata: {
      ...subChunk.metadata,
      chunkIndex: chunks.length,
      symbolId: this.buildSymbolId(parentName),       // NEW: inherit
      chunkType: "function",                           // NEW: preserve
      parentSymbolId: parentName,
      parentType,
      methodLines: nodeMethodLines,
    },
  });
}
```

This makes the invariant "all chunks of one method share the same symbolId" hold
without introducing any new payload field. No schema drift required.

### TSCallResolver

```
core/domains/trajectory/codegraph/symbols/resolvers/ts/
  ts-resolver.ts            # implements CallResolver
  ts-config-loader.ts       # parses tsconfig.json + extends chain
  ts-path-mapper.ts         # @/foo → src/foo, ~/lib → ./lib
  index.ts
```

Resolution strategy:

1. Look up the receiver (or free-call name) in `ctx.imports`. If matched,
   resolve the import path to `targetRelPath` using `ts-path-mapper` (relative
   paths + tsconfig `paths`/`baseUrl`).
2. Inside the target file, look up the member name in `GlobalSymbolTable`
   restricted to that file. If found, set `targetSymbolId`.
3. If imports do not match, fall back to a global symbol-table lookup by short
   name (handles ambient declarations, default-export name shadowing).
4. Return `null` if nothing resolves (the call is recorded only as a method edge
   with `targetSymbolId = null` if at least the file is known; otherwise the
   call is dropped — orphan calls are out of scope for Slice 1).

The resolver is stateless beyond the loaded tsconfig. Concurrency is safe.

The depth of TS resolution (relative-only vs full tsconfig paths) is **deferred
to plan-writing**: the contract is the same, only the path mapper implementation
changes.

### CodegraphEnrichmentProvider

Implements `EnrichmentProvider`. Lives at
`core/domains/trajectory/codegraph/symbols/provider.ts`.

```typescript
export class CodegraphEnrichmentProvider implements EnrichmentProvider {
  readonly key = "codegraph.symbols";
  readonly signals = CODEGRAPH_FILE_SIGNALS.concat(CODEGRAPH_CHUNK_SIGNALS);
  readonly derivedSignals = CODEGRAPH_DERIVED_SIGNALS;
  readonly filters = CODEGRAPH_FILTERS;
  readonly presets = CODEGRAPH_PRESETS;

  resolveRoot(absolutePath: string): string { /* repo root */ }

  async buildFileSignals(root: string, options): Promise<Map<string, FileSignalOverlay>> {
    // Reads cg_symbols_edges_file via GraphDbClient.
    // Computes fanIn, fanOut, instability, isHub (relative to p95), isLeaf.
  }

  async buildChunkSignals(root: string, chunkMap): Promise<Map<string, Map<string, ChunkSignalOverlay>>> {
    // Reads cg_symbols_edges_method via GraphDbClient.
    // Computes calledByCount, callSiteCount per chunk (head chunks of methods).
  }

  // NEW: extension method bound by the registry, called by the chunker:
  asExtractionSink(): ExtractionSink { ... }
}
```

The `ExtractionSink` returned by `asExtractionSink()` is what the chunker pool
injects. The provider buffers extractions in memory between `write` calls and
flushes on `finish`.

### Signals and presets

```
core/domains/trajectory/codegraph/symbols/
  payload-signals.ts        # CODEGRAPH_FILE_SIGNALS, CODEGRAPH_CHUNK_SIGNALS
  rerank/
    derived-signals/        # FanInSignal, FanOutSignal, InstabilitySignal,
                            # IsHubSignal, IsLeafSignal,
                            # CalledByCountSignal, CallSiteCountSignal
    presets/
      blast-radius.ts       # custom rerank with codegraph weights
```

Payload signal keys:

- `codegraph.file.fanIn` (number)
- `codegraph.file.fanOut` (number)
- `codegraph.file.instability` (number, 0..1)
- `codegraph.file.isHub` (boolean)
- `codegraph.file.isLeaf` (boolean)
- `codegraph.chunk.calledByCount` (number)
- `codegraph.chunk.callSiteCount` (number)

Derived signal keys (for rerank weights): `fanIn`, `fanOut`, `instability`,
`isHub`, `isLeaf`, `calledByCount`, `callSiteCount`.

`isHub` is computed using cohort `p95` of `fanIn` per language, mirroring the
existing pattern (`p95` lives in `core/contracts/signal-utils.ts`).

`StaticTrajectory.payloadSignals.imports[]` is **not** removed in Slice 1.
Migrating it to `codegraph.file.imports[]` is tracked as a separate ticket on
the epic.

### MCP tools

`get_callers` and `get_callees` are registered alongside the existing
`SEARCH_TOOLS` array in `mcp/tools/`.

```typescript
// mcp/tools/codegraph-tools.ts (new)
export const CODEGRAPH_TOOLS: ToolDescriptor[] = [
  {
    name: "get_callers",
    description: "Returns all call sites that invoke the given symbol.",
    schema: getCallersSchema, // Zod schema generated from GraphFacade input shape
    handler: (input, deps) => deps.app.graph.getCallers(input),
  },
  {
    name: "get_callees",
    description: "Returns all symbols invoked by the given symbol.",
    schema: getCalleesSchema,
    handler: (input, deps) => deps.app.graph.getCallees(input),
  },
];
```

Tool registration plugs into the same `registerToolSafe` pipeline as existing
tools — no new error-handling path.

DTOs live at `core/api/public/dto/graph.ts`:

```typescript
export interface GetCallersInput {
  path: string;
  symbolId: SymbolId;
  limit?: number;
}

export interface GetCallersOutput {
  callers: {
    sourceSymbolId: SymbolId;
    sourceRelPath: RelPath;
    callExpression: string;
    chunk?: ChunkPreview;
  }[];
}

// Mirror shape for GetCalleesInput / GetCalleesOutput.
```

`ChunkPreview` is the existing minimal-chunk DTO returned by `find_symbol`.

### GraphFacade

```typescript
// core/api/internal/facades/graph-facade.ts (new)
export class GraphFacade {
  constructor(private deps: GraphFacadeDeps) {}

  async getCallers(input: GetCallersInput): Promise<GetCallersOutput> {
    const edges = await this.deps.graphDb.getCallers(input.symbolId);
    const limited = edges.slice(0, input.limit ?? 50);
    const chunks = await this.deps.exploreFacade.findSymbolByIds(
      limited.map((e) => e.sourceSymbolId),
    );
    return { callers: zipChunks(limited, chunks) };
  }

  async getCallees(input: GetCalleesInput): Promise<GetCalleesOutput> {
    /* mirror */
  }
}
```

App interface (`core/api/public/app.ts`) gains:

```typescript
export interface App {
  // existing...
  graph: GraphFacade;
}
```

### DuckDB adapter

```
core/adapters/duckdb/
  client.ts                 # DuckDbGraphClient implements GraphDbClient
  index.ts
```

`DuckDbGraphClient` uses the official `@duckdb/node-api` package (or `duckdb`
Node bindings, decided at plan-writing time). Connection is a single in-process
file-backed instance per `App` (the codegraph DB is per-collection, named
`<collection>.codegraph.duckdb` in the data directory).

### Migration runner

```
core/infra/migration/database/
  runner.ts                 # driver-agnostic migrator
  migrations/
    001-cg-symbols-init.sql # creates cg_symbols_files, cg_symbols_edges_file,
                            # cg_symbols_edges_method + indexes
```

The runner reads SQL files in numeric order, tracks applied migrations in a
`schema_migrations` table, and runs each in a transaction. It accepts a
`GraphDbClient` and uses a generic `query`/`exec` adapter method that DuckDB and
PostgreSQL implement.

### Composition

`createComposition()` (in `core/api/internal/composition.ts`) gains a single
factory call that registers each L2 trajectory of the codegraph family:

```typescript
if (!config.codegraphDisabled) {
  const codegraphDeps: CodegraphDeps = {
    graphDb: deps.graphDbClient,
    symbolTable: new InMemoryGlobalSymbolTable(),
    resolvers: new Map([
      ["typescript", new TSCallResolver(deps.tsConfigLoader)],
    ]),
  };
  for (const trajectory of createCodegraphTrajectories(codegraphDeps)) {
    registry.register(trajectory);
  }
}
```

`TrajectoryRegistry` ends up with `SymbolsTrajectory` registered alongside the
existing `StaticTrajectory` and `GitTrajectory`. There is no L1 entry to
special-case anywhere in the registry, the coordinator, or the reranker.

`createAppContext` (in `core/bootstrap/factory.ts`) constructs the
`GraphDbClient`:

```typescript
if (!config.codegraphDisabled) {
  const graphDb = new DuckDbGraphClient({ path: config.codegraphDbPath });
  await graphDb.init();
  await runMigrations(graphDb);
}
```

### Drift detection

`SchemaDriftMonitor` (in `core/infra/schema-drift-monitor.ts`) gains a new
check:

```typescript
const codegraphState = {
  enabled: !config.codegraphDisabled,
  hasData: (await graphDb?.hasData()) ?? false,
};
if (codegraphState.enabled && !codegraphState.hasData) {
  return {
    drift: true,
    code: "CODEGRAPH_BACKFILL_NEEDED",
    hint: "Codegraph is enabled but graph database is empty. Run `index_codebase` with `forceReindex=true` to populate it.",
  };
}
```

### Feature flag

`config.codegraphDisabled` resolves from `CODEGRAPH_DISABLED` env var. Default:
`false` (codegraph runs whenever the trajectory is registered).

When `true`:

- Trajectory is not registered in `composition.ts`.
- `GraphDbClient` is not constructed.
- No drift check fires.
- Existing graph DB on disk is left untouched (no auto-delete).

## Slice 2-5 extension points

Each extension point is verified by Slice 1 to ensure it does not require
breaking changes later.

### Slice 2 — additional MCP tools, Tier 2-3 metrics

- **`get_dependencies(file)`, `get_dependents(file)`, `find_cycles()`**: added
  to `GraphFacade` as new methods (additive). Each gets a new MCP tool
  descriptor in `CODEGRAPH_TOOLS`. No schema change.
- **Tier 2-3 metrics** (`transitiveImpact`, `pageRank`, `betweenness`): computed
  by recursive SQL queries against the existing edges tables. New signals
  registered in `CODEGRAPH_FILE_SIGNALS`. Schema drift adds the new payload
  fields, drift detector prompts reindex.
- **Cycle detection results**: new table `cg_symbols_cycles` (matches the
  `cg_<subtype>_*` convention). Migration `002-cg-symbols-cycles.sql`.

### Slice 3 — additional language hooks

- New chunker hooks under `pipeline/chunker/hooks/<language>/`.
- New `<Language>CallResolver` implementing the existing `CallResolver`
  interface. Plugged into the provider's resolver map keyed by language.
- For autoload-based languages (Ruby/Rails):
  - `RubyCallResolver` implements lexical scope walk plus Zeitwerk camelize
    convention.
  - The chunker's existing namespace tracking (already used for symbolId
    composition) is forwarded into `ChunkExtraction.scope`.
- Regex-fallback hook for unsupported languages: extracts only file-level
  imports (no method-level edges). Lives at
  `pipeline/chunker/hooks/regex-fallback/`. Suitable for low-priority languages
  where AST hooks are not yet justified.

### Slice 4 — PostgreSQL adapter

- `PostgresGraphClient` implements `GraphDbClient` at
  `core/adapters/postgres/client.ts`.
- Migration runner is already driver-agnostic; SQL files stay the same modulo
  dialect quirks (none expected for slice 1 schema).
- Connection string parsing: `DATABASE_URL` accepts
  `postgres://user:pass@host:port/db` form. `DATABASE_ADAPTER` env var becomes
  required (`duckdb` or `postgres`).
- Bootstrap selects the adapter:
  ```typescript
  const adapter = config.databaseAdapter ?? "duckdb";
  const graphDb =
    adapter === "postgres"
      ? new PostgresGraphClient(config.databaseUrl)
      : new DuckDbGraphClient(config.databaseUrl ?? defaultDuckDbPath);
  ```

### Slice 5+ — additional sub-graphs

- New sub-graph (e.g. `cg_temporal_*` for temporal coupling) adds:
  1. Schema migration: `00X-cg-temporal-init.sql` creating `cg_temporal_files`,
     `cg_temporal_edges_*`.
  2. New L2 trajectory module: `core/domains/trajectory/codegraph/temporal/`,
     including its `EnrichmentProvider`, signals, derived signals, presets,
     filters, and a `createTemporalTrajectory(deps)` factory.
  3. One line added to `createCodegraphTrajectories()` in
     `core/domains/trajectory/codegraph/index.ts`:
     `return [createSymbolsTrajectory(deps), createTemporalTrajectory(deps)];`
- The codegraph family stays a composition-time grouping. The shared
  `Trajectory` contract is unchanged. `TrajectoryRegistry` simply gains one more
  L2 entry; the toggle on `CODEGRAPH_DISABLED` continues to enable or disable
  all family members at once.

## File-by-file change list (Slice 1)

### New files

```
core/contracts/types/codegraph.ts                            # all contracts
core/contracts/index.ts                                       # add re-export
core/adapters/duckdb/client.ts                               # DuckDbGraphClient
core/adapters/duckdb/index.ts
core/infra/migration/database/runner.ts                      # generic migrator
core/infra/migration/database/migrations/001-cg-symbols-init.sql
core/domains/trajectory/codegraph/index.ts                   # trajectory barrel
core/domains/trajectory/codegraph/symbols/index.ts           # sub-trajectory barrel
core/domains/trajectory/codegraph/symbols/provider.ts        # CodegraphEnrichmentProvider
core/domains/trajectory/codegraph/symbols/payload-signals.ts
core/domains/trajectory/codegraph/symbols/symbol-table.ts    # GlobalSymbolTable impl
core/domains/trajectory/codegraph/symbols/resolvers/base.ts  # AbstractCallResolver
core/domains/trajectory/codegraph/symbols/resolvers/ts/ts-resolver.ts
core/domains/trajectory/codegraph/symbols/resolvers/ts/ts-config-loader.ts
core/domains/trajectory/codegraph/symbols/resolvers/ts/ts-path-mapper.ts
core/domains/trajectory/codegraph/symbols/resolvers/ts/index.ts
core/domains/trajectory/codegraph/symbols/rerank/derived-signals/fan-in.ts
core/domains/trajectory/codegraph/symbols/rerank/derived-signals/fan-out.ts
core/domains/trajectory/codegraph/symbols/rerank/derived-signals/instability.ts
core/domains/trajectory/codegraph/symbols/rerank/derived-signals/is-hub.ts
core/domains/trajectory/codegraph/symbols/rerank/derived-signals/is-leaf.ts
core/domains/trajectory/codegraph/symbols/rerank/derived-signals/called-by-count.ts
core/domains/trajectory/codegraph/symbols/rerank/derived-signals/call-site-count.ts
core/domains/trajectory/codegraph/symbols/rerank/presets/blast-radius.ts
core/domains/trajectory/codegraph/symbols/rerank/presets/index.ts
core/domains/ingest/pipeline/chunker/hooks/typescript/extraction-hook.ts
core/api/internal/facades/graph-facade.ts                    # GraphFacade
core/api/public/dto/graph.ts                                  # DTOs
mcp/tools/codegraph-tools.ts                                  # 2 tools
```

### Modified files

```
core/contracts/types/provider.ts                              # add ExtractionSink ref (re-export from codegraph.ts)
core/domains/ingest/pipeline/chunker/tree-sitter.ts           # symbolId fix in chunkOversizedNode
core/domains/ingest/pipeline/chunker/hooks/typescript/index.ts  # register extraction hook
core/domains/ingest/pipeline/file-processor.ts                # call ExtractionSink.write per file
core/domains/ingest/pipeline/enrichment/coordinator.ts        # pass ExtractionSink to providers (if not already injectable)
core/api/internal/composition.ts                              # call createCodegraphTrajectories, register L2s
core/api/public/app.ts                                        # add `graph: GraphFacade` to App
core/api/public/dto/index.ts                                  # re-export graph DTOs
core/bootstrap/factory.ts                                     # construct GraphDbClient, run migrations
core/infra/schema-drift-monitor.ts                            # codegraph drift check
mcp/tools/index.ts                                            # register CODEGRAPH_TOOLS
```

`core/contracts/types/trajectory.ts` is **not** in this list — the `Trajectory`
contract is unchanged. `core/domains/trajectory/git/index.ts` and
`core/domains/trajectory/static/index.ts` are **not** modified either.

### Test files (mirror structure)

```
tests/core/domains/trajectory/codegraph/symbols/provider.test.ts
tests/core/domains/trajectory/codegraph/symbols/symbol-table.test.ts
tests/core/domains/trajectory/codegraph/symbols/resolvers/ts/ts-resolver.test.ts
tests/core/domains/trajectory/codegraph/symbols/rerank/derived-signals/*.test.ts
tests/core/adapters/duckdb/client.test.ts
tests/core/infra/migration/database/runner.test.ts
tests/mcp/tools/codegraph-tools.test.ts
tests/integration/codegraph-vertical-slice.test.ts             # full pipeline E2E
```

## Open questions deferred to plan-writing

- **TS resolution depth**: relative-only vs tsconfig `paths`/`baseUrl` vs full
  TS resolver. Affects `ts-path-mapper.ts` only. Decision: at plan-writing time
  after measuring real-world coverage on an internal monorepo sample.
- **DuckDB driver choice**: `@duckdb/node-api` vs `duckdb` (Node bindings).
  Trade-off between API ergonomics and packaging overhead.
- **Concurrency control during writes**: single AsyncQueue vs DB-level
  transactions. Resolved at implementation time; either fits the `GraphDbClient`
  interface as written.
- **`imports[]` legacy field migration**: tracked as a separate ticket on the
  epic, not part of Slice 1.

## References

- Epic: `tea-rags-mcp-l26` (notes contain accumulated brainstorming decisions)
- Predecessor draft: `docs/plans/2026-02-24-code-graph-enrichment-design.md`
  (treated as historical context only)
- Metric foundations: `website/docs/knowledge-base/code-quality-metrics.md`
- Enrichment contract: `core/contracts/types/provider.ts`
- Trajectory contract: `core/contracts/types/trajectory.ts`
- Schema drift mechanism: `core/infra/schema-drift-monitor.ts`
- Stats accumulator pattern: `core/contracts/types/stats-accumulator.ts`
- Chunker fix locus:
  `core/domains/ingest/pipeline/chunker/tree-sitter.ts:194-219`

# Code-Graph Enrichment: Dependency Graph & Symbol Metrics

## Status

Approved (brainstorming complete)

## Context

TeaRAGs currently has two parallel pipelines during indexing:

1. **Embedding pipeline** (scan -> chunk -> embed -> upsert)
2. **Git enrichment** (git log -> file metadata -> chunk churn)

The `impactAnalysis` reranker preset uses only `imports` (fan-out) with weight
0.5 — no reverse dependencies (fan-in), no complexity metrics, no
graph-theoretic analysis. We need blast radius, dependency graph metrics, and
complexity to enable true change risk assessment.

## Goals

1. **Code-Graph Enrichment** as a third parallel strategy alongside embedding
   and git
2. **Unified Pipeline abstraction** — common lifecycle for all strategies
   (collect + finalize)
3. **Dependency graph** with both in-memory (Tier 1) and persistent DuckDB (Tier
   2-3) storage
4. **Complexity metrics** (cyclomatic + cognitive) from existing tree-sitter AST
5. **New reranker signals and presets** — blastRadius, changeRisk, updated
   impactAnalysis

## Architecture

### Unified Strategy Lifecycle

All enrichment strategies share a common lifecycle driven by the main embedding
pipeline:

```
Main Pipeline (scan -> chunk -> embed -> store)
   │
   ├── onFileProcessed(file, ast, imports[])
   │     ├── GitStrategy.enrich(file, gitData)
   │     └── CodeGraphStrategy.collect(file, ast, imports)
   │           ├── complexity → WRITE NOW (streaming)
   │           └── edges → accumulate in-memory
   │
   └── onAllFilesComplete()
         └── CodeGraphStrategy.finalize()
               ├── Step 1: in-memory graph → Tier 1 metrics → Qdrant
               └── Step 2: DuckDB persist → Tier 2-3 metrics → Qdrant (fire-and-forget)
```

Key: strategies subscribe to pipeline events. No post-processing phase — only a
`finalize()` callback.

### AST Reuse

The chunker already parses tree-sitter AST for every file. The AST is passed to
code-graph strategy at zero cost — no second parse. From the same AST we
extract:

- Imports (replacing current regex in metadata.ts)
- Complexity (cyclomatic + cognitive per chunk)

### Three-Tier Metric Model

**Tier 1: In-memory** (available ~100ms after indexing)

- `importedByCount` — direct fan-in (reverse dependency count)
- `fanOut` — efferent coupling (imports.length, already exists)
- `instability` — Ce / (Ce + Ca), range 0-1
- `isHub` — fanIn > threshold AND fanOut > threshold
- `isLeaf` — fanIn = 0 AND fanOut >= 1

**Tier 2-3: DuckDB** (available ~5-15s after indexing, fire-and-forget)

- `transitiveImpact` — full cascade depth N (WITH RECURSIVE)
- `pageRank` — importance weighted by dependents quality (iterative, 20 rounds)
- `betweenness` — bridge score (sampled, top-N nodes for performance)
- Circular dependency detection

**Immediate** (written per-chunk during indexing, streaming):

- `complexity.cyclomatic` — McCabe complexity from AST
- `complexity.cognitive` — SonarQube-style nesting penalty from AST

### Import Resolution

MVP scope: relative paths only (`./utils` -> `src/utils.ts`). External packages
(node_modules) ignored. Alias resolution (@/ paths) deferred to future work.
Covers ~70% of project-internal dependencies.

Extensible: resolver interface allows adding alias/tsconfig support later.

### Persistent Graph (DuckDB)

Stored on disk alongside collection. Enables:

- Transitive blast radius queries (multi-hop)
- Circular dependency detection
- Graph-theoretic metrics (PageRank, betweenness)
- Incremental reindex (change one file -> recompute affected edges only)
- Ad-hoc SQL queries via MCP tools
- Dead code detection (zero in-degree symbols)
- Refactoring simulation ("what breaks if I move this file?")

### Data Flow

```
                    BLOCKING PATH
                    ═════════════
FileScanner
    │
    ▼
Chunker (tree-sitter AST)
    ├── chunks[]  → Embed → Upsert Qdrant (main path)
    ├── imports[] ─┐
    └── AST nodes ─┤
                   ▼
           CodeGraphStrategy
           ├── complexity per chunk → BatchAccumulator → streaming batchSetPayload
           └── edges in-memory map → Map<file, Set<file>>   (zero I/O)

                    ═══════════════
                    onAllFilesComplete → search works!
                    ═══════════════

           FIRE-AND-FORGET Step 1 (~100ms)
           ├── Invert graph (in-memory)
           ├── Compute Tier 1 metrics
           └── BatchAccumulator(200) → batchSetPayload → Qdrant
                    search now sees deps.*

           FIRE-AND-FORGET Step 2 (~5-15s)
           ├── Bulk insert edges → DuckDB
           ├── WITH RECURSIVE → transitiveImpact
           ├── PageRank (20 iterations)
           ├── Betweenness (sampled top-N)
           └── BatchAccumulator(200) → batchSetPayload → Qdrant
                    search now sees all metrics
```

### Timing Scenarios (Complexity Streaming)

Same three scenarios as git enrichment:

1. **Embedding slower than AST** (typical): complexity writes STREAMING
   immediately after chunks stored
2. **Simultaneous**: mix of streaming and queued writes
3. **Embedding faster** (rare): pendingPayloads[] → BURST flush when AST catches
   up

### Optimizations

| Optimization         | Where               | How                                                          |
| -------------------- | ------------------- | ------------------------------------------------------------ |
| AST reuse            | Chunker → CodeGraph | Tree already parsed for chunking. Pass, don't re-parse.      |
| Streaming complexity | Per-chunk           | Write via BatchAccumulator as chunks are stored, no waiting  |
| Burst/pending        | Complexity writes   | 3 timing scenarios (streaming/mix/burst) like git enrichment |
| Zero-copy edges      | In-memory map       | Pure CPU accumulation, zero I/O during indexing              |
| Batch Tier 1         | finalize Step 1     | Single wave of batchSetPayload(200) for all deps.\*          |
| Bulk insert DuckDB   | finalize Step 2     | One INSERT INTO edges VALUES ... not per-row                 |
| Sampled betweenness  | DuckDB compute      | Top-N nodes only, 95% accuracy at 10% cost                   |
| Non-blocking         | Steps 1 + 2         | Fire-and-forget — search works before graph metrics land     |

### Payload Schema Extension

```typescript
// New: deps (Tier 1, from in-memory graph)
interface DepsPayload {
  importedByCount: number; // structural fan-in
  fanOut: number; // = imports.length
  isHub: boolean; // importedByCount > θ₁ AND fanOut > θ₂
  isLeaf: boolean; // importedByCount = 0 AND fanOut >= 1
  instability: number; // Ce / (Ce + Ca), range 0-1
}

// New: deps extended (Tier 2-3, from DuckDB)
interface DepsExtendedPayload extends DepsPayload {
  transitiveImpact: number; // transitive fan-in (depth N)
  pageRank: number; // graph importance, range 0-1
  betweenness: number; // bridge score, range 0-1
}

// New: complexity (immediate, per-chunk)
interface ComplexityPayload {
  cyclomatic: number; // McCabe complexity
  cognitive: number; // SonarQube cognitive complexity
}
```

### New Reranker Signals

```typescript
importedBy: normalize(deps.importedByCount, maxImportedBy);
transitiveImpact: normalize(deps.transitiveImpact, maxTransitive);
pageRank: deps.pageRank; // already 0-1
betweenness: deps.betweenness; // already 0-1
instability: deps.instability; // already 0-1
isHub: deps.isHub ? 1.0 : 0;
complexity: normalize(complexity.cyclomatic, maxComplexity);
```

### New Presets

```typescript
blastRadius: {
  similarity:       0.25,
  importedBy:       0.15,
  transitiveImpact: 0.20,
  pageRank:         0.15,
  betweenness:      0.10,
  churn:            0.15,
}

changeRisk: {
  similarity:       0.20,
  churn:            0.15,
  importedBy:       0.15,
  complexity:       0.15,
  transitiveImpact: 0.10,
  bugFix:           0.10,
  volatility:       0.10,
  knowledgeSilo:    0.05,
}

// Updated impactAnalysis (currently: similarity 0.5, imports 0.5)
impactAnalysis: {
  similarity:       0.30,
  importedBy:       0.30,
  fanOut:           0.15,
  isHub:            0.15,
  churn:            0.10,
}
```

### MCP Tools (from persistent graph)

Enabled by DuckDB persistence, available between sessions:

- `get_blast_radius(file, depth)` — transitive dependency cascade
- `find_circular_dependencies()` — cycle detection in import graph
- `get_critical_paths(file)` — betweenness/bridge analysis
- `find_dead_code()` — symbols with zero in-degree
- `suggest_module_boundaries()` — graph clustering for architectural boundaries

### Related Tasks

- `tea-rags-mcp-74o` — Add importedBy for blast radius
- `tea-rags-mcp-nyg` — Add complexity metrics
- `tea-rags-mcp-sd4` — Roadmap: Advanced Metrics & Indexing Optimizations

### References

- `docs/examples/use-reranking-in-agentic-flow/BLAST_RADIUS.md` — research &
  tiers
- `website/docs/knowledge-base/code-quality-metrics.md` — academic foundations
- `website/docs/agent-integration/deep-codebase-analysis/impact-analysis.md` —
  usage patterns

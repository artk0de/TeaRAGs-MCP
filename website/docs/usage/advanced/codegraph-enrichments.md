---
title: Codegraph Enrichments
sidebar_position: 5.1
---

import AiQuery from '@site/src/components/AiQuery';
import MermaidTeaRAGs from '@site/src/components/MermaidTeaRAGs';

# Codegraph Enrichments

:::caution Beta feature

Codegraph enrichment is a **beta** capability — **disabled by default**. The
graph extraction and structural signals are still being calibrated across
languages. Resolution recall varies by language, and signal semantics may change
between releases. Opt in with `CODEGRAPH_ENABLED=true`.

:::

While [git enrichments](/usage/advanced/git-enrichments) answer _"how has this
code behaved over time?"_, codegraph enrichment answers _"how is this code
connected **right now**?"_. tea-rags extracts your project's **call graph** and
**import graph** into a per-project [DuckDB](https://duckdb.org/) database, then
attaches **structural graph signals** — fan-in, fan-out, instability, PageRank,
transitive impact — to every indexed chunk. Your agent can rank by architectural
importance and blast radius, not just relevance and history.

## What It Is

Codegraph is a **trajectory enrichment family** (internal key
`codegraph.symbols`). At index time, per-language tree-sitter walkers extract
symbols, imports, and call sites; per-language resolvers turn those into graph
edges stored in DuckDB (one `.duckdb` file per indexed project under
`<dataDir>/codegraph/`). Two graphs are built:

- **Import graph** (file-to-file) — which files import which, used for
  file-level coupling signals.
- **Call graph** (symbol-to-symbol) — which functions/methods call which, used
  for symbol-level signals and cycle detection.

<MermaidTeaRAGs>
{`
flowchart LR
    Codebase[📁 Source Files<br/><small>+ call sites + imports</small>]

    subgraph extract["Codegraph Extraction"]
        Walk[🌲 tree-sitter walkers<br/><small>per language</small>]
        Resolve[🔗 symbol resolvers<br/><small>call → edge</small>]
        Graph[(🗄️ DuckDB<br/><small>per-project graph DB</small>)]
        Walk --> Resolve --> Graph
    end

    Signals[📊 Graph Signals<br/><small>fanIn · fanOut · pageRank<br/>instability · transitiveImpact</small>]
    Qdrant[(🗄️ Qdrant<br/><small>enriched chunks</small>)]

    Codebase --> Walk
    Graph --> Signals --> Qdrant
`}
</MermaidTeaRAGs>

For the theory behind these metrics (Henry & Kafura fan-in/fan-out, Martin
instability, PageRank centrality and bug-proneness), see
[Code Quality Metrics](/knowledge-base/code-quality-metrics).

## Enabling Codegraph

Codegraph is **disabled by default** (beta). Opt in with `CODEGRAPH_ENABLED`:

```bash
claude mcp add tea-rags -s user -- node /path/to/tea-rags/build/index.js \
  -e CODEGRAPH_ENABLED=true
```

While disabled (the default), the entire family is dropped — no graph
extraction, no graph signals on payloads, and the codegraph MCP tools
(`get_callers`, `get_callees`, `find_cycles`) are not registered. Re-index after
enabling so payloads carry the new signals.

## Supported Languages

Graph extraction runs for **8 languages** across 12 extensions:

| Language   | Extensions                  |
| ---------- | --------------------------- |
| TypeScript | `.ts`, `.tsx`               |
| JavaScript | `.js`, `.jsx`, `.mjs`, `.cjs` |
| Python     | `.py`                       |
| Ruby       | `.rb`                       |
| Go         | `.go`                       |
| Java       | `.java`                     |
| Rust       | `.rs`                       |
| Bash       | `.sh`, `.bash`              |

Files in other languages are still indexed and embedded by tea-rags — they just
carry no codegraph signals.

## What You Get

Codegraph computes signals at **two scopes**:

### File-scope signals (import graph)

| Signal                          | What it tells you                                                       |
| ------------------------------- | ----------------------------------------------------------------------- |
| `codegraph.file.fanIn`          | Number of files importing this file (afferent coupling)                 |
| `codegraph.file.fanOut`         | Number of files this file imports (efferent coupling)                   |
| `codegraph.file.instability`    | Martin instability `fanOut / (fanIn + fanOut)`, range 0–1               |
| `codegraph.file.connectionCount`| Total file-graph edges `fanIn + fanOut` (support for instability confidence) |
| `codegraph.file.isHub`          | `true` when fanIn exceeds the collection p95 (heavily depended-upon)     |
| `codegraph.file.isLeaf`         | `true` when fanOut is 0 and fanIn > 0 (pure dependency, depends on nothing) |
| `codegraph.file.transitiveImpact`| Distinct files that transitively import this file (reverse BFS, depth-capped at 5) — the real blast radius |

### Symbol-scope signals (call graph)

| Signal                    | What it tells you                                              |
| ------------------------- | ------------------------------------------------------------- |
| `codegraph.chunk.fanIn`   | Distinct call sites invoking this symbol (method-level fan-in) |
| `codegraph.chunk.fanOut`  | Outgoing calls from this symbol (method-level fan-out)         |
| `codegraph.chunk.pageRank`| PageRank over the call graph (damping 0.85, normalized 0–1) — recursive importance |

:::info Why two fan-in's?

`codegraph.file.fanIn` and `codegraph.chunk.fanIn` measure **different graphs** —
file imports vs. method call sites — so they are not interchangeable. A file
with low import fan-in can still contain a method everyone calls. Standard
alpha-blending between file and chunk does **not** apply to codegraph signals for
this reason.

:::

## MCP Tools

When codegraph is enabled, three graph-query tools become available (they read
the pre-computed DuckDB graph directly — no embedding, sub-millisecond):

| Tool          | Returns                                                                              |
| ------------- | ----------------------------------------------------------------------------------- |
| `get_callers` | Symbols that **invoke** the given `symbolId` (who depends on this)                   |
| `get_callees` | Symbols **invoked by** the given `symbolId` (what this depends on)                   |
| `find_cycles` | Strongly-connected components (cycles ≥ 2) in the import graph (`scope: "file"`) or call graph (`scope: "method"`) |

These pair naturally with [`find_symbol`](/usage/advanced/mcp-tools), which
resolves a name to a `symbolId` using the same `Class#method` (instance) /
`Class.method` (static) convention the codegraph tools consume.

## Use Cases

<AiQuery>What would break if I change this function? Show me its callers</AiQuery>
<AiQuery>Find the architectural hubs in this codebase</AiQuery>
<AiQuery>Are there any circular imports between modules?</AiQuery>
<AiQuery>Show me entry-point files nothing else imports from</AiQuery>
<AiQuery>What does this service depend on transitively?</AiQuery>

## Reranking Presets

Codegraph signals power **composite presets** that blend the structural graph
with git history. These presets are only available when codegraph is enabled
(they declare a `requires` dependency and are silently dropped otherwise):

| Preset            | Requires                  | Use case                                                      |
| ----------------- | ------------------------- | ------------------------------------------------------------ |
| `blastRadius`     | codegraph + git           | Rank by how much a change ripples out (fan-in + transitive impact + churn) |
| `architecturalHub`| codegraph + git           | Find the load-bearing files everything depends on            |
| `dangerous`       | codegraph + git           | High blast radius **and** high bug-fix rate — change with care |
| `entryPoint`      | codegraph                 | Leaf/entry files — natural starting points for onboarding    |

Enabling codegraph also upgrades the shared presets (`hotspots`, `techDebt`,
`codeReview`, `ownership`, `securityAudit`) to composite versions that factor
structural coupling into their scoring.

## Scoring Weights Reference

Weight keys available for custom reranking (`rerank: { "custom": { ... } }`)
when codegraph is enabled:

| Key                | Signal                                                          | Scope  |
| ------------------ | -------------------------------------------------------------- | ------ |
| `fanIn`            | Normalized files importing this file                           | file   |
| `fanOut`           | Normalized files this file imports                             | file   |
| `fanOutPerLine`    | Efferent coupling per line of code                             | file   |
| `instability`      | Martin instability (already 0–1)                               | file   |
| `isHub`            | 1 when file is a hub (fanIn > p95)                             | file   |
| `isLeaf`           | 1 when file is a leaf                                          | file   |
| `transitiveImpact` | Normalized count of transitive importers                      | file   |
| `chunkFanIn`       | Normalized method-level fan-in                                | symbol |
| `chunkFanOut`      | Normalized method-level fan-out                               | symbol |
| `pageRank`         | Normalized PageRank (recursive importance)                    | symbol |

## Configuration

| Variable                          | Default   | Description                                                                                  |
| --------------------------------- | --------- | ------------------------------------------------------------------------------------------- |
| `CODEGRAPH_ENABLED`               | `false`   | Master switch for the codegraph trajectory family (beta). `true` enables extraction, signals, and tools. |
| `CODEGRAPH_DB_PATH`               | data dir  | Override the graph-DB root directory. Per-project files at `<rootDir>/codegraph/<collection>.duckdb`. |
| `CODEGRAPH_DB_MEMORY_LIMIT`       | `"2GB"`   | Per-project DuckDB RAM ceiling before spilling to a temp dir (prevents OOM on large repos). |
| `CODEGRAPH_DB_THREADS`            | `2`       | DuckDB worker threads per project. The writer lock — not parallel scan — is the bottleneck, so more threads inflate memory without speeding up. |
| `CODEGRAPH_EXCLUDE_TESTS`         | `true`    | Exclude test files from the graph (still indexed by Qdrant; only graph extraction is gated). `false` includes tests in fan-graph / PageRank / cycles. |
| `CODEGRAPH_CUSTOM_EXCLUDE`        | _(empty)_ | Comma-separated `.gitignore`-shaped patterns added to the exclusion filter, e.g. `vendor/**,generated/**,*.pb.go`. |
| `CODEGRAPH_AMBIGUOUS_RESOLVE_MODE`| `"strict"`| How to resolve short-name calls matching multiple candidates. `strict` drops the edge unless exactly one match; `first` picks the first candidate (higher recall, more noise). |

## Next Steps

- [Git Enrichments](/usage/advanced/git-enrichments) — the history-based signal
  family codegraph composes with
- [Code Quality Metrics](/knowledge-base/code-quality-metrics) — fan-in/fan-out,
  instability, and centrality theory with research references
- [MCP Tools Atlas](/usage/advanced/mcp-tools) — full tool reference including
  `get_callers`, `get_callees`, `find_cycles`, `find_symbol`
- [Configuration Variables](/config/environment-variables) — full list of all
  configuration options

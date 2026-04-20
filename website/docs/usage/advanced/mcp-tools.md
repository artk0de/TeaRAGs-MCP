---
title: MCP Tools Atlas
sidebar_position: 1
---

# MCP Tools Atlas

TeaRAGs exposes **17 MCP tools** grouped into 6 categories. Most user workflows
run through [Skills](/usage/skills/) which compose these tools automatically.
Use this page when you want to build a custom workflow or understand what each
tool does.

All tools accept `path` (absolute project path) to auto-resolve the collection
name. Most tools also accept an explicit `collection` parameter for multi-codebase
scenarios ([collection management](./collections)).

## Search

Vector-based retrieval. All three tools share filters, rerank, and pathPattern —
they differ in output format and retrieval method.

| Tool | Input | Output | When to use |
|------|-------|--------|-------------|
| `search_code` | natural-language query | human-readable text | day-to-day development, pasting results into conversation |
| `semantic_search` | natural-language query | structured JSON with full metadata | analytics, reports, downstream processing |
| `hybrid_search` | query with identifiers/symbols | structured JSON | queries mixing NL with exact function/type names (BM25 + vector fused via RRF) |

See [Query Modes](./query-modes) for full parameter reference.

## Rank & Lookup

Tools that do NOT use vector similarity — direct lookup by metadata or structural
filter.

### `rank_chunks`

**Rank all chunks by rerank signals, no query.** Returns top-N by preset score
(e.g., highest `bugFixRate` + `churnVolatility` for `hotspots`). Powers the
`risk-assessment` skill.

```json
{
  "path": "/project",
  "rerank": "hotspots",
  "pathPattern": "**/api/**",
  "limit": 20
}
```

**When to use:** analytics queries that don't have a semantic target
("show me the riskiest 20 chunks"). Faster than `semantic_search` — no embedding
call.

### `find_similar`

**Find code similar to a given snippet or chunk ID.** Paste code into
`positiveCode`, or reference a chunk from previous search via `chunkId`. Supports
negative examples (`negativeCode`) to exclude patterns.

```json
{
  "path": "/project",
  "positiveCode": "async function retry(fn, attempts) { ... }",
  "limit": 10
}
```

**When to use:** deduplication, finding all implementations of a pattern you
already have one example of.

### `find_symbol`

**Direct lookup by symbol name or file path** — no embedding. Partial match
supported: `Reranker` finds the class and all its methods. `symbolId` convention:
`Class#method` (instance), `Class.method` (static).

Two modes:

- `symbol: "BugHuntPreset"` → merged definition for functions, outline + members for classes
- `relativePath: "src/core/reranker.ts"` → file-level outline (symbols or doc TOC)

```json
{
  "path": "/project",
  "symbol": "Reranker.rerank",
  "rerank": "techDebt"
}
```

**When to use:** you already know the symbol name. Instant (scroll, not vector).
Still applies rerank overlay with git signals.

## Index Operations

Lifecycle of an index: create, update, inspect, clear.

### `index_codebase`

**Primary indexing command.** First call on a path → full index. Subsequent calls
→ incremental (only changed files). Set `forceReindex: true` to rebuild from
scratch.

```json
{
  "path": "/project",
  "extensions": [".ts", ".tsx"],
  "forceReindex": false
}
```

See [Indexing Repositories](/usage/indexing-repositories) for full workflow.

### `reindex_changes`

**Deprecated.** `index_codebase` auto-detects changes. Kept for backward
compatibility.

### `get_index_status`

Returns current state: `not_indexed` / `indexing` / `stale_indexing` /
`completed` / `unavailable`. Includes infra health (Qdrant/Ollama reachability)
and per-trajectory enrichment progress.

**When to use:** before querying, to verify index is ready. Also surfaces schema
drift warnings if the payload version changed.

### `get_index_metrics`

Returns collection stats and **percentile-based thresholds** for every git
signal, scoped by `source` / `test` and by language:

```json
{
  "signals": {
    "typescript": {
      "git.file.commitCount": {
        "source": { "labelMap": { "low": 1, "typical": 4, "high": 12, "extreme": 34 } }
      }
    }
  }
}
```

**When to use:** discover "what counts as a hotspot _in my codebase_" before
building custom filters. The labels (`low`, `typical`, `high`, `extreme`) map to
p25/p50/p75/p95 of your project's distribution.

### `clear_index`

Deletes the entire collection. Irreversible. Use before changing embedding
model/dimensions, or to free space on an abandoned project.

## Collection Management

For multi-codebase setups — see [Collections](./collections) for the full guide.

| Tool | Purpose |
|------|---------|
| `create_collection` | Create a new vector collection manually (rare — `index_codebase` creates them) |
| `list_collections` | List all Qdrant collections on the server |
| `get_collection_info` | Inspect one collection: vector size, point count, distance metric |
| `delete_collection` | Delete a collection by name (alternative to `clear_index`) |

## Document Operations

Manual insertion of single documents — unusual in code RAG workflows, useful for
ad-hoc experiments or augmenting an existing index.

| Tool | Purpose |
|------|---------|
| `add_documents` | Add documents to a collection. Auto-embedded via the configured provider |
| `delete_documents` | Delete specific documents by ID |

Under normal usage, documents flow through `index_codebase` (chunking + embedding
+ enrichment). These tools are for cases where you want to inject a single
artifact without re-indexing.

## Tool → Skill Quick Reference

| Task | Skill | Tools invoked |
|------|-------|---------------|
| Index a project | `/tea-rags:index` | `index_codebase` |
| Full background reindex | `/tea-rags:force-reindex` | `index_codebase --forceReindex` (via subagent) |
| Investigate code | `/tea-rags:explore` | `semantic_search` / `hybrid_search` / `find_symbol` / `find_similar` |
| Scan for risks | `/tea-rags:risk-assessment` | `rank_chunks` (4 presets) |
| Debug a bug | `/tea-rags:bug-hunt` | `semantic_search` + `rank_chunks` (bugHunt preset) |
| Generate new code | `/tea-rags:data-driven-generation` | (reads overlay from prior `explore`) |

## See Also

- [Query Modes](./query-modes) — detailed parameter reference for search tools
- [Filters](./filters) — Qdrant filter syntax
- [Rerank Presets](./rerank-presets) — 15 presets catalog
- [Collections](./collections) — multi-codebase workflow
- [Git Enrichments](./git-enrichments) — signal definitions

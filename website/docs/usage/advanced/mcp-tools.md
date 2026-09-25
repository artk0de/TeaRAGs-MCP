---
title: MCP Tools Atlas
sidebar_position: 1
---

# MCP Tools Atlas

TeaRAGs exposes **20 MCP tools** grouped into 7 categories. Most user workflows
run through [Skills](/usage/skills/) which compose these tools automatically.
Use this page when you want to build a custom workflow or understand what each
tool does.

All project-aware tools accept three project resolvers, applied in strict order:

| Parameter    | When to use                                              |
| ------------ | -------------------------------------------------------- |
| `collection` | You already know the collection name (highest priority) |
| `project`    | A registered alias from the [Project Registry](./project-registry) |
| `path`       | Absolute project path (auto-resolves the collection)    |

At least one must be supplied — the MCP server does not fall back to its own
`cwd`. See [Collections](./collections) for multi-codebase scenarios.

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
supported: `Reranker` returns the class outline. `symbolId` convention:
`Class#method` (instance), `Class.method` (static).

Two modes:

- `symbol: "BugHuntPreset"` → merged full body for functions and methods; for a
  class or module, an outline of member symbolIds with no bodies (test chunks
  are excluded); for `doc:<hash>`, the full section content
- `relativePath: "src/core/reranker.ts"` → file-level outline (symbols or doc TOC)

Every line of an outline or TOC is an address: pass it back as
`symbol: "Reranker#rerank"` or `symbol: "doc:<hash>"` to read that one member or
section.

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

`forceReindex: true` combined with `testFile` (`only` / `exclude`),
`pathPattern`, `languages`, `fileExtension` or `files` is a **scoped force**: only
the matching indexed files are re-chunked and re-embedded, in place on the live
collection; every other point is untouched. The response reports
`Re-chunked in place (scoped force): N`. See
[Scoped force](/operations/recovery-reindexing#scoped-force--re-chunk-a-file-set-in-place).

```json
{
  "project": "myapp",
  "forceReindex": true,
  "testFile": "only",
  "languages": ["ruby"]
}
```

The first call on a git worktree whose repository has another indexed working
tree with the same model and settings is **seeded** from it: the sibling's index
is cloned and only differing files are embedded. The response then opens with a
`Worktree seed:` block naming the sibling and the copied / embedded file counts.
Pass `seedFromWorktree: false` to index from scratch instead. See
[Automatic Seeding on First Index](/usage/advanced/worktree-indexes#automatic-seeding-on-first-index).

See [Indexing Repositories](/usage/indexing-repositories) for full workflow.

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
| `create_collection` | Create a new vector collection manually (rare — `index_codebase` creates them). Optional `schema` makes it [typed](./collections#typed-collections) |
| `list_collections` | List all Qdrant collections on the server |
| `get_collection_info` | Inspect one collection: vector size, point count, distance metric, and `schema` for a typed collection |
| `delete_collection` | Delete a collection by name (alternative to `clear_index`) |

## Document Operations

Manual insertion of single documents — unusual in code RAG workflows, useful for
ad-hoc experiments or augmenting an existing index.

| Tool | Purpose |
|------|---------|
| `add_documents` | Add documents to a collection. Auto-embedded via the configured provider. On a typed collection, metadata is validated first and one violation rejects the whole batch |
| `delete_documents` | Delete specific documents by ID |

Under normal usage, documents flow through `index_codebase` (chunking + embedding
+ enrichment). These tools are for cases where you want to inject a single
artifact without re-indexing.

## Project Registry

Manage the per-machine registry at `~/.tea-rags/registry.json` that maps short
aliases to indexed projects.

| Tool                 | Purpose                                                                       |
| -------------------- | ----------------------------------------------------------------------------- |
| `register_project`   | Bind a short name to a project path. Lets later calls use `project: "<name>"` |
| `list_projects`      | List all registered projects with collection metadata                         |
| `unregister_project` | Remove by name or path (idempotent; does NOT delete the Qdrant collection)    |

The registered alias resolves to the project's path and collection name across
every search and indexing tool — see [Project Registry](./project-registry)
for the full guide, file format, and CLI equivalents.

## Calling a Tool from the Shell — `tea-rags call`

`tea-rags call <tool> [params]` runs one tool without an MCP client. It builds
the same server `tea-rags server` builds — same config, same tool set, same
input validation, error handling and response formatting — and talks to it over
an in-process MCP connection. What comes back is what an agent would receive.

Main use: checking a change to the tool surface against a local build, with no
server reconnect. `node build/cli/index.js call …` runs the checkout you just
built instead of the globally installed package.

```bash
tea-rags call find_symbol '{"project":"my-app","symbol":"Reranker#rerank"}'
echo '{"project":"my-app"}' | tea-rags call get_index_status -   # params from stdin
tea-rags call hybrid_search '{"project":"my-app","query":"retry"}' --json | jq .structuredContent
tea-rags call --list                                             # what this config registers
```

| Flag / exit code | Meaning |
| ---------------- | ------- |
| `--json` | Print the whole `CallToolResult` (`content`, `structuredContent`, `isError`) as one JSON document. Nothing else goes to stdout, even under `DEBUG=1`; diagnostics go to stderr |
| `--list` | Tools this server registers, one per line with a short description |
| exit `0` | Success |
| exit `1` | The tool returned an error, the input failed schema validation, or `params` is not a JSON object |
| exit `2` | Unknown tool (close matches are suggested), or a tool with its own CLI command |

The server's environment is your shell's, so the tool set follows it: codegraph
tools (`get_callers`, `trace_path`, …) appear only when `CODEGRAPH_ENABLED=true`
is set, exactly as for `tea-rags server`. To reproduce what your MCP client
sees, export the same variables its server config sets.

Two differences from a long-running server:

- Search tools never start a [background auto-update](../../operations/auto-update).
  A check made from a development build must not reindex the project it
  queries.
- `index_codebase`, `list_projects`, `register_project` and `unregister_project`
  are refused with a pointer to `tea-rags index-codebase` / `tea-rags projects`,
  which already cover them from the shell.

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

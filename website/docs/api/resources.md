---
title: Resources
sidebar_position: 2
---

# MCP Resources

TeaRAGs exposes read-only **MCP resources** — structured reference documents an agent can fetch on demand to answer "what can I do with this tool?", "which preset fits?", "which signal is which weight key?". They complement tools (which act) by providing self-documenting metadata (schema, thresholds, examples).

All resources return `text/markdown` (schema guides) or `application/json` (collection info).

## Catalog

| URI | What it returns | When to read |
|-----|-----------------|--------------|
| `tea-rags://schema/overview` | Resource catalog + tools quick reference + destructive-tool warnings | Starting point — one resource that lists everything else |
| `tea-rags://schema/presets` | Every rerank preset: name, description, signal weights, tools it supports | Choosing `rerank: "..."` for `semantic_search` / `hybrid_search` / `rank_chunks` |
| `tea-rags://schema/signals` | All weight keys for `rerank: { custom: { ... } }` mode | Building a custom rerank when no preset fits |
| `tea-rags://schema/filters` | Qdrant filter operators, combining conditions, available payload fields | Building `filter` parameter for any search tool |
| `tea-rags://schema/search-guide` | Parameter examples per tool (`search_code`, `semantic_search`, `hybrid_search`, `find_symbol`, `rank_chunks`) | Unsure how to call a specific tool |
| `tea-rags://schema/indexing-guide` | `index_codebase` options + git-metadata filter reference + reindex workflow | Before first `index_codebase` call or when wiring incremental reindex |
| `tea-rags://schema/signal-labels` | Percentile-to-label mappings (e.g. `p75 → "high"`) for every numeric signal in ranking overlays | Interpreting label values in search result overlays |
| `qdrant://collections` | JSON list of all Qdrant collections | Discovering what's already indexed |
| `qdrant://collection/{name}` | JSON: collection config, point count, vector count | Debugging a specific collection |

## Why resources exist

Tools have schemas — parameters, types, descriptions. But some things are too large or too dynamic to live in tool schemas:

- **Preset catalog** grows over time; inlining it in every `semantic_search` call wastes tokens.
- **Signal labels** (`low`/`typical`/`high`/`extreme`) are percentile-derived per codebase — they depend on indexed data, not static defaults.
- **Filter syntax** is a full query language that applies to many tools.

Resources let an agent fetch this data **once per session**, cache it, and reuse across many tool calls.

## How to fetch a resource

In Claude Code, resources surface as `@<uri>` references or via the `ReadMcpResource` tool. In raw MCP protocol:

```json
{
  "method": "resources/read",
  "params": { "uri": "tea-rags://schema/presets" }
}
```

The response `contents[0].text` carries the markdown body.

## Dynamic vs static content

Most `tea-rags://schema/*` resources are **statically generated** at server startup from code:

- `presets` and `signals` are derived from the [Reranker](/architecture/overview) via [`SchemaBuilder`](/architecture/overview) — they reflect exactly what's registered in the trajectory registry.
- `signal-labels` is built from [`get_index_metrics`](/api/tools) thresholds — the response changes per codebase because percentile buckets depend on indexed data.
- `filters`, `overview`, `search-guide`, `indexing-guide` are static markdown embedded in the server binary.

`qdrant://*` resources are always dynamic — they hit the live Qdrant instance.

## Related

- [Tools](/api/tools) — how to act on data; resources document how to parameterize those actions.
- [Search Strategies](/agent-integration/search-strategies) — narrative guide that references these resources implicitly.
- [Rerank Presets](/usage/advanced/rerank-presets) — human-readable preset catalog (the resource version is machine-oriented).

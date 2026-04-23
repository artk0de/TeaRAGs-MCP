# Sub-Collections (Cold Memory)

## Problem

TeaRAGs has two separate collection flows: code indexing (full pipeline with AST
chunking, Merkle sync, git enrichment) and custom collections (bare embed+store,
no chunking, no sync). Users want to index project subdirectories as separate
collections — for documentation, specs, knowledge bases — with incremental
reindexing, per-collection embedding model, and the option to exclude a
directory from the main project collection. Current custom collections lack all
of these capabilities.

## Solution

Allow declaring subdirectories as **sub-collections** via config file
(`$PROJECT/.tea-rags`) or MCP tool parameters. Sub-collections go through the
same chunking pipeline as code but without git enrichment. Each sub-collection
gets its own Merkle snapshot for incremental sync, and can specify a different
embedding model (same provider, different model name/dimensions/context).

## Architecture

### Configuration

File: `$PROJECT/.tea-rags` (YAML)

```yaml
collections:
  docs:
    path: "docs/"
    excludeFromProject: true
    embedding:
      model: "jina-embeddings-v2-base-en"
      dimensions: 768
      contextLength: 8192
  specs:
    path: "docs/superpowers/specs/"
    # excludeFromProject: false (default — indexed in both main and sub)
    embedding:
      model: "unclemusclez/jina-embeddings-v2-base-code"
      dimensions: 768
      contextLength: 8192
```

**Fields:**

| Field                     | Type    | Default | Description                                        |
| ------------------------- | ------- | ------- | -------------------------------------------------- |
| `path`                    | string  | —       | Required. Relative path from project root          |
| `excludeFromProject`      | boolean | `false` | If `true`, directory excluded from main `code_xxx` |
| `embedding.model`         | string  | global  | Model name passed to the global embedding provider |
| `embedding.dimensions`    | number  | global  | Vector dimensions for the collection               |
| `embedding.contextLength` | number  | global  | Context window size for chunking decisions         |

### MCP Tool Parameters

Same configuration available as `index_codebase` parameters:

```
index_codebase({
  path: "/project",
  collection: "docs",                    // target specific sub-collection
  subcollection: {                       // or define inline (no config file)
    path: "docs/",
    excludeFromProject: true,
    embedding: { model: "...", dimensions: 768, contextLength: 8192 }
  }
})
```

When `collection` is specified without `subcollection`, indexes only that
sub-collection from the `.tea-rags` config.

### Collection Naming

Pattern: `sub_{projectHash}_{collectionName}`

Example: `sub_27622aef_docs`

Uses the same alias mechanism as code collections for zero-downtime reindex
(`sub_27622aef_docs` → `sub_27622aef_docs_v1`).

### Pipeline

Sub-collections go through a **simplified pipeline**:

```
File scan (.gitignore aware)
  → AST chunking (tree-sitter, same hooks as code)
  → Embedding (per-collection model params)
  → Qdrant upsert
  → Merkle snapshot save
```

**Included:** file scanning, AST-aware chunking, Merkle-based incremental sync,
`EmbeddingModelGuard` per-collection, alias-based zero-downtime reindex.

**Excluded:** git enrichment, schema drift monitor, signal distributions. These
are unnecessary for documentation/knowledge-base use cases.

### Embedding Per-Collection

The global `EmbeddingProvider` (Ollama, ONNX, OpenAI, etc.) remains a singleton.
Sub-collections pass different model parameters to the same provider:

```
provider.embed(text, { model: "jina-v2-base-en", dimensions: 768 })
```

`EmbeddingModelGuard` validates per-collection — prevents mixing models within
the same sub-collection. Different sub-collections can use different models.

### Indexing Flow

**Default (`index_codebase` without `--collection`):**

1. Read `.tea-rags` config
2. Collect `excludeFromProject: true` paths → add to main collection's ignore
   patterns
3. Index main collection (existing flow)
4. For each sub-collection in config → index with simplified pipeline
5. Each sub-collection has independent Merkle snapshot → independent incremental
   reindex

**Targeted (`index_codebase --collection=docs`):**

1. Read `.tea-rags` config, find `docs` entry
2. Index only that sub-collection
3. Main collection untouched

### Search

Existing `semantic_search` / `hybrid_search` already accept `collection`
parameter — works as-is for querying individual sub-collections.

New parameter for search tools:

```
semantic_search({
  collection: "code_27622aef",
  query: "authentication flow",
  includeSubCollections: true          // searches main + all sub-collections
})
```

Results from all collections merged and sorted by score. Each result tagged with
`collection` field for disambiguation.

### Skill: `tea-rags:add-collection`

Interactive skill for generating `.tea-rags` config:

1. Asks for directory path (with autocomplete from project structure)
2. Asks whether to exclude from main collection (default: no)
3. Asks for embedding model (default: current global model)
4. Validates path exists, model is available on the provider
5. Writes/updates `.tea-rags` file
6. Offers to run initial indexing

Also accepts parameters for non-interactive use:
`/tea-rags:add-collection path=docs/ model=jina-v2 exclude=true`

### Website Documentation

New page at `website/docs/usage/sub-collections.md`:

- What sub-collections are and when to use them
- `.tea-rags` config reference
- MCP tool usage examples
- Per-collection embedding model setup
- Incremental indexing behavior
- Search across collections (`includeSubCollections`)
- Cold Memory pattern (linking to the Codified Context paper concept)

## Design Decisions

| Decision                                    | Rationale                                              |
| ------------------------------------------- | ------------------------------------------------------ |
| No git enrichment for sub-collections       | Excessive for docs/specs; simplifies pipeline          |
| Same chunking pipeline                      | Consistency; AST hooks already handle markdown         |
| Global provider, per-collection model       | Avoids multi-provider complexity; covers 99% of cases  |
| Config file + MCP params                    | Config for persistent setup, MCP for ad-hoc            |
| `excludeFromProject` not `indexWithProject` | Opt-out is safer default — existing behavior preserved |
| Alias-based zero-downtime reindex           | Same proven mechanism as code collections              |
| Independent Merkle snapshots                | Sub-collections change at different rates than code    |

## Scope Exclusions

- No per-collection git enrichment toggle (always off)
- No per-collection chunking strategy override (auto-detect by extension)
- No cross-collection reranking (search merges by score only)
- No nested sub-collection inheritance (each entry is independent)

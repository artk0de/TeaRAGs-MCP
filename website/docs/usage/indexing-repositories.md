---
title: Indexing Repositories
sidebar_position: 3
---

import AiQuery from '@site/src/components/AiQuery';

# Indexing Repositories

This page covers everything you need to configure, run, and maintain a code
index with TeaRAGs.

## Environment Variables

All code-vectorization settings are controlled via environment variables passed
to the MCP server.

<details>
<summary>Indexing variables reference</summary>

| Variable                    | Description                                                                                                                               | Default |
| --------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- | ------- |
| `INGEST_CHUNK_SIZE`         | Maximum chunk size in characters. Larger = more context per chunk; smaller = more granular search results.                                | 2500    |
| `INGEST_CHUNK_OVERLAP`      | Overlap between adjacent chunks in characters. Prevents loss of context at chunk boundaries.                                              | 300     |
| `INGEST_ENABLE_AST`         | Use AST-aware chunking (tree-sitter) instead of line-based splitting. Preserves semantic boundaries like functions, classes, and methods. | true    |
| `INGEST_ENABLE_HYBRID`      | Provision BM25 sparse vectors. Required to use the `hybrid_search` tool.                                                                  | true    |
| `EMBEDDING_TUNE_BATCH_SIZE` | Chunks per embedding batch sent to the provider. Higher = throughput; lower = less memory.                                                | auto    |
| `TRAJECTORY_GIT_ENABLED`    | Enrich every chunk with git signals: authors, commit count, bug-fix rate, age, task IDs. Required for `hotspots` / `techDebt` / `ownership` / `securityAudit` / etc. presets. Silently skipped for non-git directories. | true    |

Legacy names (`CODE_CHUNK_SIZE`, `CODE_CHUNK_OVERLAP`, `CODE_ENABLE_AST`, `CODE_ENABLE_HYBRID`, `CODE_BATCH_SIZE`, `CODE_ENABLE_GIT_METADATA`) still work as fallbacks but are deprecated.

**Per-index overrides** (pass to `index_codebase` directly instead of env):

- `extensions: string[]` — e.g., `[".proto", ".graphql", ".prisma"]`
- `ignorePatterns: string[]` — e.g., `["**/*.generated.ts", "**/dist/**"]`

See also the full [Configuration Variables](/config/environment-variables) page
for embedding, Qdrant batch pipeline, and performance variables.

</details>

## How Chunking Works

TeaRAGs splits source files into **chunks** — self-contained code fragments that
become individual vectors in the search index. The chunking strategy directly
affects search quality: well-bounded chunks return precise, meaningful results;
poorly split chunks return noisy, incomplete fragments.

### AST-Aware Chunking (default)

Enabled by default (`INGEST_ENABLE_AST=true`). Uses
[tree-sitter](https://tree-sitter.github.io/tree-sitter/) to parse the code into
an Abstract Syntax Tree, then splits along **semantic boundaries** — functions,
classes, methods, interfaces.

**Why it matters:**

- A function stays as one chunk, not split in the middle of a loop
- Class methods are extracted as individual chunks with parent class context
  preserved (`parentName`, `parentType` metadata)
- Comments and decorators stay attached to the code they describe
- Large classes are automatically decomposed: methods become individual chunks,
  non-method body code is extracted separately

**Two-level extraction:**

1. **Top-level nodes** — functions, classes, modules, interfaces are identified
   as chunk candidates
2. **Child extraction** — if a container (class/module) exceeds
   `2x INGEST_CHUNK_SIZE`, its methods are extracted as individual chunks while
   preserving parent context in metadata

**Fallback:** If a language has no tree-sitter grammar, or a node is still too
large after child extraction, TeaRAGs falls back to character-based splitting
with overlap — trying to break at empty lines or closing braces.

:::tip

AST-aware chunking is the recommended mode for all code. Disable it
(`INGEST_ENABLE_AST=false`) only for plain-text or unstructured files where
tree-sitter adds no value.

:::

### Embedding Dimensions

The embedding dimension is determined automatically based on your model — no
configuration needed in most cases.

| Provider | Model                                                 | Dimensions |
| -------- | ----------------------------------------------------- | ---------- |
| Ollama   | `unclemusclez/jina-embeddings-v2-base-code` (default) | 768        |
| Ollama   | `nomic-embed-text`                                    | 768        |
| Ollama   | `mxbai-embed-large`                                   | 1024       |
| OpenAI   | `text-embedding-3-small`                              | 1536       |
| Cohere   | `embed-english-v3.0`                                  | 1024       |
| Voyage   | `voyage-code-2`                                       | 1536       |

Override with `EMBEDDING_DIMENSIONS` only if your model is not in the built-in
registry.

:::warning

Changing the embedding model or dimensions after indexing requires a
**full reindex** — existing vectors are incompatible with a different dimension.

:::

## File Filtering

### Built-in Exclusions

The indexer automatically skips common non-source directories and files:

- `node_modules/`, `vendor/`, `.git/`, `dist/`, `build/`, `coverage/`
- Binary files, images, lock files, and minified bundles

### Using .contextignore

Create a `.contextignore` file in your project root to define project-specific
exclusions. The syntax is identical to `.gitignore`:

```gitignore
# Exclude test files from the index
**/test/**
**/*.test.ts
**/*.spec.ts

# Exclude generated code
*.generated.ts
**/dist/**

# Exclude fixtures and mocks
**/fixtures/**
**/mocks/**
**/__tests__/**
```

`.contextignore` rules are applied **in addition to** `.gitignore`. If a file is
ignored by either, it will not be indexed.

### Custom Extensions & Ignore Patterns

Pass per-index overrides to `index_codebase` instead of global env vars:

```json
{
  "path": "/project",
  "extensions": [".proto", ".graphql", ".prisma"],
  "ignorePatterns": ["**/*.generated.ts", "**/dist/**"]
}
```

For team-wide rules use `.contextignore` (see [Ignoring Files](/usage/ignoring-files)).

## Indexing Workflow

### Full Index

Run a full index the first time you set up a codebase:

<AiQuery>/tea-rags:index [path]</AiQuery>

The indexer will:

1. Discover files (respecting `.gitignore`, `.contextignore`, built-in
   exclusions)
2. Parse each file with the appropriate language parser (AST or line-based)
3. Split into chunks preserving semantic boundaries
4. Generate vector embeddings in batches
5. Upsert chunks into a Qdrant collection
6. Save a file-hash snapshot for future incremental updates

### Incremental Reindex

After the initial index, `/tea-rags:index` auto-detects and runs an incremental
reindex — only added, modified, and deleted files are processed:

<AiQuery>/tea-rags:index [path]</AiQuery>

Significantly faster than a full re-index — only the files that changed since
the last snapshot get re-embedded.

### Force Reindex (Zero-Downtime)

If you change chunking settings (e.g., `INGEST_CHUNK_SIZE`) or embedding model,
the existing chunks are no longer compatible. Use the force-reindex skill — it
builds a new versioned collection in the background while search stays available
on the current one, then atomically switches:

<AiQuery>/tea-rags:force-reindex [path]</AiQuery>

Requires explicit user confirmation. See
[Skills](/usage/skills/) for details.

### Check Index Status

Your agent calls `get_index_status` directly (no dedicated skill):

<AiQuery>Show me stats for the current index</AiQuery>

For percentile-based **signal thresholds** (label maps that map raw git metrics
to `low` / `typical` / `high` / `extreme` in _your_ codebase), use the
`get_index_metrics` tool — see [MCP Tools Atlas](/usage/advanced/mcp-tools#get_index_metrics).

The status endpoint reports three states:

| Status        | Meaning                                                                           |
| ------------- | --------------------------------------------------------------------------------- |
| `not_indexed` | No index exists for this path. Run indexing first.                                |
| `indexing`    | Indexing is in progress. Shows the number of chunks processed so far.             |
| `indexed`     | Index is ready. Returns collection name, chunk count, and last-updated timestamp. |

Example response when indexed:

```json
{
  "isIndexed": true,
  "status": "indexed",
  "collectionName": "code_a3f8d2e1",
  "chunksCount": 1823,
  "lastUpdated": "2025-01-30T10:15:00Z"
}
```

## Best Practices

### 1. Optimize Chunk Size

The right chunk size depends on your codebase style:

| Codebase Type            | Recommended `INGEST_CHUNK_SIZE` | Recommended `INGEST_CHUNK_OVERLAP` |
| ------------------------ | ----------------------------- | -------------------------------- |
| Small, focused functions | 1500 - 2000                   | 200                              |
| Large classes / modules  | 3000 - 4000                   | 400                              |
| Documentation (Markdown) | 2000 - 2500                   | 300                              |

Smaller chunks produce more granular results but lose surrounding context.
Larger chunks preserve context but may dilute relevance if the chunk contains
unrelated code. Start with the defaults (2500 / 300) and adjust based on search
quality.

### 2. Filter Aggressively

Exclude noise from the index to improve both speed and search relevance:

```gitignore
# .contextignore
**/vendor/**
**/node_modules/**
**/*.min.js
**/*.bundle.js
**/coverage/**
**/.git/**
**/dist/**
**/build/**
```

Every excluded file saves embedding time and reduces index size.

### 3. Choose the Right Embedding Model

| Use Case                   | Recommended Model                                    |
| -------------------------- | ---------------------------------------------------- |
| General code search        | `nomic-embed-text` (Ollama)                          |
| Code-specialized (default) | `unclemusclez/jina-embeddings-v2-base-code` (Ollama) |
| Multilingual code          | `jina-embeddings-v2-base-code`                       |
| Maximum accuracy           | `voyage-code-2` (Voyage AI)                          |

For most projects, the default Jina code embeddings via Ollama offer the best
balance of quality, speed, and privacy. See the
[Embedding Providers](/config/providers) page for detailed comparisons.

### 4. Use Incremental Updates

After the initial full index, always prefer incremental reindex. `/tea-rags:index`
handles both cases automatically:

<AiQuery>/tea-rags:index [path]</AiQuery>

This avoids re-embedding unchanged files and keeps your index fresh with minimal
latency.

### 5. Monitor Index Status

Before searching, verify the index is ready:

<AiQuery>Show me stats for the current index</AiQuery>

This is especially useful after long-running indexing operations on large
codebases (10k+ files).

### 6. Enable Git Metadata When Needed

Git metadata enrichment (`TRAJECTORY_GIT_ENABLED=true`) adds significant value
for analytics — ownership reports, tech debt detection, hotspot analysis.
Enrichment runs concurrently with embedding and does not increase indexing time.
Enable it when you plan to use rerank presets like `techDebt`, `hotspots`,
`ownership`, or `codeReview`.

## Troubleshooting

### Search Returns No Results

1. **Check index status**: ask your agent to show index stats and confirm the
   status is `indexed` (not `indexing` or `not_indexed`)
2. **Verify files are not ignored**: check `.gitignore`, `.contextignore`, and
   the `ignorePatterns` parameter for overly broad patterns
3. **Broaden your query**: semantic search works best with natural language;
   instead of `"getUserById"`, try `"user retrieval by ID"`
4. **Check the collection name**: if you moved or renamed the project directory,
   the collection name hash will change and a new index is needed

### Slow Indexing

1. **Use local Ollama** instead of a cloud provider to avoid network latency and
   rate limits:
   ```bash
   export EMBEDDING_PROVIDER=ollama
   ```
2. **Increase batch size** if your system has enough memory:
   ```bash
   export EMBEDDING_TUNE_BATCH_SIZE=200
   ```
3. **Exclude large or binary files** that produce low-value chunks (lock files,
   minified bundles, vendored code)
4. **Increase pipeline concurrency** for cloud providers with spare rate-limit
   headroom:
   ```bash
   export INGEST_PIPELINE_CONCURRENCY=4
   ```

### Memory Issues

1. **Reduce chunk size** to lower per-batch memory:
   ```bash
   export INGEST_CHUNK_SIZE=1500
   ```
2. **Reduce batch size** to process fewer chunks at once:
   ```bash
   export EMBEDDING_TUNE_BATCH_SIZE=50
   ```
3. **Index subdirectories separately** for very large monorepos — ask your agent
   to index each service path individually

### Files Not Being Indexed

1. Check that the file extension is in the supported list or added via the
   `extensions` parameter to `index_codebase`
2. Verify the file is not matched by `.gitignore`, `.contextignore`, or the
   `ignorePatterns` parameter
3. Ensure the file is not empty or binary

For more troubleshooting scenarios see
[Troubleshooting](/operations/troubleshooting-and-error-codes) and
[Recovery & Reindexing](/operations/recovery-reindexing).

## See Also

- [Skills](/usage/skills/) — `/tea-rags:index`, `/tea-rags:force-reindex`
- [MCP Tools Atlas](/usage/advanced/mcp-tools) — `index_codebase`,
  `get_index_status`, `get_index_metrics`, `clear_index` parameters
- [Collections](/usage/advanced/collections) — multi-project workflow and
  collection naming
- [Ignoring Files](/usage/ignoring-files) — `.contextignore` and built-in
  exclusions

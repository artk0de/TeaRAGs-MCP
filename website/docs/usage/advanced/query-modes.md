---
title: Query Modes
sidebar_position: 2
---

import AiQuery from '@site/src/components/AiQuery';

# Query Modes

TeaRAGs provides three search tools, each backed by a different MCP tool and
optimized for different workflows.

| Mode                                | MCP Tool          | Output                             | Best for                                               |
| ----------------------------------- | ----------------- | ---------------------------------- | ------------------------------------------------------ |
| [Code Search](#code-search)         | `search_code`     | Human-readable text                | Day-to-day development                                 |
| [Semantic Search](#semantic-search) | `semantic_search` | Structured JSON with full metadata | Analytics, reports, advanced filtering                 |
| [Hybrid Search](#hybrid-search)     | `hybrid_search`   | Structured JSON with full metadata | Queries mixing natural language with exact identifiers |

## Code Search

**MCP tool:** `search_code`

The primary interface for everyday code search. It wraps semantic search with
sensible defaults, accepts shorthand parameters for common filters, and returns
**human-readable text** — ready to paste into a conversation.

### What you get

- File path and line numbers
- Code snippets with syntax context
- Relevance scores
- Language information

### What you don't get (use `semantic_search` instead)

- Chunk IDs
- Structured git metadata (authors array, taskIds, timestamps)
- `metaOnly` mode
- Full Qdrant filter syntax
- Advanced rerank presets (techDebt, hotspots, ownership, etc.)

### Rerank presets

| Preset      | Boost                             |
| ----------- | --------------------------------- |
| `relevance` | Default semantic similarity       |
| `recent`    | Recently modified code            |
| `stable`    | Low-churn, stable implementations |

Custom weights are also supported:

```json
{ "custom": { "similarity": 0.7, "recency": 0.3 } }
```

### Examples

<AiQuery>How does user authentication work?</AiQuery> <AiQuery>Find error
handling in TypeScript files only</AiQuery> <AiQuery>Search for request
validation in the API directory</AiQuery> <AiQuery>Find recent changes by
Alice</AiQuery>

### Workflow

#### 1. Index a codebase

<AiQuery>Index this codebase for semantic search</AiQuery>

#### 2. Search with natural language

<AiQuery>How does user authentication work?</AiQuery>

#### 3. Incremental updates

After making changes to your codebase:

<AiQuery>Update the search index with my recent changes</AiQuery>

#### 4. Check index status

<AiQuery>Show me stats for the current index</AiQuery>

#### 5. Force re-index

If you need a complete re-index (for example, after changing chunking settings):

<AiQuery>Reindex the entire codebase from scratch</AiQuery>

### Multi-language projects

The indexer automatically detects languages across a full-stack project
(TypeScript, React, Vue, Python, Go, Java, JSON, YAML, Bash, etc.):

<AiQuery>Search for database connection pooling across all languages</AiQuery>

### Custom ignore patterns

Create a `.contextignore` file in your project root to exclude files from
indexing:

```gitignore
# .contextignore
**/test/**
**/*.test.ts
**/*.spec.ts
**/fixtures/**
**/mocks/**
**/__tests__/**
**/coverage/**
*.generated.ts
```

## Semantic Search

**MCP tool:** `semantic_search`

Converts your query into a vector embedding and finds code chunks with the
closest meaning. Unlike `search_code`, returns **structured JSON** with full
metadata — chunk IDs, git signals, import lists — and supports advanced features
like `metaOnly`, Qdrant native filters, and all rerank presets.

### What you get (beyond Code Search)

| Feature                       | `search_code`                 | `semantic_search`                       |
| ----------------------------- | ----------------------------- | --------------------------------------- |
| Human-readable output         | yes                           | —                                       |
| Structured JSON output        | —                             | yes                                     |
| Chunk ID (UUID)               | —                             | yes                                     |
| Full git metadata in response | —                             | yes (authors[], taskIds[], timestamps)  |
| `metaOnly` mode               | —                             | yes                                     |
| Qdrant native filter syntax   | —                             | yes                                     |
| `pathPattern` (glob)          | yes                           | yes                                     |
| Rerank presets                | 4 (relevance, recent, stable, proven) | 15 (techDebt, hotspots, ownership, dangerous, bugHunt, ...) |
| Requires collection name      | no (uses path)                | no (path or collection)                 |

### When to use

- **Analytics** — tech debt reports, hotspot detection, ownership analysis
- **Need structured data** — chunk IDs for downstream processing, git metadata
  for reports
- **Complex filtering** — Qdrant filter syntax with range, match, boolean logic
- **Metadata only** — file discovery, codebase structure scans without reading
  content

### Rerank presets

All [reranking presets](/usage/advanced/git-enrichments#reranking-presets) are
available:

| Preset           | Use case                    |
| ---------------- | --------------------------- |
| `relevance`      | Default semantic similarity |
| `techDebt`       | Legacy code assessment      |
| `hotspots`       | Bug-prone, high-churn areas |
| `codeReview`     | Recent changes              |
| `onboarding`     | Docs + stable code          |
| `securityAudit`  | Old critical code           |
| `refactoring`    | Refactor candidates         |
| `ownership`      | Knowledge silos             |
| `dangerous`      | High-risk bug-prone code    |
| `bugHunt`        | Active bug investigation    |
| `proven`         | Battle-tested templates     |

### `metaOnly` mode

Returns metadata without content — significantly reduces response size:

```json
{
  "score": 0.87,
  "relativePath": "src/auth/login.ts",
  "startLine": 45,
  "endLine": 89,
  "language": "typescript",
  "chunkType": "function",
  "name": "handleLogin",
  "imports": ["express", "jsonwebtoken", "./utils"],
  "git": { "ageDays": 5, "commitCount": 12, "dominantAuthor": "alice" }
}
```

Use for file discovery, analytics, codebase structure scans, or ownership
reports.

### Characteristics

| Aspect        | Detail                                                    |
| ------------- | --------------------------------------------------------- |
| **Input**     | Natural language query                                    |
| **Matching**  | Vector cosine similarity                                  |
| **Strengths** | Understands synonyms, intent, and cross-language patterns |
| **Weakness**  | May miss exact keywords like function names or acronyms   |

## Hybrid Search

**MCP tool:** `hybrid_search`

Combines **semantic (vector)** similarity with **keyword (BM25)** matching and
merges rankings via **Reciprocal Rank Fusion (RRF)**. Returns the same
structured JSON as `semantic_search`, with the same features (metaOnly, filters,
all rerank presets).

### When to use

Hybrid search is ideal when your query mixes natural language with technical
identifiers:

- **Function or variable names** — "getUserById authentication"
- **Acronyms and technical terms** — "JWT token validation"
- **Error messages** — "ECONNREFUSED database connection"
- **Mixed queries** — "OAuth2 authorization flow"

### How it works

1. **Dense vector generation** — your query is embedded using the configured
   provider (Ollama, OpenAI, etc.)
2. **Sparse vector generation** — the query is tokenized and BM25 scores are
   calculated
3. **Parallel search** — both vector types are searched simultaneously in Qdrant
4. **Result fusion** — RRF combines rankings from both searches
5. **Final ranking** — merged results with combined relevance scores

### RRF formula

Rankings from the semantic and keyword searches are fused using Reciprocal Rank
Fusion:

```
score = sum( 1 / (k + rank_i) )   where k = 60 (default)
```

RRF does not require score normalization and is robust to differences in score
scales between the two retrieval methods.

### BM25 sparse vectors

The server uses a lightweight BM25 implementation for sparse vectors:

- **Tokenization**: lowercase + whitespace splitting
- **IDF scoring**: inverse document frequency
- **Parameters**: k1 = 1.2, b = 0.75

### Comparison: Semantic vs Hybrid

| Query                            | Semantic Search                                              | Hybrid Search                                                                                |
| -------------------------------- | ------------------------------------------------------------ | -------------------------------------------------------------------------------------------- |
| "JWT authentication"             | Finds authentication concepts; may miss exact "JWT" matches  | Finds both semantically related auth docs **and** exact "JWT" keyword matches                |
| "authenticateUser function"      | Understands the concept but may miss the exact function name | Keyword match catches `authenticateUser` precisely; semantic match catches related auth code |
| "OAuth2 authentification" (typo) | Understands "authentification" as "authentication"           | Keyword match catches "OAuth2" exactly; semantic match handles the typo gracefully           |

### Enabling hybrid search

Hybrid search must be enabled at collection creation time:

<AiQuery>Create a collection with hybrid search enabled</AiQuery>

Existing collections cannot be converted to hybrid after creation.

### Performance considerations

- **Storage**: hybrid collections require more space (dense + sparse vectors)
- **Indexing**: slightly slower due to dual vector generation
- **Query time**: two parallel searches plus RRF fusion
- **Scalability**: Qdrant optimizes both vector types efficiently

## Filtered Search

Filters narrow search results by metadata — language, file path, code structure,
git churn metrics, and more. Filters work with all three search modes.

See **[Filters](/usage/advanced/filters)** for the complete reference: filter
syntax, operators, filterable fields, git churn filters, path patterns, and
examples.

<AiQuery>Find error handling in TypeScript files only</AiQuery> <AiQuery>Show me
high-churn code in the auth directory</AiQuery>

## Choosing the Right Mode

| Situation                                                      | Recommended Mode                              |
| -------------------------------------------------------------- | --------------------------------------------- |
| Day-to-day development: search, index, reindex                 | `search_code`                                 |
| Exploring unfamiliar code by concept                           | `search_code` or `semantic_search`            |
| Analytics: tech debt, hotspots, ownership reports              | `semantic_search` with rerank presets         |
| Need chunk IDs or structured git metadata                      | `semantic_search`                             |
| Metadata-only scans (file discovery, structure)                | `semantic_search` with `metaOnly`             |
| Searching for exact function names mixed with concepts         | `hybrid_search`                               |
| Narrowing results to a specific language, author, or directory | Any mode + [filters](/usage/advanced/filters) |

:::info

For complete tool parameters, response formats, and rerank weight keys,
see the **[Tools Schema](/api/tools)**.

:::
> Parts of this page are adapted from examples originally written by
> [Martin Halder](https://github.com/mhalder) in
> [qdrant-mcp-server](https://github.com/mhalder/qdrant-mcp-server).

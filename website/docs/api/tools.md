---
title: Tools
sidebar_position: 1
---

## Collection Management

| Tool                  | Description                                                          |
| --------------------- | -------------------------------------------------------------------- |
| `create_collection`   | Create collection with specified distance metric (Cosine/Euclid/Dot) |
| `list_collections`    | List all collections                                                 |
| `get_collection_info` | Get collection details and statistics                                |
| `delete_collection`   | Delete collection and all documents                                  |

## Document Operations

| Tool               | Description                                                                   |
| ------------------ | ----------------------------------------------------------------------------- |
| `add_documents`    | Add documents with automatic embedding (supports string/number IDs, metadata) |
| `semantic_search`  | Natural language search with optional metadata filtering                      |
| `hybrid_search`    | Hybrid search combining semantic and keyword (BM25) search with RRF           |
| `delete_documents` | Delete specific documents by ID                                               |

## Code Vectorization

| Tool               | Description                                                                |
| ------------------ | -------------------------------------------------------------------------- |
| `index_codebase`   | Index a codebase for semantic code search with AST-aware chunking          |
| `search_code`      | Search indexed codebase using natural language queries                     |
| `reindex_changes`  | Incrementally re-index only changed files (detects added/modified/deleted) |
| `get_index_status` | Get indexing status and statistics for a codebase                          |
| `clear_index`      | Delete all indexed data for a codebase                                     |

## Similarity Search

| Tool           | Description                                                                 |
| -------------- | --------------------------------------------------------------------------- |
| `find_similar` | Find code similar to given chunks or code blocks using Qdrant recommend API |

### `find_similar` — Find Similar Code

Find chunks similar to given examples (positive) and dissimilar to others
(negative). Works with chunk IDs from previous search results and/or raw code
blocks.

**Parameters:**

| Parameter             | Type               | Required | Default      | Description                                                      |
| --------------------- | ------------------ | -------- | ------------ | ---------------------------------------------------------------- |
| `positiveIds`         | `string[]`         | no\*     | `[]`         | Chunk IDs from previous search results to find similar code      |
| `positiveCode`        | `string[]`         | no\*     | `[]`         | Raw code blocks to find similar code (embedded on-the-fly)       |
| `negativeIds`         | `string[]`         | no       | `[]`         | Chunk IDs to push results away from                              |
| `negativeCode`        | `string[]`         | no       | `[]`         | Raw code blocks to push results away from                        |
| `strategy`            | `string`           | no       | `best_score` | Recommend strategy: `best_score`, `average_vector`, `sum_scores` |
| `filter`              | `object`           | no       | —            | Qdrant native filter (must/should/must_not)                      |
| `pathPattern`         | `string`           | no       | —            | Glob pattern to filter results by file path                      |
| `fileExtensions`      | `string[]`         | no       | —            | Filter by file extensions (e.g. `[".ts", ".js"]`)                |
| `rerank`              | `string \| object` | no       | `relevance`  | Rerank preset or custom weights                                  |
| `limit`               | `number`           | no       | `10`         | Max results to return                                            |
| `offset`              | `number`           | no       | `0`          | Offset for pagination                                            |
| `metaOnly`            | `boolean`          | no       | `false`      | Return metadata only (no content)                                |
| `collection` / `path` | `string`           | yes      | —            | Project path or collection name                                  |

\*At least one positive or negative input is required. `average_vector` and
`sum_scores` strategies require at least one positive input.

**Strategy descriptions:**

- **`best_score`** (default) — Scores each candidate against every example
  independently. Most flexible, supports negative-only queries.
- **`average_vector`** — Averages all positive vectors, subtracts negative.
  Fastest. Requires at least one positive.
- **`sum_scores`** — Sums scores across all examples. Middle ground. Requires at
  least one positive.

**Example — find more code like a previous result:**

```json
{
  "collection": "code_abc123",
  "positiveIds": ["chunk-uuid-from-search-result"],
  "limit": 10
}
```

**Example — find code similar to a snippet but not like another:**

```json
{
  "collection": "code_abc123",
  "positiveCode": ["async function handleAuth(req, res) { ... }"],
  "negativeCode": ["function legacyAuth(callback) { ... }"],
  "fileExtensions": [".ts"],
  "rerank": "codeReview"
}
```

## Search Parameters

### `rerank` — Result Reranking

Reorder search results based on git metadata signals.

**For `semantic_search` / `hybrid_search` (analytics):**

| Preset           | Use Case                     | Signals                                                                |
| ---------------- | ---------------------------- | ---------------------------------------------------------------------- |
| `relevance`      | Default semantic similarity  | similarity only                                                        |
| `techDebt`       | Find legacy problematic code | age + churn + bugFix + volatility                                      |
| `hotspots`       | Bug hunting                  | chunkChurn + chunkRelativeChurn + burstActivity + bugFix + volatility  |
| `codeReview`     | Review recent changes        | recency + burstActivity + density + chunkChurn                         |
| `onboarding`     | Entry points for new devs    | documentation + stability                                              |
| `securityAudit`  | Old code in critical paths   | age + pathRisk + bugFix + ownership + volatility                       |
| `refactoring`    | Refactoring candidates       | chunkChurn + relativeChurnNorm + chunkSize + volatility + bugFix + age |
| `ownership`      | Knowledge transfer           | ownership + knowledgeSilo (flags single-author code)                   |
| `impactAnalysis` | Dependency analysis          | imports count                                                          |

**For `search_code` (practical development):**

| Preset      | Use Case                            | Boost           |
| ----------- | ----------------------------------- | --------------- |
| `relevance` | Default semantic similarity         | —               |
| `recent`    | Find recently modified code         | low ageDays     |
| `stable`    | Find stable implementation examples | low commitCount |

**Custom weights:**

```json
{ "custom": { "similarity": 0.7, "recency": 0.3 } }
```

Available weight keys: `similarity`, `recency`, `stability`, `churn`, `age`,
`ownership`, `chunkSize`, `documentation`, `imports`, `bugFix`, `volatility`,
`density`, `chunkChurn`, `relativeChurnNorm`, `burstActivity`, `pathRisk`,
`knowledgeSilo`, `chunkRelativeChurn`

### `metaOnly` — Metadata Only Response

For `semantic_search` / `hybrid_search` only. Returns metadata without content:

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

`imports` contains file-level imports (inherited by all chunks from that file).
Used by `impactAnalysis` reranking to boost files with many dependencies.

Use for file discovery, analytics, or reducing response size.

## Resources

- `qdrant://collections` — list all collections
- `qdrant://collection/{name}` — collection details

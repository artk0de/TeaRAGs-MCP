---
title: Filters
sidebar_position: 6
---

import AiQuery from '@site/src/components/AiQuery';

# Filters

Filters narrow search results by metadata — language, file path, code structure, git churn, authorship — **before** semantic ranking. Without filters, semantic search returns the best matches from the entire index. With filters, you restrict the candidate set first, then rank within that subset.

**Why it matters:** In a large codebase with thousands of chunks, a query like "error handling" could return results from tests, documentation, utilities, and production code all mixed together. Filters let you say "only TypeScript, only in `src/api/`, only recently changed" — so every result is relevant to the task at hand.

Filters work with all three search modes: [Code Search](/usage/query-modes#code-search), [Semantic Search](/usage/query-modes#semantic-search), and [Hybrid Search](/usage/query-modes#hybrid-search).

## Filter Syntax

TeaRAGs uses Qdrant's native filter syntax based on boolean logic. Every filter is an object with one or more boolean operators:

```json
{
  "must": [],      // AND — all conditions must be true
  "should": [],    // OR  — at least one condition must be true
  "must_not": []   // NOT — none of the conditions may be true
}
```

You can combine all three in a single filter. Conditions inside `must` are ANDed together; conditions inside `should` are ORed.

### Match Filter

Exact match on a metadata field. Use when you know the exact value — a specific language, a specific author, a chunk type.

```json
{ "key": "language", "match": { "value": "typescript" } }
```

**When to use:** filtering by language, chunk type (`function`, `class`, `interface`), boolean flags (`isDocumentation`), or exact author name.

### Text Match

Partial or substring match. Use when you want to match part of a string — a directory name inside a path, a keyword in a symbol name.

```json
{ "key": "relativePath", "match": { "text": "auth" } }
```

**When to use:** filtering by path fragments when `pathPattern` glob syntax is not enough, or matching partial symbol names.

### Range Filter

Numeric comparison. Use for metrics — commit counts, age in days, churn ratios, bug-fix percentages.

```json
{ "key": "git.commitCount", "range": { "gte": 5, "lte": 50 } }
```

Available operators: `gt` (greater than), `gte` (greater or equal), `lt` (less than), `lte` (less or equal).

**When to use:** finding high-churn code, recent changes, old legacy code, ownership thresholds.

## Practical Examples

### Find TypeScript error handling

Narrow a semantic query to a single language:

```json
{
  "must": [{ "key": "language", "match": { "value": "typescript" } }]
}
```

<AiQuery>Find error handling in TypeScript files only</AiQuery>

### Find functions in a specific directory

Combine path and structure filters to find only function-level chunks inside your API layer:

```json
{
  "must": [
    { "key": "relativePath", "match": { "text": "src/api" } },
    { "key": "chunkType", "match": { "value": "function" } }
  ]
}
```

### Search across multiple languages (OR)

Use `should` to include results from several languages at once:

```json
{
  "should": [
    { "key": "language", "match": { "value": "typescript" } },
    { "key": "language", "match": { "value": "javascript" } }
  ]
}
```

### Exclude test and documentation files

Remove noise from results when you only care about production code:

```json
{
  "must_not": [
    { "key": "isDocumentation", "match": { "value": true } },
    { "key": "relativePath", "match": { "text": "test" } }
  ]
}
```

### Combined filter: recent TypeScript functions (AND + OR + NOT)

A real-world example — find recently changed functions in TypeScript or JavaScript, excluding docs:

```json
{
  "must": [
    { "key": "chunkType", "match": { "value": "function" } },
    { "key": "git.ageDays", "range": { "lte": 14 } }
  ],
  "should": [
    { "key": "language", "match": { "value": "typescript" } },
    { "key": "language", "match": { "value": "javascript" } }
  ],
  "must_not": [
    { "key": "isDocumentation", "match": { "value": true } }
  ]
}
```

## Path Pattern Filtering

The `pathPattern` parameter provides glob-style file path filtering as a simpler alternative to constructing Qdrant path filters. Uses [picomatch](https://github.com/micromatch/picomatch) syntax.

**When to use:** restricting search to a specific directory, file type, or excluding certain paths. Simpler than building a Qdrant filter for path matching.

```yaml
pathPattern: "**/workflow/**"        # All files in workflow directories
pathPattern: "src/**/*.ts"           # TypeScript files in src/
pathPattern: "{models,services}/**"  # Multiple directories at once
pathPattern: "!**/test/**"           # Exclude test directories
```

<AiQuery>Search for request validation in the API directory</AiQuery>
<AiQuery>Find authentication logic excluding test files</AiQuery>

:::tip
`pathPattern` is available in all three search modes and is often the fastest way to scope a search. Use it before reaching for full Qdrant filter syntax.
:::

## Git Churn Filters

These filters require `CODE_ENABLE_GIT_METADATA=true` during indexing. See [Git Enrichments](/usage/git-enrichments) for metric descriptions.

### Finding high-churn code

High commit count signals frequently modified code — potential hotspots or areas under active development.

```json
{ "key": "git.commitCount", "range": { "gte": 10 } }
```

**Use case:** identifying areas that change too often, candidates for stabilization or refactoring.

### Finding high relative churn

Relative churn normalizes commit count by file size — a 50-line file with 20 commits is more concerning than a 2000-line file with the same count.

```json
{ "key": "git.relativeChurn", "range": { "gte": 2.0 } }
```

**Use case:** a stronger signal for defect-prone code than raw commit count alone.

### Finding recent changes

Filter by age to find code modified within a specific window — useful during incidents, code reviews, or sprint retrospectives.

```json
{ "key": "git.ageDays", "range": { "lte": 7 } }
```

<AiQuery>Show me code changed in the last week</AiQuery>

**Use case:** incident response ("what changed recently near the failure?"), code review preparation.

### Finding legacy code

Old code that hasn't been touched in months may need review, especially if it's in a critical path.

```json
{ "key": "git.ageDays", "range": { "gte": 90 } }
```

**Use case:** tech debt discovery, security audit of stale code.

### Finding buggy code

High bug-fix rate means a large percentage of commits to this file were fixes — a quality signal.

```json
{ "key": "git.bugFixRate", "range": { "gte": 30 } }
```

**Use case:** quality assessment, identifying areas that need redesign rather than more patches.

### Ownership filters

Single-owner code is a bus-factor risk. Dominant author percentage shows how concentrated knowledge is.

```json
// Knowledge silos — one person owns 90%+ of commits
{ "key": "git.dominantAuthorPct", "range": { "gte": 90 } }

// Code by a specific author
{ "key": "git.dominantAuthor", "match": { "value": "Alice" } }
```

<AiQuery>Find code with a single dominant author</AiQuery>

**Use case:** knowledge transfer planning, onboarding risk assessment, identifying areas that need cross-training.

### Chunk-level churn

Function-level churn is more precise than file-level — a stable file may contain one hot function.

```json
// Hot functions (high function-level churn)
{ "key": "git.chunkCommitCount", "range": { "gte": 5 } }

// Functions that are mostly bug fixes
{ "key": "git.chunkBugFixRate", "range": { "gte": 50 } }
```

**Use case:** pinpointing the exact function that causes problems, not just the file.

### Combined churn filters

Real-world scenarios often combine multiple signals:

**Stable functions inside churny files** — the function is reliable even though the file changes a lot:

```json
{
  "must": [
    { "key": "git.commitCount", "range": { "gte": 20 } },
    { "key": "git.chunkCommitCount", "range": { "lte": 3 } }
  ]
}
```

**Old high-churn TypeScript code** — tech debt candidates:

```json
{
  "must": [
    { "key": "git.ageDays", "range": { "gte": 90 } },
    { "key": "git.commitCount", "range": { "gte": 5 } },
    { "key": "language", "match": { "value": "typescript" } }
  ]
}
```

<AiQuery>Show me high-churn code in the auth directory</AiQuery>

## Filterable Fields Reference

### Code metadata

| Field | Type | Description | Example use |
|-------|------|-------------|-------------|
| `relativePath` | string | Relative file path | Filter by directory or filename |
| `fileExtension` | string | File extension (e.g., `.ts`) | Target specific file types |
| `language` | string | Programming language | Narrow to one language |
| `startLine` | integer | Chunk start line | Find chunks in a specific line range |
| `endLine` | integer | Chunk end line | Find chunks in a specific line range |
| `chunkIndex` | integer | Position within file | Target the Nth chunk in a file |
| `isDocumentation` | boolean | True for markdown, README, etc. | Include or exclude docs |

### Chunk structure

| Field | Type | Description | Example use |
|-------|------|-------------|-------------|
| `name` | string | Symbol name (e.g., `MyClass`) | Find a specific named chunk |
| `chunkType` | string | `function`, `class`, `interface`, `block` | Narrow by code structure |
| `parentName` | string | Parent class or module name | Find methods of a specific class |
| `parentType` | string | Parent type (`class`, `module`, etc.) | Find all class methods vs module functions |
| `symbolId` | string | Unique symbol identifier | Target exact symbol (e.g., `MyClass.processData`) |
| `imports` | string[] | File-level imports | Find files importing a specific module |

### Git metadata

Requires `CODE_ENABLE_GIT_METADATA=true` during indexing.

| Field | Type | Description | Example use |
|-------|------|-------------|-------------|
| `git.commitCount` | integer | Commits touching this file | High-churn detection |
| `git.ageDays` | integer | Days since last modification | Recent changes or legacy code |
| `git.relativeChurn` | number | Churn normalized by file size | Stronger defect signal |
| `git.bugFixRate` | number | Bug-fix percentage (0-100) | Quality assessment |
| `git.dominantAuthor` | string | Author with most commits | Filter by author |
| `git.dominantAuthorPct` | number | Ownership concentration (0-100) | Knowledge silo detection |
| `git.authors` | string[] | All contributors | Multi-author queries |
| `git.contributorCount` | integer | Unique author count | Bus factor analysis |
| `git.taskIds` | string[] | Ticket IDs (JIRA, GitHub, etc.) | Trace code to tickets |
| `git.lastModifiedAt` | timestamp | Unix timestamp of last change | Precise date filtering |
| `git.firstCreatedAt` | timestamp | Unix timestamp of first commit | Find when code was introduced |
| `git.chunkCommitCount` | integer | Commits touching this chunk | Function-level churn |
| `git.chunkChurnRatio` | number | Chunk's share of file churn (0-1) | Hotspot within a file |
| `git.chunkBugFixRate` | number | Chunk bug-fix rate (0-100) | Function-level quality |
| `git.chunkAgeDays` | integer | Days since chunk was last modified | Function-level age |

## Filter + Rerank Combinations

Filters and [reranking presets](/usage/git-enrichments#reranking-presets) are complementary: **filters** narrow the candidate set, **reranking** scores relevance within it.

| Goal | Filter | Rerank | Why this combination |
|------|--------|--------|----------------------|
| Recent bugs in auth | `git.ageDays <= 14` + `pathPattern: **/auth/**` | `hotspots` | Narrow to recent auth code, then rank by bug signals |
| Old single-owner code | `git.ageDays >= 90` + `git.commitCount >= 5` | `ownership` | Find stale churny code, rank by knowledge concentration |
| Recently active TypeScript | `language: typescript` + `git.ageDays <= 30` | `codeReview` | Scope to TS, rank by recent activity intensity |
| Large stable functions | `chunkType: function` + `git.commitCount <= 3` | `onboarding` | Find reliable entry points for new team members |
| High-churn security code | `git.commitCount >= 10` + security path pattern | `securityAudit` | Target volatile security-sensitive areas |

## Best Practices

1. **Start broad, then narrow** — add filter conditions one at a time. Over-filtering returns zero results and gives no diagnostic signal.
2. **Use `pathPattern` for paths** — simpler than constructing Qdrant path filters. Covers most directory and extension-based filtering.
3. **Combine filters with semantic search** — filters narrow scope, vectors rank relevance. Neither alone is as powerful as both together.
4. **Use consistent types** — don't pass a string where a number is expected. `git.commitCount` is an integer, not `"5"`.
5. **Test filters incrementally** — validate a simple filter works before building complex boolean logic.
6. **Prefer chunk-level git filters** — `git.chunkCommitCount` is more precise than `git.commitCount` for identifying problem spots.

## Next Steps

- [Git Enrichments](/usage/git-enrichments) — metric descriptions and reranking presets
- [Query Modes](/usage/query-modes) — semantic, hybrid, and code search
- [Use Cases](/usage/use-cases) — real-world scenarios using filters and reranking
- [Search Strategies](/agent-integration/search-strategies) — how agents combine filters with reranking

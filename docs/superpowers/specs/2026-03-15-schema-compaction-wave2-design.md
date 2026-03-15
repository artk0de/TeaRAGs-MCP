# Schema Compaction Wave 2 — Tool Descriptions + Guide Resources

## Problem

Tool descriptions still contain verbose use cases, examples, and routing
guidance that inflate `tools/list` response. `filter.description` duplicates
content from the `filters` resource. Typed filter descriptions include "Use
for:" sections that belong in orchestration layer.

## Solution

Add 2 guide resources for detailed use cases/examples. Compact tool descriptions
to routing hints + resource links. Trim typed filter and `filter` descriptions.

## Resources (new)

| URI                                | Title          | Content                                                |
| ---------------------------------- | -------------- | ------------------------------------------------------ |
| `tea-rags://schema/search-guide`   | Search Guide   | Tool routing (which tool when), examples per tool      |
| `tea-rags://schema/indexing-guide` | Indexing Guide | Git metadata guide, indexing options, reindex workflow |

Both static markdown. Added to overview resource.

### Search Guide Content Skeleton

```markdown
# Search Guide

## Tool Routing

| Need                                           | Tool              |
| ---------------------------------------------- | ----------------- |
| Quick lookup for user request                  | `search_code`     |
| Structured JSON for analytics/reports          | `semantic_search` |
| Query with exact symbols, markers, identifiers | `hybrid_search`   |
| Top-N by signal without query                  | `rank_chunks`     |
| Find code similar to examples                  | `find_similar`    |

## search_code Examples

- "Complex code not touched in 30+ days" → query="complex logic", minAgeDays=30
- "What did John work on last week?" → author="John", maxAgeDays=7
- "High-churn authentication code" → query="authentication", minCommitCount=5
- "Code related to ticket TD-1234" → taskId="TD-1234"

## semantic_search Examples

- Ownership analysis → rerank="ownership", metaOnly=true
- Tech debt discovery → rerank="techDebt", filter by ageDays
- Impact analysis → rerank="impactAnalysis", metaOnly=true

## hybrid_search Examples

- Find TODOs/FIXMEs semantically → query="TODO FIXME technical debt"
- Code duplication → query="retry backoff duplicate"
- Security audit markers → query="secret token credential unsafe"

## rank_chunks Examples

- Decomposition candidates → rerank="refactoring"
- Hotspot detection → rerank="hotspots"
- Ownership reports → rerank="ownership", metaOnly=true
```

### Indexing Guide Content Skeleton

```markdown
# Indexing Guide

## index_codebase Options

- `path` — root directory to index
- `forceReindex` — delete existing index and rebuild
- `extensions` — file extensions to include (default: auto-detect)
- `ignorePatterns` — additional ignore patterns beyond .gitignore

## Git Metadata

Set `CODE_ENABLE_GIT_METADATA=true` before indexing.

Enables:

- author — dominant author per chunk
- modifiedAfter/modifiedBefore — date range (ISO 8601 format)
- minAgeDays/maxAgeDays — code age
- minCommitCount — churn frequency
- taskId — extracted from commit messages (JIRA, GitHub issues)

Git enrichment runs in background after indexing. Check `get_index_status` for
enrichment progress.

## Reindex Workflow

1. `index_codebase` — full initial index
2. `reindex_changes` — incremental update (changed files only)
3. `get_index_status` — check status and enrichment progress
4. `clear_index` — delete all indexed data (irreversible)
```

## Tool Description Compaction

### search_code (code.ts)

Before: ~800 chars with 6 use cases + 5 examples.

After:

```
Quick semantic search for user requests. Human-readable output with code
snippets and line numbers. Supports file type, path pattern, and git
metadata filters.

For examples see tea-rags://schema/search-guide
For parameter docs see tea-rags://schema/overview
```

### semantic_search (explore.ts)

Before: ~150 chars (already short, but missing routing hint).

After:

```
Analytical search returning structured JSON with full metadata. For agentic
workflows: analytics, reports, downstream processing.

For examples see tea-rags://schema/search-guide
For parameter docs see tea-rags://schema/overview
```

### hybrid_search (explore.ts)

Before: ~200 chars.

After:

```
Semantic + BM25 keyword search. Use when query contains exact symbols,
identifiers, or markers (TODO, FIXME, specific names). Collection must be
created with enableHybrid=true.

For examples see tea-rags://schema/search-guide
For parameter docs see tea-rags://schema/overview
```

### index_codebase (code.ts)

Before: ~500 chars with git metadata description.

After:

```
Index a codebase for semantic code search. AST-aware chunking, respects
.gitignore. Set CODE_ENABLE_GIT_METADATA=true for git blame analysis.

For indexing options and git metadata guide see tea-rags://schema/indexing-guide
```

### rank_chunks, find_similar

No changes — already compact.

## Typed Filter Description Compaction

Remove "Use for: ..." from all typed filter `.describe()` calls. Keep the field
description and example.

Before:

```
author: "Filter by dominant author (the author with most lines in chunk).
Use for: code review, ownership questions, team onboarding, finding expert
for code area. Example: 'John Doe'"
```

After:

```
author: "Filter by dominant author (the author with most lines in chunk).
Example: 'John Doe'"
```

Apply to: `author`, `modifiedAfter`, `modifiedBefore`, `minAgeDays`,
`maxAgeDays`, `minCommitCount`, `taskId`.

**Note:** `modifiedAfter` and `modifiedBefore` keep their ISO 8601 format
examples (e.g., `"Example: '2024-01-15'"`) — these are parameter documentation,
not use-case routing.

## filter.description Compaction

Before: ~400 chars listing all fields + JSON example.

After:

```
"Qdrant filter object with must/should/must_not conditions.
See tea-rags://schema/filters for syntax and available fields."
```

## Overview Update

Add a **separate** `## Guides` section to `buildOverview()`, after the existing
`## Available Resources` and `## Tools Quick Reference` sections:

```markdown
## Guides

- tea-rags://schema/search-guide — search tool routing, use cases, examples
- tea-rags://schema/indexing-guide — indexing options, git metadata guide
```

This keeps schema references (presets, signals, filters) separate from usage
guides (search-guide, indexing-guide).

## Implementation

### Files Changed

- **Modify:** `src/mcp/resources/index.ts` — add `buildSearchGuide()`,
  `buildIndexingGuide()`, register 2 new resources, update `buildOverview()`
- **Modify:** `src/mcp/tools/code.ts` — compact `search_code` and
  `index_codebase` descriptions
- **Modify:** `src/mcp/tools/explore.ts` — compact `semantic_search` and
  `hybrid_search` descriptions
- **Modify:** `src/mcp/tools/schemas.ts` — trim typed filter descriptions,
  compact `filter.description`
- **Modify:** `tests/mcp/resources/resources.test.ts` — add tests for new
  builders, update overview test
- **Modify:** `tests/mcp/tools/schemas.test.ts` — if any tests assert on
  description content

### No API changes

All changes are in MCP layer (descriptions and resources). No DTO, Reranker, or
App changes needed.

## Out of Scope

- Orchestration layer (CLAUDE rules) — already has routing
- rank_chunks, find_similar descriptions — already compact
- reindex_changes, get_index_status, clear_index descriptions — short enough

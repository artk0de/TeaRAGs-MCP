# Schema Compaction Wave 2 Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development
> (if subagents available) or superpowers:executing-plans to implement this
> plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Compact tool descriptions by moving use cases/examples into guide
resources, trim typed filter descriptions.

**Architecture:** Add 2 static guide resources (`search-guide`,
`indexing-guide`) to `src/mcp/resources/index.ts`. Compact tool descriptions in
`code.ts` and `explore.ts` to routing hints + resource links. Trim "Use for:"
from typed filter `.describe()` calls in `schemas.ts`. Compact verbose
`filter.description`. Add `## Guides` section to overview.

**Tech Stack:** TypeScript, Zod, MCP SDK, Vitest

**Spec:** `docs/superpowers/specs/2026-03-15-schema-compaction-wave2-design.md`

---

## Chunk 1: Guide Resources + Overview Update

### Task 1: Add `buildSearchGuide()` and `buildIndexingGuide()` builders

**Files:**

- Modify: `src/mcp/resources/index.ts`
- Test: `tests/mcp/resources/resources.test.ts`

- [ ] **Step 1: Update test imports and write failing tests for
      `buildSearchGuide()`**

Update the import in `tests/mcp/resources/resources.test.ts` (line 4):

```typescript
import {
  buildFiltersDoc,
  buildIndexingGuide,
  buildOverview,
  buildPresetsDoc,
  buildSearchGuide,
  buildSignalsDoc,
} from "../../../src/mcp/resources/index.js";
```

Add to `tests/mcp/resources/resources.test.ts`:

```typescript
describe("buildSearchGuide", () => {
  it("contains tool routing table", () => {
    const md = buildSearchGuide();
    expect(md).toContain("search_code");
    expect(md).toContain("semantic_search");
    expect(md).toContain("hybrid_search");
    expect(md).toContain("rank_chunks");
    expect(md).toContain("find_similar");
  });

  it("contains search_code examples", () => {
    const md = buildSearchGuide();
    expect(md).toContain("minAgeDays");
    expect(md).toContain("author");
    expect(md).toContain("taskId");
  });

  it("contains semantic_search examples", () => {
    const md = buildSearchGuide();
    expect(md).toContain("ownership");
    expect(md).toContain("techDebt");
    expect(md).toContain("metaOnly");
  });

  it("contains hybrid_search examples", () => {
    const md = buildSearchGuide();
    expect(md).toContain("TODO");
    expect(md).toContain("FIXME");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/mcp/resources/resources.test.ts` Expected: FAIL —
`buildSearchGuide` is not exported

- [ ] **Step 3: Write failing tests for `buildIndexingGuide()`**

Add to `tests/mcp/resources/resources.test.ts`:

```typescript
describe("buildIndexingGuide", () => {
  it("contains index_codebase options", () => {
    const md = buildIndexingGuide();
    expect(md).toContain("path");
    expect(md).toContain("forceReindex");
    expect(md).toContain("extensions");
    expect(md).toContain("ignorePatterns");
  });

  it("contains git metadata section", () => {
    const md = buildIndexingGuide();
    expect(md).toContain("CODE_ENABLE_GIT_METADATA");
    expect(md).toContain("dominantAuthor");
    expect(md).toContain("ISO 8601");
  });

  it("contains reindex workflow", () => {
    const md = buildIndexingGuide();
    expect(md).toContain("index_codebase");
    expect(md).toContain("reindex_changes");
    expect(md).toContain("get_index_status");
    expect(md).toContain("clear_index");
  });
});
```

- [ ] **Step 4: Implement `buildSearchGuide()` in `src/mcp/resources/index.ts`**

Add after `buildFiltersDoc()` (line 81):

```typescript
export function buildSearchGuide(): string {
  return `# Search Guide

## Tool Routing

| Need | Tool |
| --- | --- |
| Quick lookup for user request | \`search_code\` |
| Structured JSON for analytics/reports | \`semantic_search\` |
| Query with exact symbols, markers, identifiers | \`hybrid_search\` |
| Top-N by signal without query | \`rank_chunks\` |
| Find code similar to examples | \`find_similar\` |

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
`;
}
```

- [ ] **Step 5: Implement `buildIndexingGuide()` in
      `src/mcp/resources/index.ts`**

Add after `buildSearchGuide()`:

```typescript
export function buildIndexingGuide(): string {
  return `# Indexing Guide

## index_codebase Options

- \`path\` — root directory to index
- \`forceReindex\` — delete existing index and rebuild
- \`extensions\` — file extensions to include (default: auto-detect)
- \`ignorePatterns\` — additional ignore patterns beyond .gitignore

## Git Metadata

Set \`CODE_ENABLE_GIT_METADATA=true\` before indexing.

Enables filters:
- author — filter by dominantAuthor per chunk
- modifiedAfter/modifiedBefore — date range (ISO 8601 format)
- minAgeDays/maxAgeDays — code age
- minCommitCount — churn frequency
- taskId — extracted from commit messages (JIRA, GitHub issues)

Git enrichment runs in background after indexing. Check \`get_index_status\` for enrichment progress.

## Reindex Workflow

1. \`index_codebase\` — full initial index
2. \`reindex_changes\` — incremental update (changed files only)
3. \`get_index_status\` — check status and enrichment progress
4. \`clear_index\` — delete all indexed data (irreversible)
`;
}
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `npx vitest run tests/mcp/resources/resources.test.ts` Expected: ALL PASS

- [ ] **Step 7: Commit**

```bash
git add src/mcp/resources/index.ts tests/mcp/resources/resources.test.ts
git commit -m "feat(api): add search-guide and indexing-guide resource builders"
```

### Task 2: Update overview + register guide resources

**Files:**

- Modify: `src/mcp/resources/index.ts`
- Test: `tests/mcp/resources/resources.test.ts`

- [ ] **Step 1: Write failing test for overview guides section**

Add to existing `buildOverview` describe block in
`tests/mcp/resources/resources.test.ts`:

```typescript
it("lists guide resource URIs in Guides section", () => {
  const md = buildOverview();
  expect(md).toContain("## Guides");
  expect(md).toContain("tea-rags://schema/search-guide");
  expect(md).toContain("tea-rags://schema/indexing-guide");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/mcp/resources/resources.test.ts` Expected: FAIL —
overview does not contain `## Guides`

- [ ] **Step 3: Update `buildOverview()` in `src/mcp/resources/index.ts`**

Add `## Guides` section after `## Tools Quick Reference` block (before closing
backtick at line 24):

```typescript
export function buildOverview(): string {
  return `# tea-rags Schema Overview

## Available Resources
- tea-rags://schema/presets — rerank presets reference
- tea-rags://schema/signals — custom weight signals reference
- tea-rags://schema/filters — Qdrant filter syntax and examples

## Tools Quick Reference
- search_code — quick semantic lookup, human-readable output
- semantic_search — analytical, structured JSON, full metadata
- hybrid_search — semantic + BM25, best for mixed intent
- rank_chunks — rank by signals without query
- find_similar — find code similar to examples

## Guides
- tea-rags://schema/search-guide — search tool routing, use cases, examples
- tea-rags://schema/indexing-guide — indexing options, git metadata guide
`;
}
```

- [ ] **Step 4: Register 2 new resources in `registerAllResources()`**

Add after the `schema-filters` resource registration (after line 210):

```typescript
// Static resource: search guide
server.registerResource(
  "schema-search-guide",
  "tea-rags://schema/search-guide",
  {
    title: "Search Guide",
    description: "Tool routing, use cases, and examples for all search tools",
    mimeType: "text/markdown",
  },
  async (uri) => ({
    contents: [
      { uri: uri.href, mimeType: "text/markdown", text: buildSearchGuide() },
    ],
  }),
);

// Static resource: indexing guide
server.registerResource(
  "schema-indexing-guide",
  "tea-rags://schema/indexing-guide",
  {
    title: "Indexing Guide",
    description: "Indexing options, git metadata guide, and reindex workflow",
    mimeType: "text/markdown",
  },
  async (uri) => ({
    contents: [
      { uri: uri.href, mimeType: "text/markdown", text: buildIndexingGuide() },
    ],
  }),
);
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run tests/mcp/resources/resources.test.ts` Expected: ALL PASS

- [ ] **Step 6: Commit**

```bash
git add src/mcp/resources/index.ts tests/mcp/resources/resources.test.ts
git commit -m "feat(api): register search-guide and indexing-guide resources, add Guides to overview"
```

## Chunk 2: Tool Description Compaction

### Task 3: Compact `search_code` and `index_codebase` descriptions

**Files:**

- Modify: `src/mcp/tools/code.ts:22-29` (index_codebase description)
- Modify: `src/mcp/tools/code.ts:70-88` (search_code description)

- [ ] **Step 1: Compact `index_codebase` description**

In `src/mcp/tools/code.ts`, replace the `index_codebase` description (lines
22-29):

Before:

```typescript
      description:
        "Index a codebase for semantic code search. Automatically discovers files, chunks code intelligently using AST-aware parsing, and stores in vector database. Respects .gitignore and other ignore files.\n\n" +
        "GIT METADATA: Set CODE_ENABLE_GIT_METADATA=true environment variable before indexing to enable git blame analysis. " +
        "This adds author, dates, commit history, and task IDs to each code chunk, enabling powerful filters in search_code:\n" +
        "- Filter by author (who wrote this code?)\n" +
        "- Filter by age (recent vs legacy code)\n" +
        "- Filter by churn (frequently changed code)\n" +
        "- Filter by task/ticket IDs (JIRA, GitHub issues, etc.)",
```

After:

```typescript
      description:
        "Index a codebase for semantic code search. AST-aware chunking, respects .gitignore. " +
        "Set CODE_ENABLE_GIT_METADATA=true for git blame analysis.\n\n" +
        "For indexing options and git metadata guide see tea-rags://schema/indexing-guide",
```

- [ ] **Step 2: Compact `search_code` description**

In `src/mcp/tools/code.ts`, replace the `search_code` description (lines 70-88):

Before:

```typescript
      description:
        "Search indexed codebase using natural language queries. Returns semantically relevant code chunks with file paths and line numbers. " +
        "Supports filtering by file types, path patterns, and git metadata (dominant author, date range, code age, churn/commit count, task IDs). " +
        "Git filters require CODE_ENABLE_GIT_METADATA=true during indexing. Task IDs (e.g., TD-1234, #567) are extracted from commit summaries.\n\n" +
        "GIT METADATA USE CASES:\n" +
        "- 'author': Find code by specific developer (code review, ownership questions, onboarding)\n" +
        "- 'maxAgeDays': Find recent changes (sprint review, incident response, what changed recently?)\n" +
        "- 'minAgeDays': Find legacy/old code (tech debt, needs documentation, refactoring candidates)\n" +
        "- 'minCommitCount': Find high-churn code (problematic areas, frequently modified, risk assessment)\n" +
        "- 'taskId': Trace code to requirements (impact analysis, audit, what was done for ticket X?)\n" +
        "- 'modifiedAfter/Before': Find code in date range (release analysis, historical debugging)\n\n" +
        "EXAMPLE QUERIES:\n" +
        "- 'Complex code that hasn't been touched in 30+ days' → query='complex logic', minAgeDays=30\n" +
        "- 'What did John work on last week?' → author='John', maxAgeDays=7\n" +
        "- 'High-churn authentication code' → query='authentication', minCommitCount=5\n" +
        "- 'Code related to ticket TD-1234' → taskId='TD-1234'\n" +
        "- 'Legacy code that might need documentation' → query='service', minAgeDays=60\n\n" +
        "Returns human-readable formatted text with code snippets.\n\n" +
        "For detailed parameter docs (presets, signals, filters) see tea-rags://schema/overview",
```

After:

```typescript
      description:
        "Quick semantic search for user requests. Human-readable output with code snippets and line numbers. " +
        "Supports file type, path pattern, and git metadata filters.\n\n" +
        "For examples see tea-rags://schema/search-guide\n" +
        "For parameter docs see tea-rags://schema/overview",
```

- [ ] **Step 3: Build to verify no type errors**

Run: `npm run build` Expected: SUCCESS

- [ ] **Step 4: Run all tests**

Run: `npx vitest run` Expected: ALL PASS

- [ ] **Step 5: Commit**

```bash
git add src/mcp/tools/code.ts
git commit -m "improve(api): compact search_code and index_codebase descriptions"
```

### Task 4: Compact `semantic_search` and `hybrid_search` descriptions

**Files:**

- Modify: `src/mcp/tools/explore.ts:36-39` (semantic_search description)
- Modify: `src/mcp/tools/explore.ts:62-65` (hybrid_search description)

- [ ] **Step 1: Compact `semantic_search` description**

In `src/mcp/tools/explore.ts`, replace the description (lines 36-39):

Before:

```typescript
      description:
        "Search for documents using natural language queries. Returns the most semantically similar documents.\n\n" +
        "Returns structured JSON array of results with explained metadata.\n\n" +
        "For detailed parameter docs (presets, signals, filters) see tea-rags://schema/overview",
```

After:

```typescript
      description:
        "Analytical search returning structured JSON with full metadata. " +
        "For agentic workflows: analytics, reports, downstream processing.\n\n" +
        "For examples see tea-rags://schema/search-guide\n" +
        "For parameter docs see tea-rags://schema/overview",
```

- [ ] **Step 2: Compact `hybrid_search` description**

In `src/mcp/tools/explore.ts`, replace the description (lines 62-65):

Before:

```typescript
      description:
        "Perform hybrid search combining semantic vector search with keyword search using BM25. This provides better results by combining the strengths of both approaches. The collection must be created with enableHybrid=true (see create_collection).\n\n" +
        "Returns structured JSON array of results with explained metadata.\n\n" +
        "For detailed parameter docs (presets, signals, filters) see tea-rags://schema/overview",
```

After:

```typescript
      description:
        "Semantic + BM25 keyword search. Use when query contains exact symbols, identifiers, " +
        "or markers (TODO, FIXME, specific names). Collection must be created with enableHybrid=true.\n\n" +
        "For examples see tea-rags://schema/search-guide\n" +
        "For parameter docs see tea-rags://schema/overview",
```

- [ ] **Step 3: Build and run tests**

Run: `npm run build && npx vitest run` Expected: SUCCESS, ALL PASS

- [ ] **Step 4: Commit**

```bash
git add src/mcp/tools/explore.ts
git commit -m "improve(api): compact semantic_search and hybrid_search descriptions"
```

## Chunk 3: Filter Description Compaction

### Task 5: Trim typed filter descriptions

**Files:**

- Modify: `src/mcp/tools/schemas.ts:139-183` (typedFilterFields)

- [ ] **Step 1: Trim `author` description**

In `src/mcp/tools/schemas.ts`, replace lines 139-143:

Before:

```typescript
    author: z
      .string()
      .optional()
      .describe(
        "Filter by dominant author (the author with most lines in chunk). " +
          "Use for: code review, ownership questions, team onboarding, finding expert for code area. " +
          "Example: 'John Doe'",
      ),
```

After:

```typescript
    author: z
      .string()
      .optional()
      .describe("Filter by dominant author (the author with most lines in chunk). Example: 'John Doe'"),
```

- [ ] **Step 2: Trim `modifiedAfter` description**

Replace lines 144-150:

Before:

```typescript
    modifiedAfter: z
      .string()
      .optional()
      .describe(
        "Filter code modified after this date. Use for: sprint review, release analysis, incident debugging. " +
          "ISO format: '2024-01-01' or '2024-01-01T00:00:00Z'",
      ),
```

After:

```typescript
    modifiedAfter: z
      .string()
      .optional()
      .describe("Filter code modified after this date. ISO format: '2024-01-01' or '2024-01-01T00:00:00Z'"),
```

- [ ] **Step 3: Trim `modifiedBefore` description**

Replace lines 151-156:

Before:

```typescript
    modifiedBefore: z
      .string()
      .optional()
      .describe(
        "Filter code modified before this date. Use for: finding old code, historical debugging, compliance audits. " +
          "ISO format: '2024-12-31'",
      ),
```

After:

```typescript
    modifiedBefore: z
      .string()
      .optional()
      .describe("Filter code modified before this date. ISO format: '2024-12-31'"),
```

- [ ] **Step 4: Trim `minAgeDays` description**

Replace lines 158-163:

Before:

```typescript
    minAgeDays: coerceNumber()
      .optional()
      .describe(
        "Filter code older than N days (since last modification). " +
          "Use for: finding legacy/stale code, tech debt assessment, documentation needs, refactoring candidates.",
      ),
```

After:

```typescript
    minAgeDays: coerceNumber()
      .optional()
      .describe("Filter code older than N days (since last modification)."),
```

- [ ] **Step 5: Trim `maxAgeDays` description**

Replace lines 164-169:

Before:

```typescript
    maxAgeDays: coerceNumber()
      .optional()
      .describe(
        "Filter code newer than N days (since last modification). " +
          "Use for: recent changes review, sprint work, incident response, release notes.",
      ),
```

After:

```typescript
    maxAgeDays: coerceNumber()
      .optional()
      .describe("Filter code newer than N days (since last modification)."),
```

- [ ] **Step 6: Trim `minCommitCount` description**

Replace lines 170-176:

Before:

```typescript
    minCommitCount: coerceNumber()
      .optional()
      .describe(
        "Filter by minimum number of commits touching the chunk (churn indicator). " +
          "High churn = problematic areas, bugs, complex requirements. " +
          "Use for: risk assessment, code quality issues, refactoring priorities.",
      ),
```

After:

```typescript
    minCommitCount: coerceNumber()
      .optional()
      .describe("Filter by minimum number of commits touching the chunk (churn indicator)."),
```

- [ ] **Step 7: Trim `taskId` description**

Replace lines 177-183:

Before:

```typescript
    taskId: z
      .string()
      .optional()
      .describe(
        "Filter by task/issue ID from commit messages. Supports JIRA (TD-1234), GitHub (#567), Azure DevOps (AB#890). " +
          "Use for: requirements tracing, impact analysis, audit, compliance, 'what code was written for this ticket?'",
      ),
```

After:

```typescript
    taskId: z
      .string()
      .optional()
      .describe(
        "Filter by task/issue ID from commit messages. Supports JIRA (TD-1234), GitHub (#567), Azure DevOps (AB#890).",
      ),
```

- [ ] **Step 8: Run all tests**

Run: `npx vitest run` Expected: ALL PASS (no tests assert on description
content)

- [ ] **Step 9: Commit**

```bash
git add src/mcp/tools/schemas.ts
git commit -m "improve(api): trim 'Use for' from typed filter descriptions"
```

### Task 6: Compact `filter.description`

**Files:**

- Modify: `src/mcp/tools/schemas.ts:194-209` (searchCommonFields filter)

- [ ] **Step 1: Compact `filter` description in `searchCommonFields()`**

In `src/mcp/tools/schemas.ts`, replace the `filter` field (lines 194-209):

Before:

```typescript
    filter: z
      .record(z.any())
      .optional()
      .describe(
        "Qdrant filter object with must/should/must_not conditions. " +
          "Available fields for code chunks (index_codebase): " +
          "relativePath (string), fileExtension (string), language (string), " +
          "startLine (number), endLine (number), chunkIndex (number), " +
          "isDocumentation (boolean), name (string), chunkType (string: function|class|interface|block), " +
          "parentName (string), parentType (string), " +
          "git.dominantAuthor (string), git.authors (string[]), " +
          "git.lastModifiedAt (unix timestamp), git.firstCreatedAt (unix timestamp), " +
          "git.commitCount (number), git.ageDays (number), git.taskIds (string[]), " +
          "imports (string[] - file-level imports for structural signal). " +
          "For generic documents (add_documents): user-defined metadata fields. " +
          'Example: {"must": [{"key": "language", "match": {"value": "typescript"}}, {"key": "git.commitCount", "range": {"gte": 5}}]}',
      ),
```

After:

```typescript
    filter: z
      .record(z.any())
      .optional()
      .describe(
        "Qdrant filter object with must/should/must_not conditions. " +
          "See tea-rags://schema/filters for syntax and available fields.",
      ),
```

- [ ] **Step 2: Run all tests**

Run: `npx vitest run` Expected: ALL PASS

- [ ] **Step 3: Build to verify**

Run: `npm run build` Expected: SUCCESS

- [ ] **Step 4: Commit**

```bash
git add src/mcp/tools/schemas.ts
git commit -m "improve(api): compact filter.description with link to filters resource"
```

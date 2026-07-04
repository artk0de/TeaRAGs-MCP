# MCP Schema Improvements

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to
> implement this plan task-by-task.

**Goal:** Improve MCP tool schemas with per-preset descriptions, consolidated
filter params, output schemas, annotations, and documentation resources.

**Architecture:** Changes span SchemaBuilder (dynamic schema generation),
schemas.ts (shared params), tool registrations (annotations + descriptions), and
a new MCP Resource for schema documentation. All changes are in the MCP layer +
SchemaBuilder, no domain logic changes.

**Tech Stack:** Zod, @modelcontextprotocol/sdk (registerTool with
annotations/outputSchema, registerResource)

**Blocker:** Task 8 (MCP Resource with filter guidance) references
`get_index_metrics` tool for dynamic threshold discovery. That tool requires a
separate design. This plan can be fully implemented without it — just reference
it in descriptions as "coming soon".

---

### Task 1: Preset descriptions in schema — SchemaBuilder

**Files:**

- Modify: `src/core/api/schema-builder.ts:32-38`
- Modify: `src/core/explore/reranker.ts:152-154` (add new public method)
- Test: `tests/core/api/schema-builder.test.ts`

**Step 1: Write failing test — buildPresetSchema returns union with
descriptions**

```typescript
// tests/core/api/schema-builder.test.ts — add to "buildPresetSchema" describe block

it("returns ZodUnion of literals with descriptions (not bare ZodEnum)", () => {
  const mock = createMockReranker({
    presets: {
      semantic_search: ["relevance", "techDebt"],
    },
    presetDescriptions: {
      relevance: "Pure semantic similarity ranking",
      techDebt: "Find legacy code with high churn and old age",
    },
  });
  const builder = new SchemaBuilder(mock as Reranker);
  const schema = builder.buildPresetSchema("semantic_search");

  // Should accept valid preset names
  expect(schema.parse("relevance")).toBe("relevance");
  expect(schema.parse("techDebt")).toBe("techDebt");
  expect(() => schema.parse("nonexistent")).toThrow();

  // Should be a union, not an enum
  expect(schema).not.toBeInstanceOf(z.ZodEnum);
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run tests/core/api/schema-builder.test.ts` Expected: FAIL —
`createMockReranker` doesn't accept `presetDescriptions`, schema is still
ZodEnum.

**Step 3: Update mock to support presetDescriptions**

Update `createMockReranker` in test file:

```typescript
function createMockReranker(overrides?: {
  descriptors?: { name: string; description: string }[];
  presets?: Record<string, string[]>;
  presetDescriptions?: Record<string, string>;
}): Pick<
  Reranker,
  "getDescriptorInfo" | "getPresetNames" | "getPresetDescriptions"
> {
  const descriptors = overrides?.descriptors ?? [
    { name: "recency", description: "Inverse of age" },
    { name: "similarity", description: "Semantic similarity score" },
    { name: "churn", description: "Commit frequency" },
  ];
  const presets = overrides?.presets ?? {
    semantic_search: ["relevance", "techDebt", "hotspots"],
    search_code: ["relevance", "recent", "stable"],
  };
  const descriptions = overrides?.presetDescriptions ?? {};

  return {
    getDescriptorInfo: () => descriptors,
    getPresetNames: (tool: string) => presets[tool] ?? [],
    getPresetDescriptions: (tool: string) =>
      (presets[tool] ?? []).map((name) => ({
        name,
        description: descriptions[name] ?? `${name} preset`,
      })),
  };
}
```

**Step 4: Add `getPresetDescriptions` to Reranker**

In `src/core/explore/reranker.ts`, add after `getPresetNames` (line ~176):

```typescript
/** Preset names + descriptions for a specific tool (for MCP schema generation). */
getPresetDescriptions(tool: string): { name: string; description: string }[] {
  return this.resolvedPresets
    .filter((p) => this.matchesTool(p, tool))
    .map((p) => ({ name: p.name, description: p.description }));
}
```

**Step 5: Update SchemaBuilder.buildPresetSchema to use
z.union(z.literal().describe())**

Replace `src/core/api/schema-builder.ts:32-38`:

```typescript
/**
 * Build Zod schema for preset names with descriptions by tool.
 * Uses z.union(z.literal().describe()) instead of z.enum() so each
 * preset value is self-documenting in the MCP schema.
 */
buildPresetSchema(tool: string) {
  const presets = this.reranker.getPresetDescriptions(tool);
  if (presets.length === 0) {
    throw new Error(`No presets registered for tool "${tool}"`);
  }
  if (presets.length === 1) {
    return z.literal(presets[0].name).describe(presets[0].description);
  }
  const literals = presets.map((p) =>
    z.literal(p.name).describe(p.description),
  );
  return z.union(
    literals as [z.ZodTypeAny, z.ZodTypeAny, ...z.ZodTypeAny[]],
  );
}
```

**Step 6: Run test to verify it passes**

Run: `npx vitest run tests/core/api/schema-builder.test.ts` Expected: PASS

**Step 7: Remove hardcoded rerank description fallback from schemas.ts**

In `src/mcp/tools/schemas.ts`, replace the long hardcoded `.describe(...)`
strings on rerank fields (lines 219-224, 241-246, 278-280, 289-293) with a short
generic description. The per-value descriptions now come from the schema itself.

Replace each with:

```typescript
.describe("Reranking preset or {custom: weights}. See preset descriptions for details.")
```

**Step 8: Run full test suite**

Run: `npx vitest run` Expected: ALL PASS. Some schema tests may need update if
they check for `ZodEnum`.

**Step 9: Commit**

```bash
git add src/core/api/schema-builder.ts src/core/explore/reranker.ts \
  src/mcp/tools/schemas.ts tests/core/api/schema-builder.test.ts
git commit -m "improve(presets): add per-preset descriptions to MCP schema

SchemaBuilder now uses z.union(z.literal().describe()) instead of z.enum(),
so each preset value carries its description in the MCP JSON Schema.
Removes hardcoded fallback descriptions from schemas.ts."
```

---

### Task 2: Consolidate filter parameters

**Files:**

- Modify: `src/mcp/tools/schemas.ts:114-170` (typedFilterFields)
- Modify: `src/mcp/tools/schemas.ts:257-282` (SearchCodeSchema — remove
  fileTypes, documentationOnly)
- Modify: `src/mcp/tools/code.ts` (update search_code handler to map new params)
- Modify: `src/mcp/tools/explore.ts` (update handlers if needed)
- Test: `tests/mcp/tools/schemas.test.ts`

**Step 1: Write failing test — fileExtension accepts string or string[]**

```typescript
// tests/mcp/tools/schemas.test.ts — add new describe block

describe("Filter parameter consolidation", () => {
  const base = { query: "test", path: "/tmp" };

  it("fileExtension accepts a single string", () => {
    const result = parseSemanticSearch({ ...base, fileExtension: ".ts" });
    expect(result.fileExtension).toEqual(".ts");
  });

  it("fileExtension accepts an array of strings", () => {
    const result = parseSemanticSearch({
      ...base,
      fileExtension: [".ts", ".py"],
    });
    expect(result.fileExtension).toEqual([".ts", ".py"]);
  });

  it("documentation accepts enum values", () => {
    const result = parseSemanticSearch({ ...base, documentation: "only" });
    expect(result.documentation).toBe("only");
  });

  it("documentation rejects invalid values", () => {
    expect(() =>
      parseSemanticSearch({ ...base, documentation: "yes" }),
    ).toThrow();
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run tests/mcp/tools/schemas.test.ts` Expected: FAIL —
`fileExtension` doesn't accept arrays, `documentation` doesn't exist.

**Step 3: Update typedFilterFields**

In `src/mcp/tools/schemas.ts`, replace `fileExtension`, `isDocumentation`,
`excludeDocumentation` in `typedFilterFields()`:

```typescript
function typedFilterFields() {
  return {
    language: z.string().optional().describe("Filter by programming language"),
    fileExtension: z
      .union([z.string(), z.array(z.string())])
      .optional()
      .describe(
        "Filter by file extension(s). Single string (e.g. '.ts') or array (e.g. ['.ts', '.py'])",
      ),
    chunkType: z
      .string()
      .optional()
      .describe("Filter by chunk type (function, class, interface, block)"),
    documentation: z
      .enum(["only", "exclude", "include"])
      .optional()
      .describe(
        "Documentation filter mode. 'only' = documentation chunks only, " +
          "'exclude' = no documentation chunks, 'include' = all chunks (default).",
      ),
    author: z
      .string()
      .optional()
      .describe(
        "Filter by dominant author. Exact match, case-sensitive, must match full name from git log. " +
          "Requires CODE_ENABLE_GIT_METADATA=true during indexing.",
      ),
    // ... rest of git filters (modifiedAfter, modifiedBefore, minAgeDays, maxAgeDays, minCommitCount, taskId)
    // Add "Requires CODE_ENABLE_GIT_METADATA=true during indexing." to each git filter description.
    modifiedAfter: z
      .string()
      .optional()
      .describe(
        "Filter code modified after this date (ISO format: '2024-01-01'). " +
          "Requires CODE_ENABLE_GIT_METADATA=true during indexing.",
      ),
    modifiedBefore: z
      .string()
      .optional()
      .describe(
        "Filter code modified before this date (ISO format: '2024-12-31'). " +
          "Requires CODE_ENABLE_GIT_METADATA=true during indexing.",
      ),
    minAgeDays: coerceNumber()
      .optional()
      .describe(
        "Filter code older than N days since last modification. " +
          "Requires CODE_ENABLE_GIT_METADATA=true during indexing.",
      ),
    maxAgeDays: coerceNumber()
      .optional()
      .describe(
        "Filter code newer than N days since last modification. " +
          "Requires CODE_ENABLE_GIT_METADATA=true during indexing.",
      ),
    minCommitCount: coerceNumber()
      .optional()
      .describe(
        "Filter by minimum commits touching the chunk (churn indicator). " +
          "Requires CODE_ENABLE_GIT_METADATA=true during indexing.",
      ),
    taskId: z
      .string()
      .optional()
      .describe(
        "Filter by task/issue ID from commit messages. Exact match, case-sensitive. " +
          "Supports JIRA (TD-1234), GitHub (#567), Azure DevOps (AB#890). " +
          "Requires CODE_ENABLE_GIT_METADATA=true during indexing.",
      ),
  };
}
```

**Step 4: Remove fileTypes and documentationOnly from SearchCodeSchema**

In `src/mcp/tools/schemas.ts` SearchCodeSchema block (~line 257-282), remove:

- `fileTypes` field (line 269)
- `documentationOnly` field (lines 270-275)

These are now covered by `fileExtension` (string|string[]) and `documentation`
("only"|"exclude"|"include") from `typedFilterFields()`.

**Step 5: Update handler code to map new param names**

In `src/mcp/tools/code.ts` search_code handler and `src/mcp/tools/explore.ts`
handlers, the `documentation` enum needs to be mapped to the existing App
interface params (`isDocumentation`/`excludeDocumentation`). Add a mapper
function in `schemas.ts` or `format.ts`:

```typescript
/** Map documentation enum to legacy boolean flags for App interface */
export function mapDocumentationFilter(doc?: "only" | "exclude" | "include") {
  if (doc === "only")
    return { isDocumentation: true, excludeDocumentation: false };
  if (doc === "exclude")
    return { isDocumentation: false, excludeDocumentation: true };
  return {};
}
```

Apply this in each tool handler before calling `app.*`.

Similarly, normalize `fileExtension` from `string | string[]` to the format App
expects.

**Step 6: Run test to verify it passes**

Run: `npx vitest run tests/mcp/tools/schemas.test.ts` Expected: PASS

**Step 7: Run full test suite**

Run: `npx vitest run` Expected: ALL PASS

**Step 8: Commit**

```bash
git add src/mcp/tools/schemas.ts src/mcp/tools/code.ts src/mcp/tools/explore.ts \
  tests/mcp/tools/schemas.test.ts
git commit -m "improve(mcp): consolidate filter params — fileExtension string|array, documentation enum

Replace fileTypes (array) + fileExtension (string) with single fileExtension
accepting both. Replace isDocumentation + excludeDocumentation + documentationOnly
with documentation enum ('only' | 'exclude' | 'include').
Add CODE_ENABLE_GIT_METADATA prerequisite to all git filter descriptions."
```

---

### Task 3: Shared output schema for search tools

**Files:**

- Create: `src/mcp/tools/output-schemas.ts`
- Modify: `src/mcp/tools/explore.ts` (add outputSchema to registerTool)
- Modify: `src/mcp/tools/code.ts` (add outputSchema to search_code)
- Test: `tests/mcp/tools/output-schemas.test.ts`

**Step 1: Write failing test — output schema validates search response**

```typescript
// tests/mcp/tools/output-schemas.test.ts

import { describe, expect, it } from "vitest";
import { z } from "zod";

import { SearchResultOutputSchema } from "../../../src/mcp/tools/output-schemas.js";

describe("SearchResultOutputSchema", () => {
  it("validates a minimal search result", () => {
    const result = z.object(SearchResultOutputSchema).parse({
      results: [
        {
          score: 0.85,
          relativePath: "src/auth.ts",
          startLine: 10,
          endLine: 30,
          language: "typescript",
        },
      ],
    });
    expect(result.results).toHaveLength(1);
    expect(result.results[0].score).toBe(0.85);
  });

  it("validates result with ranking overlay", () => {
    const result = z.object(SearchResultOutputSchema).parse({
      results: [
        {
          score: 0.9,
          relativePath: "src/db.ts",
          startLine: 1,
          endLine: 50,
          rankingOverlay: {
            preset: "techDebt",
            derived: { recency: 0.3, churn: 0.8 },
          },
        },
      ],
    });
    expect(result.results[0].rankingOverlay?.preset).toBe("techDebt");
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run tests/mcp/tools/output-schemas.test.ts` Expected: FAIL —
module doesn't exist.

**Step 3: Create output-schemas.ts**

```typescript
// src/mcp/tools/output-schemas.ts
import { z } from "zod";

const RankingOverlaySchema = z.object({
  preset: z.string().describe("Rerank preset used"),
  file: z.record(z.unknown()).optional().describe("Raw file-level signals"),
  chunk: z.record(z.unknown()).optional().describe("Raw chunk-level signals"),
  derived: z
    .record(z.number())
    .optional()
    .describe("Normalized derived signals (0-1)"),
});

const SearchResultItemSchema = z.object({
  score: z.number().describe("Relevance score"),
  relativePath: z
    .string()
    .optional()
    .describe("File path relative to codebase root"),
  startLine: z.number().optional().describe("Start line in file"),
  endLine: z.number().optional().describe("End line in file"),
  language: z.string().optional().describe("Programming language"),
  chunkType: z
    .string()
    .optional()
    .describe("Chunk type: function, class, interface, block"),
  name: z.string().optional().describe("Symbol name (function/class name)"),
  content: z
    .string()
    .optional()
    .describe("Code content (omitted when metaOnly=true)"),
  rankingOverlay: RankingOverlaySchema.optional().describe(
    "Explains scoring signals",
  ),
});

/** Shared output schema for semantic_search, hybrid_search, rank_chunks */
export const SearchResultOutputSchema = {
  results: z
    .array(SearchResultItemSchema)
    .describe("Search results with explained metadata"),
};
```

**Step 4: Run test to verify it passes**

Run: `npx vitest run tests/mcp/tools/output-schemas.test.ts` Expected: PASS

**Step 5: Add outputSchema to search tool registrations**

In `src/mcp/tools/explore.ts`, import and add to each `registerTool`:

```typescript
import { SearchResultOutputSchema } from "./output-schemas.js";

// For semantic_search, hybrid_search, rank_chunks:
server.registerTool("semantic_search", {
  title: "Semantic Search",
  description: "...",
  inputSchema: searchSchemas.SemanticSearchSchema,
  outputSchema: SearchResultOutputSchema,  // ← add
}, async ({ rerank, ...rest }) => { ... });
```

For `search_code` in `code.ts`, it returns text, so no structured output schema
(or a simple `{ text: z.string() }`).

**Step 6: Run full test suite**

Run: `npx vitest run` Expected: ALL PASS

**Step 7: Commit**

```bash
git add src/mcp/tools/output-schemas.ts src/mcp/tools/explore.ts \
  src/mcp/tools/code.ts tests/mcp/tools/output-schemas.test.ts
git commit -m "feat(mcp): add shared outputSchema for search tools

Shared SearchResultOutputSchema for semantic_search, hybrid_search, rank_chunks.
Describes result shape including rankingOverlay with explained metadata."
```

---

### Task 4: Tool annotations

**Files:**

- Modify: `src/mcp/tools/explore.ts` (add annotations to search tools)
- Modify: `src/mcp/tools/code.ts` (add annotations to indexing + search_code)
- Modify: `src/mcp/tools/collection.ts` (add annotations to collection tools)
- Modify: `src/mcp/tools/document.ts` (add annotations to document tools)

**Step 1: Add annotations to all tool registrations**

No TDD needed — annotations are declarative metadata, not logic.

Add `annotations` field to each `registerTool` config:

```typescript
// Read-only tools
annotations: {
  readOnlyHint: true;
}
// → semantic_search, hybrid_search, rank_chunks, search_code
// → list_collections, get_collection_info, get_index_status

// Destructive tools
annotations: {
  destructiveHint: true;
}
// → clear_index, delete_collection, delete_documents

// Mutating, idempotent
annotations: {
  idempotentHint: true;
}
// → index_codebase, reindex_changes, create_collection

// Mutating, not idempotent
annotations: {
}
// → add_documents
```

**Step 2: Run full test suite**

Run: `npx vitest run` Expected: ALL PASS (annotations don't affect behavior)

**Step 3: Commit**

```bash
git add src/mcp/tools/explore.ts src/mcp/tools/code.ts \
  src/mcp/tools/collection.ts src/mcp/tools/document.ts
git commit -m "improve(mcp): add ToolAnnotations to all tools

readOnlyHint for search/status tools, destructiveHint for delete/clear,
idempotentHint for index/create operations."
```

---

### Task 5: Improve tool descriptions

**Files:**

- Modify: `src/mcp/tools/schemas.ts` (limit defaults, level descriptions,
  distance descriptions, filter example, collection/path XOR)
- Modify: `src/mcp/tools/explore.ts` (tool descriptions — response format,
  hybrid prereq)
- Modify: `src/mcp/tools/code.ts` (search_code response format)
- Modify: `src/mcp/tools/collection.ts` (distance description)

**Step 1: Fix limit default to 10 everywhere**

In `src/mcp/tools/schemas.ts`:

- Line 178: `"Maximum number of results (default: 5)"` →
  `"Maximum number of results (default: 10)"`
- Line 260: `"Maximum number of results (default: 5, max: 100)"` →
  `"Maximum number of results (default: 10, max: 100)"`

**Step 2: Document metaOnly default difference in rank_chunks**

Line 325-327: update description:

```typescript
.describe(
  "Return only metadata (path, lines, git info) without content. " +
  "Default: true (rank_chunks is analytics-oriented; use false to include code content).",
)
```

**Step 3: Add level descriptions**

Lines 295-300: update level description:

```typescript
.describe(
  "Analysis level. 'chunk' = rank individual code chunks (functions, classes, blocks) — " +
  "use for decomposition candidates, hotspot detection. " +
  "'file' = rank files as aggregated units — use for tech debt and ownership analysis.",
)
```

**Step 4: Add distance descriptions**

In `CreateCollectionSchema` (line 30):

```typescript
distance: z
  .enum(["Cosine", "Euclid", "Dot"])
  .optional()
  .describe(
    "Distance metric (default: Cosine). " +
    "Cosine: recommended, works with all embedding providers. " +
    "Dot: equivalent to Cosine for normalized embeddings. " +
    "Euclid: absolute vector distance, rarely needed for text embeddings.",
  ),
```

**Step 5: Add filter example to searchCommonFields**

In `searchCommonFields()` filter description (lines 179-193), append:

```
Example: {"must": [{"key": "language", "match": {"value": "typescript"}}, {"key": "git.commitCount", "range": {"gte": 5}}]}
```

**Step 6: Document collection/path XOR**

In `collectionPathFields()` (lines 97-108), update descriptions:

```typescript
collection: z.string().optional().describe(
  "Collection name. Provide either 'collection' or 'path', not both.",
),
path: z.string().optional().describe(
  "Path to indexed codebase (auto-resolves collection name). " +
  "Provide either 'path' or 'collection', not both.",
),
```

**Step 7: Update tool descriptions with response format**

In `explore.ts`:

- `semantic_search` description: append
  `"\n\nReturns structured JSON array of results with explained metadata."`
- `hybrid_search` description: ensure
  `"The collection must be created with enableHybrid=true (see create_collection)."`
  is clear. Append
  `"\n\nReturns structured JSON array of results with explained metadata."`
- `rank_chunks` description: append
  `"\n\nReturns structured JSON array of results with explained metadata."`

In `code.ts`:

- `search_code` description: append
  `"\n\nReturns human-readable formatted text with code snippets."`

**Step 8: Run full test suite**

Run: `npx vitest run` Expected: ALL PASS

**Step 9: Commit**

```bash
git add src/mcp/tools/schemas.ts src/mcp/tools/explore.ts \
  src/mcp/tools/code.ts src/mcp/tools/collection.ts
git commit -m "docs(mcp): improve tool/param descriptions

Fix limit default to 10, explain metaOnly default in rank_chunks,
add level semantics, distance guidance, filter example, collection/path XOR,
response format documentation, hybrid_search prerequisite."
```

---

### Task 6: MCP Resource — schema documentation

**Files:**

- Modify: `src/mcp/resources/index.ts` (add schema documentation resource)

**Step 1: Add schema docs resource**

In `src/mcp/resources/index.ts`, add a new static resource after existing ones:

```typescript
// Static resource: schema documentation
server.registerResource(
  "schema-docs",
  "tea-rags://schema/documentation",
  {
    title: "Schema Documentation",
    description:
      "Detailed documentation for tea-rags MCP tool parameters: " +
      "rerank presets, custom weight signals, filter syntax, and usage guidance.",
    mimeType: "text/markdown",
  },
  async (uri) => {
    const docs = buildSchemaDocumentation(app);
    return {
      contents: [{ uri: uri.href, mimeType: "text/markdown", text: docs }],
    };
  },
);
```

**Step 2: Implement buildSchemaDocumentation**

This function generates markdown from `app.getSchemaDescriptors()` + static
content:

```typescript
function buildSchemaDocumentation(app: App): string {
  const descriptors = app.getSchemaDescriptors();
  let md = "# tea-rags Schema Documentation\n\n";

  // Rerank presets section
  md += "## Rerank Presets\n\n";
  for (const [tool, names] of Object.entries(descriptors.presetNames)) {
    md += `### ${tool}\n\n`;
    for (const name of names) {
      md += `- **${name}**\n`;
    }
    md += "\n";
  }

  // Custom weight signals section
  md += "## Custom Weight Signals\n\n";
  md +=
    "All signals accept a number (weight). Available for `{custom: {...}}` rerank mode.\n\n";
  for (const sig of descriptors.signalDescriptors) {
    md += `- **${sig.name}**: ${sig.description}\n`;
  }

  // Qdrant filter syntax section
  md += "\n## Qdrant Filter Syntax\n\n";
  md += "### Operators\n\n";
  md += '- `match: {value: "exact"}` — exact string/number match\n';
  md += '- `match: {text: "partial"}` — partial text match\n';
  md += '- `match: {any: ["a", "b"]}` — match any value in array\n';
  md += "- `range: {gte: 5, lte: 10}` — numeric range\n\n";
  md += "### Combining conditions\n\n";
  md += "- `must: [...]` — AND (all conditions must match)\n";
  md += "- `should: [...]` — OR (at least one must match)\n";
  md += "- `must_not: [...]` — NOT (none must match)\n\n";
  md += "### Available fields\n\n";
  md +=
    "**Chunk metadata:** relativePath, fileExtension, language, startLine, endLine, ";
  md +=
    "chunkIndex, isDocumentation, name, chunkType, parentName, parentType\n\n";
  md += "**Git metadata** (requires CODE_ENABLE_GIT_METADATA=true):\n";
  md +=
    "git.dominantAuthor, git.authors[], git.lastModifiedAt, git.firstCreatedAt, ";
  md += "git.commitCount, git.ageDays, git.taskIds[]\n\n";
  md += "**Imports:** imports[] — file-level imports\n\n";

  // Threshold guidance
  md += "## Filter Thresholds\n\n";
  md +=
    "Typical values (vary by codebase, use `get_index_metrics` for exact stats):\n\n";
  md += "- `minCommitCount: 5` — high churn threshold\n";
  md += "- `minCommitCount: 10` — very high churn\n";
  md += "- `minAgeDays: 30` — older than a month\n";
  md += "- `minAgeDays: 90` — legacy code\n";
  md += "- `maxAgeDays: 7` — last week's changes\n";
  md += "- `maxAgeDays: 30` — last month's changes\n";

  return md;
}
```

**Step 3: Run full test suite**

Run: `npx vitest run` Expected: ALL PASS

**Step 4: Commit**

```bash
git add src/mcp/resources/index.ts
git commit -m "feat(mcp): add schema documentation MCP Resource

Static resource tea-rags://schema/documentation provides detailed docs for
rerank presets, custom weight signals, Qdrant filter syntax, and threshold guidance.
LLM can read on-demand instead of bloating every tool schema."
```

---

### Task 7: Update existing tests for breaking changes

**Files:**

- Modify: `tests/core/api/schema-builder.test.ts` (update ZodEnum assertions)
- Modify: `tests/mcp/tools/schemas.test.ts` (update for removed params)

**Step 1: Fix schema-builder tests**

Tests asserting `z.ZodEnum` type will break after Task 1. Update:

```typescript
// Replace:
expect(schema).toBeInstanceOf(z.ZodEnum);
expect(schema.options).toEqual([...]);

// With:
expect(schema.parse("relevance")).toBe("relevance");
expect(() => schema.parse("nonexistent")).toThrow();
```

**Step 2: Fix schemas.test.ts for removed params**

Remove/update tests for `documentationOnly` coercion — replaced by
`documentation` enum.

**Step 3: Run full test suite**

Run: `npx vitest run` Expected: ALL PASS

**Step 4: Commit**

```bash
git add tests/core/api/schema-builder.test.ts tests/mcp/tools/schemas.test.ts
git commit -m "test(mcp): update tests for schema improvements

Adapt schema-builder tests for z.union preset schema (was z.enum).
Update schemas tests for consolidated filter params."
```

---

### Task 8: Integration verification

**Step 1: Build**

Run: `npm run build` Expected: SUCCESS

**Step 2: Reconnect MCP server and verify**

Use AskUserQuestion to request MCP reconnect. Then:

- Call `get_index_status` — should work
- Call `semantic_search` with `documentation: "only"` — should filter correctly
- Call `rank_chunks` with `rerank: "decomposition"` — should work
- Read resource `tea-rags://schema/documentation` — should return markdown

**Step 3: Final commit if any fixes needed**

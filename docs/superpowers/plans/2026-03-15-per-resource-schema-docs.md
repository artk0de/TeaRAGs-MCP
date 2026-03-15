# Per-Resource Schema Documentation Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development
> (if subagents available) or superpowers:executing-plans to implement this
> plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Split monolithic schema documentation resource into 4 focused MCP
resources and compact tool JSON Schema by removing verbose descriptions.

**Architecture:** Extend `PresetDescriptors` to include full preset details from
Reranker. Replace `z.literal().describe()` with `z.enum()` in SchemaBuilder.
Register 4 resources (overview, presets, signals, filters) instead of 1.

**Tech Stack:** Zod, MCP SDK (`@modelcontextprotocol/sdk`), Vitest

**Spec:** `docs/superpowers/specs/2026-03-15-per-resource-schema-docs-design.md`

---

## File Structure

| File                                            | Action | Responsibility                                               |
| ----------------------------------------------- | ------ | ------------------------------------------------------------ |
| `src/core/api/public/dto/explore.ts`            | Modify | Add `PresetDetail` type, extend `PresetDescriptors`          |
| `src/core/domains/explore/reranker.ts`          | Modify | Add `getPresetDetails(tool)` method                          |
| `src/core/api/public/app.ts`                    | Modify | Populate `presetDetails` in `getSchemaDescriptors()`         |
| `src/core/api/internal/infra/schema-builder.ts` | Modify | Compact: `z.enum()` for presets, no `.describe()` on signals |
| `src/mcp/resources/index.ts`                    | Modify | Replace 1 resource with 4, replace builder function          |
| `src/mcp/tools/code.ts`                         | Modify | Add overview link to search_code description                 |
| `src/mcp/tools/explore.ts`                      | Modify | Add overview link to 4 search tool descriptions              |
| `tests/core/api/schema-builder.test.ts`         | Modify | Update for compacted schema (no descriptions)                |
| `tests/mcp/resources/resources.test.ts`         | Create | Test 4 resource builders                                     |

---

## Chunk 1: API Extension + Schema Compaction

### Task 1: Extend PresetDescriptors with preset details

**Files:**

- Modify: `src/core/api/public/dto/explore.ts:140-150`
- Modify: `src/core/domains/explore/reranker.ts:186-191`
- Modify: `src/core/api/public/app.ts:124-136`
- Test: `tests/core/api/schema-builder.test.ts` (mock update)

- [ ] **Step 1: Write failing test for getPresetDetails**

Add to `tests/core/api/schema-builder.test.ts` — update `createMockReranker` and
add test:

```typescript
// Add to createMockReranker — new method:
// In the return object, add:
getPresetDetails: (tool: string) =>
  (presets[tool] ?? []).map((name) => ({
    name,
    description: descriptions[name] ?? `${name} preset`,
    weights: Object.keys(overrides?.presetWeights?.[name] ?? { similarity: 1 }),
    tools: Object.entries(presets)
      .filter(([, names]) => names.includes(name))
      .map(([t]) => t),
  })),
```

Add new test in a new `describe("getPresetDetails")` block:

```typescript
describe("getPresetDetails (via mock)", () => {
  it("returns preset details with weight keys and tools", () => {
    const mock = createMockReranker({
      presets: { semantic_search: ["relevance", "techDebt"] },
      presetDescriptions: {
        relevance: "Pure similarity",
        techDebt: "Legacy code finder",
      },
      presetWeights: {
        relevance: { similarity: 1 },
        techDebt: { age: 0.5, churn: 0.3, similarity: 0.2 },
      },
    });
    const details = mock.getPresetDetails!("semantic_search");
    expect(details).toHaveLength(2);
    expect(details[0]).toEqual({
      name: "relevance",
      description: "Pure similarity",
      weights: ["similarity"],
      tools: ["semantic_search"],
    });
    expect(details[1].weights).toEqual(["age", "churn", "similarity"]);
  });
});
```

Note: update `createMockReranker`:

- Overrides type: add `presetWeights?: Record<string, Record<string, number>>`
- Return type: change
  `Pick<Reranker, "getDescriptorInfo" | "getPresetNames" | "getPresetDescriptions">`
  to
  `Pick<Reranker, "getDescriptorInfo" | "getPresetNames" | "getPresetDescriptions" | "getPresetDetails">`
- Remove `!` from `mock.getPresetDetails!` in test — Pick type now includes it.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/core/api/schema-builder.test.ts` Expected: FAIL —
`getPresetDetails` not in mock type / not called

- [ ] **Step 3: Add PresetDetail type to DTO**

In `src/core/api/public/dto/explore.ts`, after `SignalDescriptor` (line 143):

```typescript
export interface PresetDetail {
  name: string;
  description: string;
  weights: string[];
  tools: string[];
}
```

Extend `PresetDescriptors`:

```typescript
export interface PresetDescriptors {
  /** Preset names keyed by tool name */
  presetNames: Record<string, string[]>;
  /** Full preset details keyed by tool name */
  presetDetails: Record<string, PresetDetail[]>;
  /** All derived signal descriptors available for custom weights */
  signalDescriptors: SignalDescriptor[];
}
```

- [ ] **Step 4: Add getPresetDetails to Reranker**

In `src/core/domains/explore/reranker.ts`, after `getPresetDescriptions` (line
191):

```typescript
/** Full preset details for resource documentation. */
getPresetDetails(tool: string): { name: string; description: string; weights: string[]; tools: string[] }[] {
  return this.resolvedPresets
    .filter((p) => this.matchesTool(p, tool))
    .map((p) => ({
      name: p.name,
      description: p.description,
      weights: Object.keys(p.weights).filter((k) => p.weights[k] !== undefined),
      tools: [...p.tools],
    }));
}
```

- [ ] **Step 5: Extend App.getSchemaDescriptors()**

In `src/core/api/public/app.ts`, modify `getSchemaDescriptors` (line 125-136):

```typescript
getSchemaDescriptors: () => {
  const info = deps.reranker.getDescriptorInfo();
  const tools = ["semantic_search", "hybrid_search", "search_code", "rank_chunks", "find_similar"];
  const presetNames: Record<string, string[]> = {};
  const presetDetails: Record<string, PresetDetail[]> = {};
  for (const tool of tools) {
    presetNames[tool] = deps.reranker.getPresetNames(tool);
    presetDetails[tool] = deps.reranker.getPresetDetails(tool);
  }
  return {
    presetNames,
    presetDetails,
    signalDescriptors: info.map((d) => ({ name: d.name, description: d.description })),
  };
},
```

Import `PresetDetail` from dto. Also ensure `PresetDetail` is re-exported from
`src/core/api/public/dto/index.ts` barrel file.

- [ ] **Step 6: Run tests**

Run: `npx vitest run tests/core/api/schema-builder.test.ts` Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add src/core/api/public/dto/explore.ts src/core/domains/explore/reranker.ts src/core/api/public/app.ts tests/core/api/schema-builder.test.ts
git commit -m "feat(api): extend PresetDescriptors with preset details for resource docs"
```

---

### Task 2: Compact SchemaBuilder — remove per-value descriptions

**Files:**

- Modify: `src/core/api/internal/infra/schema-builder.ts`
- Modify: `tests/core/api/schema-builder.test.ts`

- [ ] **Step 1: Update test expectations for compacted schema**

In `tests/core/api/schema-builder.test.ts`:

1. **Replace** test "includes description from descriptor" (line 78-84) with
   inverse assertion:

```typescript
it("does not include descriptions on weight fields", () => {
  const builder = new SchemaBuilder(createMockReranker() as Reranker);
  const schema = builder.buildScoringWeightsSchema();
  const recencyField = schema.shape.recency;
  expect(recencyField.description).toBeUndefined();
});
```

2. **Change** test "returns z.union with per-preset descriptions (not ZodEnum)"
   (line 115-130) — rename and update:

```typescript
it("returns z.enum for multiple presets (no per-value descriptions)", () => {
  const mock = createMockReranker({
    presets: { semantic_search: ["relevance", "techDebt"] },
  });
  const builder = new SchemaBuilder(mock as Reranker);
  const schema = builder.buildPresetSchema("semantic_search");

  expect(schema.parse("relevance")).toBe("relevance");
  expect(schema.parse("techDebt")).toBe("techDebt");
  expect(() => schema.parse("nonexistent")).toThrow();
  // Now uses ZodEnum instead of z.union(z.literal)
  expect(schema).toBeInstanceOf(z.ZodEnum);
});
```

3. **Change** test "returns z.literal for single preset" (line 132-142) — single
   preset still uses z.literal but without describe:

```typescript
it("returns z.literal for single preset (no description)", () => {
  const mock = createMockReranker({
    presets: { single_tool: ["only"] },
  });
  const builder = new SchemaBuilder(mock as Reranker);
  const schema = builder.buildPresetSchema("single_tool");

  expect(schema.parse("only")).toBe("only");
  expect(() => schema.parse("other")).toThrow();
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/core/api/schema-builder.test.ts` Expected: FAIL —
schema still returns z.union with descriptions

- [ ] **Step 3: Compact SchemaBuilder**

Replace `src/core/api/internal/infra/schema-builder.ts`:

```typescript
/**
 * SchemaBuilder — dynamic MCP schema generation via Reranker API (DIP).
 *
 * MCP layer imports SchemaBuilder from api/, never touches domain/foundation directly.
 * All signal descriptors and preset names come from Reranker.getDescriptorInfo()
 * and Reranker.getPresetNames(), which aggregate data from registered trajectories.
 *
 * Descriptions are intentionally omitted from the generated schemas — detailed
 * documentation lives in MCP resources (tea-rags://schema/*).
 */

import { z } from "zod";

import type { Reranker } from "../../../domains/explore/reranker.js";

export class SchemaBuilder {
  constructor(private readonly reranker: Reranker) {}

  /**
   * Build Zod schema for custom scoring weights.
   * Each derived signal becomes an optional numeric field (no descriptions).
   */
  buildScoringWeightsSchema(): z.ZodObject<
    Record<string, z.ZodOptional<z.ZodNumber>>
  > {
    const shape: Record<string, z.ZodOptional<z.ZodNumber>> = {};
    for (const d of this.reranker.getDescriptorInfo()) {
      shape[d.name] = z.number().optional();
    }
    return z.object(shape);
  }

  /**
   * Build Zod schema for preset names by tool.
   * Uses z.enum for compact JSON Schema output (no per-value descriptions).
   */
  buildPresetSchema(tool: string): z.ZodTypeAny {
    const names = this.reranker.getPresetNames(tool);
    if (names.length === 0) {
      throw new Error(`No presets registered for tool "${tool}"`);
    }
    if (names.length === 1) {
      return z.literal(names[0]);
    }
    const [first, second, ...rest] = names;
    return z.enum([first, second, ...rest]);
  }

  /**
   * Build the full rerank union schema: preset enum | { custom: weights }.
   */
  buildRerankSchema(tool: string) {
    const presetSchema = this.buildPresetSchema(tool);
    const weightsSchema = this.buildScoringWeightsSchema();
    return z.union([presetSchema, z.object({ custom: weightsSchema })]);
  }
}
```

- [ ] **Step 4: Run tests**

Run: `npx vitest run tests/core/api/schema-builder.test.ts` Expected: PASS

- [ ] **Step 5: Run full test suite**

Run: `npx vitest run` Expected: PASS (other tests that use schemas should still
work — enum validates same values)

- [ ] **Step 6: Commit**

```bash
git add src/core/api/internal/infra/schema-builder.ts tests/core/api/schema-builder.test.ts
git commit -m "improve(mcp): compact SchemaBuilder — remove per-value descriptions from tool schema"
```

---

## Chunk 2: Resources + Tool Description Links

### Task 3: Replace single resource with 4 focused resources

**Files:**

- Modify: `src/mcp/resources/index.ts`
- Create: `tests/mcp/resources/resources.test.ts`

- [ ] **Step 1: Write tests for resource builders**

Create `tests/mcp/resources/resources.test.ts`:

```typescript
import { describe, expect, it } from "vitest";

import type { PresetDescriptors } from "../../../src/core/api/public/dto/explore.js";
// Import builder functions (will be exported for testing)
import {
  buildFiltersDoc,
  buildOverview,
  buildPresetsDoc,
  buildSignalsDoc,
} from "../../../src/mcp/resources/index.js";

const mockDescriptors: PresetDescriptors = {
  presetNames: {
    semantic_search: ["relevance", "techDebt"],
    search_code: ["relevance", "recent"],
  },
  presetDetails: {
    semantic_search: [
      {
        name: "relevance",
        description: "Pure similarity",
        weights: ["similarity"],
        tools: ["semantic_search", "hybrid_search"],
      },
      {
        name: "techDebt",
        description: "Legacy code finder",
        weights: ["age", "churn", "similarity"],
        tools: ["semantic_search", "hybrid_search"],
      },
    ],
    search_code: [
      {
        name: "relevance",
        description: "Pure similarity",
        weights: ["similarity"],
        tools: ["search_code"],
      },
      {
        name: "recent",
        description: "Recent code",
        weights: ["recency", "similarity"],
        tools: ["search_code"],
      },
    ],
  },
  signalDescriptors: [
    { name: "similarity", description: "Semantic similarity score" },
    { name: "recency", description: "Inverse of age" },
    { name: "age", description: "Direct age signal" },
    { name: "churn", description: "Commit frequency" },
  ],
};

describe("Resource builders", () => {
  describe("buildOverview", () => {
    it("lists all schema resource URIs", () => {
      const md = buildOverview();
      expect(md).toContain("tea-rags://schema/presets");
      expect(md).toContain("tea-rags://schema/signals");
      expect(md).toContain("tea-rags://schema/filters");
    });

    it("lists all tools in quick reference", () => {
      const md = buildOverview();
      expect(md).toContain("search_code");
      expect(md).toContain("semantic_search");
      expect(md).toContain("hybrid_search");
      expect(md).toContain("rank_chunks");
      expect(md).toContain("find_similar");
    });
  });

  describe("buildPresetsDoc", () => {
    it("contains all preset names with descriptions", () => {
      const md = buildPresetsDoc(mockDescriptors);
      expect(md).toContain("relevance");
      expect(md).toContain("Pure similarity");
      expect(md).toContain("techDebt");
      expect(md).toContain("Legacy code finder");
      expect(md).toContain("recent");
      expect(md).toContain("Recent code");
    });

    it("lists weight keys for each preset", () => {
      const md = buildPresetsDoc(mockDescriptors);
      expect(md).toContain("age");
      expect(md).toContain("churn");
      expect(md).toContain("similarity");
    });

    it("lists available tools for each preset", () => {
      const md = buildPresetsDoc(mockDescriptors);
      expect(md).toContain("semantic_search");
      expect(md).toContain("search_code");
    });

    it("handles empty presets for a tool gracefully", () => {
      const empty: PresetDescriptors = {
        presetNames: { some_tool: [] },
        presetDetails: { some_tool: [] },
        signalDescriptors: [],
      };
      const md = buildPresetsDoc(empty);
      expect(md).toBeDefined();
      expect(typeof md).toBe("string");
    });
  });

  describe("buildSignalsDoc", () => {
    it("contains all signal names with descriptions", () => {
      const md = buildSignalsDoc(mockDescriptors);
      expect(md).toContain("similarity");
      expect(md).toContain("Semantic similarity score");
      expect(md).toContain("recency");
      expect(md).toContain("Inverse of age");
    });
  });

  describe("buildFiltersDoc", () => {
    it("contains Qdrant operator syntax", () => {
      const md = buildFiltersDoc();
      expect(md).toContain("match");
      expect(md).toContain("range");
      expect(md).toContain("must");
      expect(md).toContain("should");
      expect(md).toContain("must_not");
    });

    it("contains threshold guidance", () => {
      const md = buildFiltersDoc();
      expect(md).toContain("minCommitCount");
      expect(md).toContain("minAgeDays");
    });

    it("contains available fields", () => {
      const md = buildFiltersDoc();
      expect(md).toContain("relativePath");
      expect(md).toContain("git.dominantAuthor");
      expect(md).toContain("imports");
    });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/mcp/resources/resources.test.ts` Expected: FAIL —
builder functions not exported / not found

- [ ] **Step 3: Implement resource builders and register resources**

Replace `src/mcp/resources/index.ts` with 4 builder functions + 4 resource
registrations. Key changes:

1. Export `buildOverview()`, `buildPresetsDoc(descriptors)`,
   `buildSignalsDoc(descriptors)`, `buildFiltersDoc()` — for testing.

2. Remove `buildSchemaDocumentation()` and the old `"schema-docs"` resource.
   **Keep existing `collections` and `collection-info` resource registrations
   unchanged.**

3. Register 4 resources:
   - `"schema-overview"` at `tea-rags://schema/overview`
   - `"schema-presets"` at `tea-rags://schema/presets`
   - `"schema-signals"` at `tea-rags://schema/signals`
   - `"schema-filters"` at `tea-rags://schema/filters`

4. `buildOverview()` — static markdown with resource catalog + tools quick
   reference.

5. `buildPresetsDoc(descriptors)` — iterate `presetDetails` per tool,
   deduplicate presets that appear in multiple tools, render: name, description,
   weights, tools.

6. `buildSignalsDoc(descriptors)` — iterate `signalDescriptors`, render: name,
   description.

7. `buildFiltersDoc()` — static markdown: operators, combining conditions,
   available fields, thresholds. Same content as current resource's filter
   sections.

- [ ] **Step 4: Run tests**

Run: `npx vitest run tests/mcp/resources/resources.test.ts` Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/mcp/resources/index.ts tests/mcp/resources/resources.test.ts
git commit -m "feat(mcp): split schema documentation into 4 focused MCP resources"
```

---

### Task 4: Add overview link to search tool descriptions

**Files:**

- Modify: `src/mcp/tools/code.ts`
- Modify: `src/mcp/tools/explore.ts`

- [ ] **Step 1: Add link to search_code description**

In `src/mcp/tools/code.ts`, append to search_code tool description (after the
last line of the description string):

```typescript
"\\n\\nFor detailed parameter docs (presets, signals, filters) see tea-rags://schema/overview";
```

- [ ] **Step 2: Add link to explore tool descriptions**

In `src/mcp/tools/explore.ts`, append the same line to descriptions of:

- `semantic_search`
- `hybrid_search`
- `rank_chunks`
- `find_similar`

- [ ] **Step 3: Build and type-check**

Run: `npm run build` Expected: PASS — no type errors

- [ ] **Step 4: Run full test suite**

Run: `npx vitest run` Expected: ALL PASS

- [ ] **Step 5: Commit**

```bash
git add src/mcp/tools/code.ts src/mcp/tools/explore.ts
git commit -m "improve(mcp): add schema overview link to search tool descriptions"
```

---

### Task 5: Integration verification

- [ ] **Step 1: Build**

Run: `npm run build` Expected: PASS

- [ ] **Step 2: Request MCP reconnect**

Ask user to reconnect tea-rags MCP server.

- [ ] **Step 3: Verify tool schema is compact**

Fetch `semantic_search` schema via ToolSearch. Verify:

- `rerank` field uses `enum` (not per-literal descriptions)
- `custom` object has signal keys without descriptions
- Tool description contains `tea-rags://schema/overview` link

- [ ] **Step 4: Verify resources**

Read all 4 resources via MCP:

- `tea-rags://schema/overview` — contains resource catalog + tools
- `tea-rags://schema/presets` — contains all presets with descriptions and
  weights
- `tea-rags://schema/signals` — contains all signals with descriptions
- `tea-rags://schema/filters` — contains operators, fields, thresholds

- [ ] **Step 5: Commit (if any fixes needed)**

Only if integration testing reveals issues.

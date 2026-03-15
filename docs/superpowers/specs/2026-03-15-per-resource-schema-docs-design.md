# Per-Resource Schema Documentation

## Problem

The current `tea-rags://schema/documentation` resource is a single markdown
document that duplicates information already present in tool JSON Schema (preset
descriptions, signal descriptions). Tool schema itself is bloated with
per-literal descriptions that inflate `tools/list` response size.

## Solution

Split documentation into 4 focused MCP resources. Compact tool schema to enums +
short hints. Each resource serves a specific agent need — agents read only what
they need per task.

## Architecture

### Responsibility Split

| Layer         | Responsibility                                      |
| ------------- | --------------------------------------------------- |
| Tool Schema   | What can be passed (enum names, types, short hints) |
| MCP Resources | What it means (reference documentation)             |
| Orchestration | When to apply (routing, triggers — CLAUDE rules)    |

### Resources

| URI                          | Title           | Content                                                    | Data Source                  |
| ---------------------------- | --------------- | ---------------------------------------------------------- | ---------------------------- |
| `tea-rags://schema/overview` | Schema Overview | Resource catalog + tools quick reference                   | Static text                  |
| `tea-rags://schema/presets`  | Rerank Presets  | Per-preset: description, signals used, available tools     | `app.getSchemaDescriptors()` |
| `tea-rags://schema/signals`  | Custom Signals  | Per-signal: description, L3 blending notes                 | `app.getSchemaDescriptors()` |
| `tea-rags://schema/filters`  | Filter Syntax   | Qdrant operators, combining conditions, fields, thresholds | Static text                  |

All resources return `mimeType: "text/markdown"`.

### Tool Schema Compaction

**Rerank presets** — replace per-literal descriptions with plain enum:

```typescript
// Before (bloated)
z.union([
  z.literal("relevance").describe("Pure semantic similarity ranking"),
  z.literal("techDebt").describe("Find legacy code with high churn..."),
  ...
])

// After (compact)
z.union([
  z.enum(["relevance", "techDebt", "hotspots", ...]),
  z.object({ custom: z.object({...}) })
])
```

**Custom signals** — remove per-key descriptions from schema:

```typescript
// Before
z.object({
  similarity: z.number().describe("Base semantic similarity score..."),
  recency: z.number().describe("Inverse of age..."),
  ...
})

// After
z.object({
  similarity: z.number().optional(),
  recency: z.number().optional(),
  ...
})
```

### Navigation: Tool → Resources

One link in each search tool's `description` field:

```
"Search code using natural language...
For detailed parameter docs see tea-rags://schema/overview"
```

Agent flow:

1. Calls tool → sees overview link in description
2. Reads overview → sees resource catalog with brief description of each
3. Reads specific resource as needed

Works for any MCP client that supports `resources/read`. Agents without resource
support still see enum names and short hints in schema.

## Resource Content

### overview

```markdown
# tea-rags Schema Overview

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
```

### presets

Generated from `app.getSchemaDescriptors()`. Per preset:

- Name
- Description (what it does)
- Signals used (weight keys)
- Available tools

No use-case routing (that's orchestration layer responsibility).

### signals

Generated from `app.getSchemaDescriptors()`. Per signal:

- Name (weight key)
- Description
- L3 blending behavior (if applicable)

### filters

Static markdown:

- Qdrant operators (`match`, `range`)
- Combining conditions (`must`/`should`/`must_not`)
- Available fields grouped by category (chunk metadata, git metadata, imports)
- Threshold guidance (typical values for `minCommitCount`, `minAgeDays`, etc.)

## Implementation

### Files Changed

- **Modify:** `src/mcp/resources/index.ts` — replace single resource with 4,
  replace `buildSchemaDocumentation()` with 4 builder functions
- **Modify:** `src/core/api/internal/infra/schema-builder.ts` — compact
  `buildPresetSchema()` (remove per-literal `.describe()`), compact
  `buildScoringWeightsSchema()` (remove per-signal `.describe()`)
- **Modify:** `src/core/api/public/dto/explore.ts` — extend `PresetDescriptors`
  with `presetDetails`
- **Modify:** `src/core/api/public/app.ts` — extend `getSchemaDescriptors()` to
  include preset details
- **Modify:** `src/core/domains/explore/reranker.ts` — add method to expose full
  preset objects
- **Modify:** `src/mcp/tools/code.ts` — add overview link to search_code
  description
- **Modify:** `src/mcp/tools/explore.ts` — add overview link to semantic_search,
  hybrid_search, rank_chunks, find_similar descriptions
- **Modify:** tests for schemas and resources

### SchemaDescriptors API Extension

Current `PresetDescriptors` exposes only `presetNames` and `signalDescriptors`.
The presets resource needs full preset metadata.

**Reranker** already has `getPresetDescriptions(tool)` returning
`{ name, description }[]`. `RerankPreset` interface includes `name`,
`description`, `tools`, `weights` (ScoringWeights), `overlayMask`,
`signalLevel`. All data exists — just not exposed through public API.

**Changes:**

1. Add to `PresetDescriptors`:

   ```typescript
   presetDetails: Record<
     string,
     { name: string; description: string; weights: string[]; tools: string[] }[]
   >;
   ```

2. Add to `Reranker`:

   ```typescript
   getPresetDetails(tool: string): { name: string; description: string; weights: string[]; tools: string[] }[]
   ```

   Extracts weight key names from `RerankPreset.weights`.

3. Extend `App.getSchemaDescriptors()` to populate `presetDetails` per tool.

### Data Flow

```
Reranker (existing data)
  ├─ getPresetNames(tool) → string[]
  ├─ getPresetDetails(tool) → { name, description, weights[], tools[] }[]  ← NEW
  └─ getDescriptorInfo() → { name, description }[]

App.getSchemaDescriptors() → PresetDescriptors
  ├─ presetNames: Record<toolName, presetName[]>
  ├─ presetDetails: Record<toolName, PresetDetail[]>  ← NEW
  └─ signalDescriptors: { name, description }[]

resources/index.ts
  ├─ buildOverview() → static markdown
  ├─ buildPresetsDoc(descriptors) → dynamic markdown
  ├─ buildSignalsDoc(descriptors) → dynamic markdown
  └─ buildFiltersDoc() → static markdown
```

## Test Plan

### Resource tests (`tests/mcp/resources/`)

- Each of the 4 resources returns valid markdown string
- Presets resource contains all registered preset names with descriptions
- Presets resource lists weight keys for each preset
- Signals resource contains all signal descriptors
- Overview resource lists all 3 schema resource URIs
- Resource builders handle empty data gracefully (no presets for a tool → skip)

### Schema compaction tests (`tests/mcp/tools/schemas.test.ts`)

- Rerank schema uses `z.enum()` without per-value descriptions
- Custom signals schema has no `.describe()` on individual keys
- Schema still validates preset names and custom weight objects correctly

### Integration

- `tools/list` response size decreased (no per-literal descriptions)
- `resources/list` shows 4 resources (overview, presets, signals, filters)
  instead of 1
- `resources/read` for each URI returns expected content

## Out of Scope

- Orchestration layer changes (CLAUDE rules already handle routing)
- Per-tool resources (tool schema via `tools/list` is sufficient)
- JSON format for resources (markdown chosen for readability)

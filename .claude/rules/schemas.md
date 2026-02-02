---
paths:
  - "src/tools/schemas.ts"
  - "src/code/types.ts"
  - "src/code/pipeline/types.ts"
---

# MCP Schema Standards

## Metadata Types → Schema Sync (MANDATORY)

When modifying `CodeChunk.metadata` in `src/code/types.ts`:

1. **Add field to `src/tools/schemas.ts`** filter description
2. **Update `src/code/pipeline/types.ts`** ChunkItem if needed
3. **Update README.md** response examples
4. **Update this file** under "Search Result Payload Fields"

**Files that define chunk metadata:**
- `src/code/types.ts` → `CodeChunk.metadata` interface
- `src/code/pipeline/types.ts` → `ChunkItem.chunk.metadata`
- `src/code/pipeline/chunk-pipeline.ts` → payload construction
- `src/code/indexer.ts` → metadata extraction

## Zod Schema Requirements

Every tool parameter MUST have `.describe()` - this is how MCP protocol communicates parameter purpose to AI agents.

```typescript
export const ToolNameSchema = {
  // Required parameter
  requiredParam: z.string().describe("Clear description of what this parameter does"),

  // Optional with default
  optionalParam: z
    .number()
    .optional()
    .describe("Description including default value (default: 5)"),

  // Enum
  mode: z
    .enum(["option1", "option2"])
    .optional()
    .describe("Available modes: option1 (does X), option2 (does Y)"),

  // Complex object
  filter: z
    .record(z.any())
    .optional()
    .describe("Qdrant filter object with must/should/must_not conditions"),
};
```

## Naming Conventions

- Schema name: `{ToolName}Schema` (PascalCase + Schema suffix)
- Export all schemas from `schemas.ts`
- Group related schemas together

## Description Guidelines

Good descriptions include:
- What the parameter does
- Valid values or format
- Default value (if optional)
- Example (for complex types)

Bad:
```typescript
limit: z.number().optional().describe("Limit")
```

Good:
```typescript
limit: z
  .number()
  .optional()
  .describe("Maximum number of results to return (default: 5, max: 100)")
```

## After Schema Changes

1. Update handler to destructure new params
2. Update tests
3. Update README.md if user-facing
4. Run `npm run type-check` to validate

## Response Payload Documentation (MANDATORY)

When adding/modifying fields in tool responses (payload), update ALL of these:

| Location | What to Update |
|----------|----------------|
| `src/tools/schemas.ts` | Add field to `filter` description (for filterable fields) |
| `README.md` | Add field to example JSON in relevant section |
| Tool description in handler | Mention new field if significant |

### Search Result Payload Fields

All `semantic_search`, `hybrid_search`, `search_code` responses include:

```
score, relativePath, startLine, endLine, language, fileExtension,
chunkType, name, parentName, parentType, isDocumentation,
imports (string[]),  // file-level imports
git: { lastModifiedAt, firstCreatedAt, dominantAuthor, dominantAuthorEmail,
       authors, commitCount, lastCommitHash, ageDays, taskIds }
```

## Pre-Completion Verification (MANDATORY)

**Before claiming work is complete, verify:**

- [ ] Schema describes all new/modified fields
- [ ] Filter description lists all filterable fields
- [ ] README examples show new fields
- [ ] Tool descriptions mention significant changes
- [ ] `npm run build` passes
- [ ] `npm test` passes

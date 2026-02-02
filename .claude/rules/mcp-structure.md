---
paths:
  - "src/tools/**/*.ts"
  - "src/qdrant/**/*.ts"
  - "src/code/**/*.ts"
---

# MCP Server Structure

## File Organization (STRICT)

This is an MCP server. When modifying tools, follow this structure:

```
src/tools/
├── schemas.ts      # All Zod schemas (tool input validation)
├── index.ts        # Tool registration orchestrator
├── collection.ts   # Collection management tools
├── document.ts     # Document CRUD tools
├── search.ts       # semantic_search, hybrid_search
├── code.ts         # index_codebase, search_code, reindex_changes
└── *.test.ts       # Tests for each module
```

## When Adding/Modifying Tools

| Change Type | Files to Update |
|-------------|-----------------|
| New tool parameter | 1. `schemas.ts` (Zod schema with `.describe()`) |
| | 2. Handler file (`search.ts`, `code.ts`, etc.) |
| | 3. Test file (`*.test.ts`) |
| New tool | 1. `schemas.ts` (new schema) |
| | 2. Handler file (new or existing) |
| | 3. `index.ts` (if new handler file) |
| | 4. Test file |
| Tool logic change | 1. Handler file |
| | 2. Test file |

## Schema Standards

Every tool parameter MUST have `.describe()` for MCP protocol:

```typescript
// In schemas.ts
export const MyToolSchema = {
  requiredParam: z.string().describe("Clear description for AI agent"),
  optionalParam: z
    .number()
    .optional()
    .describe("What this does (default: X)"),
};
```

## Handler Pattern

```typescript
// In <domain>.ts
server.registerTool(
  "tool_name",
  {
    title: "Human Title",
    description: "Detailed description for AI agent...",
    inputSchema: schemas.MyToolSchema,
  },
  async ({ param1, param2 }) => {
    // Implementation
    return {
      content: [{ type: "text", text: result }],
    };
  },
);
```

## Checklist for Tool Changes

Before completing any tool modification:

- [ ] Schema defined in `src/tools/schemas.ts` with `.describe()` on all fields
- [ ] Handler uses schema: `inputSchema: schemas.XxxSchema`
- [ ] Handler destructures all schema params
- [ ] Test covers new functionality in `src/tools/*.test.ts`
- [ ] If new handler file: registered in `src/tools/index.ts`

## Dependencies

- Tool handlers → `src/qdrant/client.ts` (Qdrant operations)
- Tool handlers → `src/code/indexer.ts` (code indexing)
- Tool handlers → `src/embeddings/` (embedding providers)

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

## API Contract Changes (MANDATORY)

When you change ANY of these, you MUST update `src/tools/schemas.ts`:

| Change in Code | Required Schema Update |
|----------------|------------------------|
| New enum value in handler | Add to `.enum([...])` with description |
| New parameter used | Add field with `.describe()` |
| Parameter type change | Update Zod type |
| New response field | Update tool description |
| Default value change | Update `.describe()` text |
| Behavior change | Update tool description |

### Examples

**Adding enum value:**
```typescript
// Before: rerank?: "relevance" | "recent"
// After: rerank?: "relevance" | "recent" | "hotspots"

// schemas.ts MUST be updated:
rerank: z
  .enum(["relevance", "recent", "hotspots"])  // ← add new value
  .optional()
  .describe("... hotspots: find high-churn code")  // ← describe it
```

**Adding parameter:**
```typescript
// If handler now uses `metaOnly` param:
metaOnly: z
  .boolean()
  .optional()
  .describe("Return only metadata without content (default: false)")
```

## Checklist for Tool Changes

Before completing any tool modification:

- [ ] Schema defined in `src/tools/schemas.ts` with `.describe()` on all fields
- [ ] **All enum values documented** in `.describe()`
- [ ] **All new parameters added** to schema
- [ ] Handler uses schema: `inputSchema: schemas.XxxSchema`
- [ ] Handler destructures all schema params
- [ ] Test covers new functionality in `src/tools/*.test.ts`
- [ ] If new handler file: registered in `src/tools/index.ts`
- [ ] README.md updated if user-facing change

## Dependencies

- Tool handlers → `src/qdrant/client.ts` (Qdrant operations)
- Tool handlers → `src/code/indexer.ts` (code indexing)
- Tool handlers → `src/embeddings/` (embedding providers)

## MCP Testing Workflow (MANDATORY)

**This project IS an MCP server. Code changes require server reconnect before integration testing.**

### After modifying any src/ files:

1. **Build & Unit Tests**
   ```bash
   npm run build && npm test
   ```

2. **Request MCP Reconnect** (MANDATORY before using `mcp__tea-rags__*` tools)

   Use `AskUserQuestion` tool to ask user to reconnect:
   ```
   question: "MCP server code was modified. Please reconnect tea-rags MCP (/mcp reconnect tea-rags), then select 'Done'."
   options: ["Done - reconnected", "Skip integration testing"]
   ```

3. **Integration Testing** (only after user confirms reconnect)
   - Use `mcp__tea-rags__*` tools to verify changes
   - For indexing changes: use `index_codebase` with `forceReindex: true`

### Why this matters

- MCP server runs as **separate process**
- Code changes **don't auto-reload**
- Testing with old server = **false positives/negatives**
- Always: build → reconnect → test with `mcp__tea-rags__*`

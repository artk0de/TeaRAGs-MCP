---
name: add-mcp-endpoint
description:
  Expose new tool to LLM clients via MCP protocol — schema, handler, App method,
  docs in one coordinated change. Triggers on "add MCP tool", "new endpoint that
  returns X", "expose Y as a tool", "новый MCP tool". NOT for modifying an
  existing tool's schema — just edit the tool file directly.
---

# Add MCP Endpoint

## Implementation Checklist (MUST complete in order)

- [ ] DTO created in `public/dto/<domain>.ts` (via add-dto skill)
- [ ] DTO re-exported via barrel chain: `dto/<domain>.ts` → `dto/index.ts` →
      `public/index.ts` → `api/index.ts`
- [ ] Work placed per `facade-discipline.md` three-question tree: strategy
      (`domains/explore/strategies/`), query (`domains/explore/queries/`), ops
      (`api/internal/ops/`), or pure facade dispatcher
- [ ] Facade method ≤ 20 lines (resolve → guard → [ensureStats] → dispatch →
      finalize); no inline filter construction, no `Map`/`reduce` aggregation,
      no indexing-mode branching
- [ ] Filter building (if any) uses `registry.buildMergedFilter()` — not
      hand-built `{ must: [...] }` shapes in the facade
- [ ] Validation >5 lines extracted to named validator function
- [ ] App interface method added in `public/app.ts`
- [ ] `createApp()` wiring added in `public/app.ts` (delegate to
      facade/ops/query/strategy)
- [ ] `AppDeps` updated if new internal class introduced
- [ ] Zod schema in `mcp/tools/schemas.ts`
- [ ] Tool registered in `mcp/tools/<domain>.ts`
- [ ] If reranking supported: tool name added to preset `tools[]` arrays and
      `getSchemaDescriptors` list
- [ ] Tests written next to implementation (strategy/query/ops test — not a
      facade test) and passing
- [ ] Docusaurus docs updated (`website/docs/api/tools.md` + relevant pages)
- [ ] `CLAUDE.local.md` updated
- [ ] Build + full test suite passing

🛑 Each row = gate — do NOT proceed to next without finishing current.

Two-phase: define endpoint in core, then expose via MCP.

## Phase 1: Core API Layer

### 1.1 Add DTO

Add request/response types in `src/core/api/public/dto/<domain>.ts`.

**Choose the domain file:**

| Domain file         | Contains                                                                |
| ------------------- | ----------------------------------------------------------------------- |
| `dto/explore.ts`    | Search types (SemanticSearchRequest, ExploreResponse, etc.)             |
| `dto/ingest.ts`     | Indexing types (IndexOptions, IndexStats, ChangeStats, etc.)            |
| `dto/collection.ts` | Collection CRUD types (CreateCollectionRequest, CollectionInfo)         |
| `dto/document.ts`   | Document add/delete types (AddDocumentsRequest, DeleteDocumentsRequest) |

None fit → create `dto/<new-domain>.ts` + add re-export to `dto/index.ts`.

**DTO rules:**

- Request types end with `Request` (e.g., `SemanticSearchRequest`)
- Response types specific — no generic `Response` suffix
- Extend `CollectionRef` for endpoints accepting `collection` or `path`
- Extend `TypedFilterParams` for endpoints with trajectory filters
- Pure interfaces only (no classes, no logic)
- Import only from `contracts/` or `infra/` if needed

**Export chain (MANDATORY):**

1. Type defined in `dto/<domain>.ts`
2. Re-exported from `dto/index.ts` (automatic if using existing domain file)
3. Re-exported through `public/index.ts` → `api/index.ts`
4. If `contracts/types/app.ts` re-exports this domain — add to its re-export
   list for backward compatibility

### 1.2 Add method to App interface

In `src/core/api/public/app.ts`:

1. Import new DTO from `./dto/index.js`

2. Add method signature to `App` interface in matching category group, with
   comment pointing to internal implementation:

```typescript
// -- <Category> (→ internal/<path>) --
newMethod: (request: NewRequest) => Promise<NewResponse>;
```

Existing categories: Search, Indexing, Collections, Documents, Schema
descriptors, Drift monitoring. Create new category if none fit.

3. Wire method in `createApp()` in same file — delegate to appropriate internal
   class:

```typescript
// In createApp() return object:
newMethod: async (req) => deps.<facade>.newMethod(req),
```

Method needs new dependency (new facade/ops class) → add to `AppDeps` interface
in same file, instantiate in `createApp()`.

### 1.3 Implement in internal

**MUST read `.claude/rules/facade-discipline.md` first.** Facades = thin
dispatchers — MUST NEVER contain business logic. Facade method is last thing you
write, not first. Put work in correct class, then add ≤20-line dispatcher to
facade.

**Where actual work lives** (answer three questions in order; first "yes" wins):

| The method...                                  | → Work goes in                                    | Facade method                                        |
| ---------------------------------------------- | ------------------------------------------------- | ---------------------------------------------------- |
| 1. Searches / ranks / scrolls chunks?          | new **strategy** in `domains/explore/strategies/` | resolve + guard + `executeExplore(strategy, ctx)`    |
| 2. Aggregates data from Qdrant w/o vec search? | new **query** in `domains/explore/queries/`       | resolve + guard + `this.<name>Query.run(collection)` |
| 3. Mutates / branches indexing or CRUD?        | new **ops** in `api/internal/ops/`                | resolve + guard + `this.<name>Ops.run(...)`          |
| None of the above (pure forwarding 1-4 lines)  | stays in facade as dispatcher                     | the one-liner itself (e.g. `clearIndex`)             |

**Existing ops** (`CollectionOps`, `DocumentOps`) — MUST extend only if new
method belongs to same responsibility. New CRUD area MUST get new ops class.

**MUST NEVER do in the facade** (patterns `facade-discipline.md` explicitly
forbids):

- **MUST NEVER inline Qdrant filter construction** (`{ must: [...] }`) in the
  facade.
- **MUST NEVER perform `Map`/`reduce` aggregation** in the facade.
- **MUST NEVER branch on indexing modes** with multi-branch `if/else` in the
  facade.
- **MUST NEVER call parallel `scrollFiltered` with dedup** in the facade.
- **MUST NEVER resolve presets** in the facade.

**Filter building (MUST):** use
`registry.buildMergedFilter(typedParams, rawFilter, level)` from facade, pass
result via `ExploreContext.filter` into strategy. Facade MUST NEVER construct
filter shapes itself.

**Validation (MUST):** request-shape validation (mutex params, cross-field
rules) up to ~5 lines MAY live inline in facade as guard step. Past that, MUST
extract named validator function (e.g. `validateFindByTaskIdRequest`) into
`api/errors.ts` or alongside, and MUST throw typed errors per `typed-errors.md`.

After placing work, MUST update `AppDeps` in `public/app.ts` if new internal
class created, and MUST wire it in `createApp()`.

### 1.4 Verify core layer

```bash
npx tsc --noEmit
npx vitest run tests/core/api/
```

## Phase 2: MCP Tool Registration

### 2.1 Define Zod schema

In `src/mcp/tools/schemas.ts`:

**For static schemas** (no dynamic content from SchemaBuilder):

- Add new exported const (e.g., `export const NewToolSchema = { ... }`)
- Use `z.string()`, `coerceNumber()`, `coerceBoolean()` for params
- Every field needs `.describe()` with clear description for LLM consumers

**For dynamic schemas** (need SchemaBuilder for rerank presets/signals):

- Add to `createSearchSchemas()` function
- Use `schemaBuilder.buildRerankSchema(toolName)` for rerank param
- Use `typedFilterFields()` for standard filters
- Use `collectionPathFields()` for collection/path resolution
- Use `searchCommonFields()` for query/limit/filter/pathPattern

Schema conventions:

```typescript
export const NewToolSchema = {
  // Required params first, then optional
  requiredParam: z.string().describe("Clear description for AI agents"),
  optionalParam: coerceNumber()
    .optional()
    .describe("Description with default value mention (default: 10)"),
};
```

### 2.2 Register the MCP tool

In appropriate `src/mcp/tools/<domain>.ts` file (explore, code, collection,
document), or create new file if needed:

```typescript
server.registerTool(
  "tool_name", // snake_case, matches MCP convention
  {
    description: "One-line description for tool discovery",
    inputSchema: NewToolSchema,
  },
  async ({ input }) => {
    try {
      const result = await app.newMethod(input);
      return formatMcpResponse(result); // or formatMcpText()
    } catch (error) {
      return formatMcpError(error);
    }
  },
);
```

Creating new tool file:

1. Export `registerNewTools(server, deps)` function
2. Call from `src/mcp/tools/index.ts` in `registerAllTools()`

### 2.3 Tool naming rules

- Tool names `snake_case` (e.g., `semantic_search`, `index_codebase`)
- Match domain: search tools in explore.ts, index tools in code.ts
- Descriptions for AI agents — explicit about when to use tool

### 2.4 Response formatting

Use existing formatters from `src/mcp/format.ts`:

| Function                               | When                                            |
| -------------------------------------- | ----------------------------------------------- |
| `formatMcpResponse(data)`              | JSON response (search results, collection info) |
| `formatMcpText(text)`                  | Plain text response                             |
| `formatMcpError(error)`                | Error response                                  |
| `appendDriftWarning(content, warning)` | Add drift warning to response                   |
| `sanitizeRerank(input)`                | Clean rerank param from MCP input               |

### 2.5 Update Docusaurus documentation

Update tools reference page `website/docs/api/tools.md`:

1. Add tool to appropriate section table (Collection Management, Document
   Operations, Code Vectorization, or create new section)
2. Non-trivial parameters → add parameters subsection under
   `## Search Parameters` or new `##` section

Tool introduces new concept (new rerank preset, new filter type):

- Update relevant pages in `website/docs/usage/` (filters.md, query-modes.md,
  git-enrichments.md)
- Update `website/docs/agent-integration/search-strategies/` if affects search
  workflows

Follow docusaurus rules from `.claude/rules/documentation.md`:

- Use `<MermaidTeaRAGs>` for diagrams (not plain mermaid code blocks)
- Use `<AiQuery>` for example prompts (not blockquotes)
- Use correct signal naming (chunk-level vs file-level)

### 2.6 Update CLAUDE.local.md

Update `CLAUDE.local.md` with:

- New tool name and description
- Parameters and their types
- Example usage
- Which rerank presets apply (if search tool)

### 2.7 Verify full stack

```bash
npx tsc --noEmit
npx vitest run
```

After code changes, request MCP server reconnect before integration testing with
`mcp__tea-rags__*` tools.

## Checklist

Phase 2 checklist hoisted to top — see Implementation Checklist.

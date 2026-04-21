---
name: add-mcp-endpoint
description:
  Add a new MCP tool endpoint with schema, App method, and documentation
---

# Add MCP Endpoint

Two-phase process: define the endpoint in core, then expose it via MCP.

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

If none fit, create `dto/<new-domain>.ts` and add re-export to `dto/index.ts`.

**DTO rules:**

- Request types end with `Request` (e.g., `SemanticSearchRequest`)
- Response types are specific — no generic `Response` suffix
- Extend `CollectionRef` for endpoints accepting `collection` or `path`
- Extend `TypedFilterParams` for endpoints with trajectory filters
- Pure interfaces only (no classes, no logic)
- Import only from `contracts/` or `infra/` if needed

**Export chain (MANDATORY):**

1. Type is defined in `dto/<domain>.ts`
2. Re-exported from `dto/index.ts` (automatic if using existing domain file)
3. Re-exported through `public/index.ts` → `api/index.ts`
4. If `contracts/types/app.ts` re-exports this domain — add to its re-export
   list for backward compatibility

### 1.2 Add method to App interface

In `src/core/api/public/app.ts`:

1. Import the new DTO from `./dto/index.js`

2. Add the method signature to the `App` interface in the matching category
   group, with a comment pointing to the internal implementation:

```typescript
// -- <Category> (→ internal/<path>) --
newMethod: (request: NewRequest) => Promise<NewResponse>;
```

Existing categories: Search, Indexing, Collections, Documents, Schema
descriptors, Drift monitoring. Create a new category if none fit.

3. Wire the method in `createApp()` in the same file — delegate to the
   appropriate internal class:

```typescript
// In createApp() return object:
newMethod: async (req) => deps.<facade>.newMethod(req),
```

If the method needs a new dependency (new facade/ops class), add it to `AppDeps`
interface in the same file and instantiate it in `createApp()`.

### 1.3 Implement in internal

**Read `.claude/rules/facade-discipline.md` first.** Facades are thin
dispatchers — they never contain business logic. The facade method is the last
thing you write, not the first. Put the work in the correct class, then add a
≤20-line dispatcher to the facade.

**Where the actual work lives** (answer the three questions in order; first
"yes" wins):

| The method...                                  | → Work goes in                                    | Facade method                                        |
| ---------------------------------------------- | ------------------------------------------------- | ---------------------------------------------------- |
| 1. Searches / ranks / scrolls chunks?          | new **strategy** in `domains/explore/strategies/` | resolve + guard + `executeExplore(strategy, ctx)`    |
| 2. Aggregates data from Qdrant w/o vec search? | new **query** in `domains/explore/queries/`       | resolve + guard + `this.<name>Query.run(collection)` |
| 3. Mutates / branches indexing or CRUD?        | new **ops** in `api/internal/ops/`                | resolve + guard + `this.<name>Ops.run(...)`          |
| None of the above (pure forwarding 1-4 lines)  | stays in facade as dispatcher                     | the one-liner itself (e.g. `clearIndex`)             |

**Existing ops** (`CollectionOps`, `DocumentOps`) — extend them only if the new
method belongs to the same responsibility. A new CRUD area gets a new ops class.

**Never do in the facade:** inline Qdrant filter construction
(`{ must: [...] }`), `Map`/`reduce` aggregation, multi-branch `if/else` for
indexing modes, parallel `scrollFiltered` calls with dedup, preset resolution.
These are the patterns `facade-discipline.md` explicitly forbids.

**Filter building:** use
`registry.buildMergedFilter(typedParams, rawFilter, level)` from the facade,
pass the result via `ExploreContext.filter` into the strategy. The facade never
constructs filter shapes itself.

**Validation** of request shape (mutex params, cross-field rules): up to ~5
lines may live inline in the facade as the guard step. Past that, extract a
named validator function (e.g. `validateFindByTaskIdRequest`) into
`api/errors.ts` or alongside, and throw typed errors per `typed-errors.md`.

After placing the work, update `AppDeps` in `public/app.ts` if a new internal
class was created, and wire it in `createApp()`.

### 1.4 Verify core layer

```bash
npx tsc --noEmit
npx vitest run tests/core/api/
```

## Phase 2: MCP Tool Registration

### 2.1 Define Zod schema

In `src/mcp/tools/schemas.ts`:

**For static schemas** (no dynamic content from SchemaBuilder):

- Add a new exported const (e.g., `export const NewToolSchema = { ... }`)
- Use `z.string()`, `coerceNumber()`, `coerceBoolean()` for params
- Every field needs `.describe()` with a clear description for LLM consumers

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

In the appropriate `src/mcp/tools/<domain>.ts` file (explore, code, collection,
document), or create a new file if needed:

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

If creating a new tool file:

1. Export a `registerNewTools(server, deps)` function
2. Call it from `src/mcp/tools/index.ts` in `registerAllTools()`

### 2.3 Tool naming rules

- Tool names are `snake_case` (e.g., `semantic_search`, `index_codebase`)
- Match the domain: search tools in explore.ts, index tools in code.ts
- Descriptions are for AI agents — be explicit about when to use the tool

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

Update the tools reference page `website/docs/api/tools.md`:

1. Add tool to the appropriate section table (Collection Management, Document
   Operations, Code Vectorization, or create a new section)
2. If the tool has non-trivial parameters, add a parameters subsection under
   `## Search Parameters` or a new `##` section

If the tool introduces a new concept (new rerank preset, new filter type):

- Update relevant pages in `website/docs/usage/` (filters.md, query-modes.md,
  git-enrichments.md)
- Update `website/docs/agent-integration/search-strategies/` if it affects
  search workflows

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

- [ ] DTO created in `public/dto/<domain>.ts` (via add-dto skill)
- [ ] DTO re-exported via barrel chain: `dto/<domain>.ts` → `dto/index.ts` →
      `public/index.ts` → `api/index.ts`
- [ ] Work placed correctly per `facade-discipline.md` three-question tree:
      strategy (`domains/explore/strategies/`), query
      (`domains/explore/queries/`), ops (`api/internal/ops/`), or pure facade
      dispatcher
- [ ] Facade method is ≤ 20 lines (resolve → guard → [ensureStats] → dispatch →
      finalize); no inline filter construction, no `Map`/`reduce` aggregation,
      no indexing-mode branching
- [ ] Filter building (if any) uses `registry.buildMergedFilter()` — not
      hand-built `{ must: [...] }` shapes in the facade
- [ ] Validation >5 lines extracted to a named validator function
- [ ] App interface method added in `public/app.ts`
- [ ] `createApp()` wiring added in `public/app.ts` (delegate to
      facade/ops/query/strategy)
- [ ] `AppDeps` updated if a new internal class was introduced
- [ ] Zod schema in `mcp/tools/schemas.ts`
- [ ] Tool registered in `mcp/tools/<domain>.ts`
- [ ] If reranking supported: tool name added to preset `tools[]` arrays and
      `getSchemaDescriptors` list
- [ ] Tests written next to the implementation (strategy/query/ops test — not a
      facade test) and passing
- [ ] Docusaurus docs updated (`website/docs/api/tools.md` + relevant pages)
- [ ] `CLAUDE.local.md` updated
- [ ] Build + full test suite passing

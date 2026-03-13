# API Public/Private Split — Design Spec

## Problem

`core/api/` is a flat directory mixing public contract (App interface, DTOs),
internal orchestration (facades, ops), and infrastructure (SchemaBuilder,
composition). Adding a new endpoint requires knowing where to put each piece
with no structural guidance.

Specific issues:

1. **app.ts = god object** — App interface + all DTO re-exports in one file
2. **No visibility boundary** — public contract and internal wiring coexist
3. **DTOs not domain-grouped** — all request/response types in one place
   (contracts/types/app.ts)
4. **No barrel export** — 26 files import individual api/ files by path
5. **Unclear "add endpoint" workflow** — no structure guiding where new code
   goes

## Solution

Split `core/api/` into `public/` and `internal/` subdirectories with barrel
export.

### Target Structure

```
core/api/
  public/
    app.ts              # App interface + createApp() + AppDeps
    dto/
      explore.ts        # SemanticSearchRequest, HybridSearchRequest, etc.
      ingest.ts         # IndexOptions, IndexStats, ChangeStats, etc.
      collection.ts     # CreateCollectionRequest, CollectionInfo, etc.
      document.ts       # AddDocumentsRequest, DeleteDocumentsRequest, etc.
      index.ts          # barrel re-export all DTOs
    index.ts            # barrel: App, createApp, AppDeps, all DTOs
  internal/
    composition.ts      # createComposition(), CompositionResult
    facades/
      explore-facade.ts # ExploreFacade, ExploreFacadeDeps
      ingest-facade.ts  # IngestFacade
    ops/
      collection-ops.ts # CollectionOps
      document-ops.ts   # DocumentOps
    infra/
      schema-builder.ts # SchemaBuilder
  index.ts              # barrel: public/ + SchemaBuilder + createComposition
```

### Dependency Rules

- `public/` → `internal/` (createApp imports facades, ops to assemble App)
- `internal/` → `contracts/`, `infra/`, domain modules
- External consumers → `core/api/index.ts` (barrel only)
- `internal/` does NOT import from `public/`

### Barrel Export (api/index.ts)

Exports for external consumers:

| Export                                     | Consumer       | Source          |
| ------------------------------------------ | -------------- | --------------- |
| `App` (interface)                          | MCP, bootstrap | public/app.ts   |
| `createApp()`                              | bootstrap      | public/app.ts   |
| `AppDeps`                                  | bootstrap      | public/app.ts   |
| All DTOs                                   | MCP, bootstrap | public/dto/     |
| `SchemaBuilder`                            | MCP, bootstrap | internal/infra/ |
| `createComposition()`, `CompositionResult` | bootstrap      | internal/       |

NOT exported: ExploreFacade, IngestFacade, CollectionOps, DocumentOps.

Exception: bootstrap/factory.ts currently imports ExploreFacade and IngestFacade
directly for construction. After this refactor, createApp() in public/app.ts
handles all wiring — factory.ts only needs createApp(AppDeps).

### DTO Placement

DTOs currently live in `contracts/types/app.ts`. Move them to `public/dto/` by
domain:

| DTO                                                                                                                                                                      | Domain file       |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------- |
| SemanticSearchRequest, HybridSearchRequest, RankChunksRequest, ExploreCodeRequest, ExploreResponse, SearchResult, TypedFilterParams, PresetDescriptors, SignalDescriptor | dto/explore.ts    |
| IndexOptions, IndexStats, IndexStatus, ChangeStats, ProgressCallback                                                                                                     | dto/ingest.ts     |
| CreateCollectionRequest, CollectionRef, CollectionInfo                                                                                                                   | dto/collection.ts |
| AddDocumentsRequest, DeleteDocumentsRequest                                                                                                                              | dto/document.ts   |

`contracts/types/app.ts` becomes thin: re-exports from `public/dto/` or is
deleted if no other contracts/ consumer needs these types.

### "Add Endpoint" Workflow

After this refactor, adding a new endpoint:

1. Add DTO to `public/dto/<domain>.ts`
2. Add method to `App` interface in `public/app.ts`
3. Implement in `internal/facades/` or `internal/ops/`
4. Wire in `createApp()` (same file as App interface)
5. Register MCP tool in `src/mcp/tools/`

### Additional Changes

- Remove stats-cache.ts and schema-drift-monitor.ts references from api/
  (already in core/infra/)
- Update CLAUDE.md project structure section
- Update test file paths to mirror new source structure
- All 26 importing files updated to use barrel or new paths

## Decisions

- **contracts/ stays as foundation** — not moved into api/
- **createApp() lives in public/app.ts** — factory next to interface it creates
- **SchemaBuilder in internal/infra/** — exported via barrel for MCP
- **internal/ grouped by role** — facades/, ops/, infra/
- **composition.ts at internal/ root** — standalone, not in a subdirectory

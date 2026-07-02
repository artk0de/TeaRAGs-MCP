---
name: add-dto
description:
  Request/response shape exposed via public API to MCP tools, lives in
  api/public/dto. Triggers on "add DTO", "new request type for X tool", "add
  response shape", "новый DTO для tool'а". NOT for internal types — those live
  in contracts/, not public API surface.
---

# Add DTO to public/dto

Add request/response types for new or existing MCP endpoint.

## Step 1: Determine the domain

DTOs grouped by domain in `src/core/api/public/dto/`:

| Domain file     | Contains                                                                     |
| --------------- | ---------------------------------------------------------------------------- |
| `explore.ts`    | Search request/response types (SemanticSearchRequest, ExploreResponse, etc.) |
| `ingest.ts`     | Indexing types (IndexOptions, IndexStats, ChangeStats, etc.)                 |
| `collection.ts` | Collection CRUD types (CreateCollectionRequest, CollectionInfo)              |
| `document.ts`   | Document add/delete types (AddDocumentsRequest, DeleteDocumentsRequest)      |

New DTO fits no existing domain → create `dto/<domain>.ts`, add re-export to
`dto/index.ts`.

## Step 2: Define the DTO

Add interface to appropriate domain file. Rules:

- **Request types** end with `Request` (e.g., `SemanticSearchRequest`)
- **Response types** specific (e.g., `ExploreResponse`, `CollectionInfo`) — no
  generic `Response` suffix
- **Extend shared types** when applicable:
  - `CollectionRef` — endpoints accepting `collection` or `path`
  - `TypedFilterParams` — endpoints with trajectory filters
- **No logic** — DTOs pure data shapes (interfaces only, no classes)
- **Import only from** contracts/ or infra/ types if needed (e.g.,
  `RankingOverlay`)

## Step 3: Export from barrel

1. Add `export type` to `src/core/api/public/dto/index.ts`
2. Verify re-exported through `src/core/api/public/index.ts`
3. Verify re-exported through `src/core/api/index.ts`

Existing barrel patterns → new types in existing domain files auto re-exported
via `export type { ... } from "./explore.js"` etc. Add new lines only when
creating new domain file.

## Step 4: Backward compatibility

`contracts/types/app.ts` re-exports from this domain file → add new type to its
re-export list. Check:

```typescript
// src/core/contracts/types/app.ts
export type { ..., NewType } from "../../api/public/dto/<domain>.js";
```

## Step 5: Verify

```bash
npx tsc --noEmit
```

All imports of new DTO go through `core/api/index.js` barrel.

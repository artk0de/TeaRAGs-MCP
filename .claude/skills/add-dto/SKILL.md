---
name: add-dto
description: Add a new DTO (Data Transfer Object) to the api/public/dto layer
---

# Add DTO to public/dto

Add request/response types for a new or existing MCP endpoint.

## Step 1: Determine the domain

DTOs are grouped by domain in `src/core/api/public/dto/`:

| Domain file     | Contains                                                                     |
| --------------- | ---------------------------------------------------------------------------- |
| `explore.ts`    | Search request/response types (SemanticSearchRequest, ExploreResponse, etc.) |
| `ingest.ts`     | Indexing types (IndexOptions, IndexStats, ChangeStats, etc.)                 |
| `collection.ts` | Collection CRUD types (CreateCollectionRequest, CollectionInfo)              |
| `document.ts`   | Document add/delete types (AddDocumentsRequest, DeleteDocumentsRequest)      |

If the new DTO doesn't fit any existing domain, create a new file
`dto/<domain>.ts` and add its re-export to `dto/index.ts`.

## Step 2: Define the DTO

Add the interface to the appropriate domain file. Rules:

- **Request types** end with `Request` (e.g., `SemanticSearchRequest`)
- **Response types** are specific (e.g., `ExploreResponse`, `CollectionInfo`) —
  no generic `Response` suffix
- **Extend shared types** when applicable:
  - `CollectionRef` — for endpoints that accept `collection` or `path`
  - `TypedFilterParams` — for endpoints with trajectory filters
- **No logic** — DTOs are pure data shapes (interfaces only, no classes)
- **Import only from** contracts/ or infra/ types if needed (e.g.,
  `RankingOverlay`)

## Step 3: Export from barrel

1. Add `export type` to `src/core/api/public/dto/index.ts`
2. Verify it's re-exported through `src/core/api/public/index.ts`
3. Verify it's re-exported through `src/core/api/index.ts`

If using existing barrel patterns, new types in existing domain files are
automatically re-exported via `export type { ... } from "./explore.js"` etc.
Only add new lines if creating a new domain file.

## Step 4: Backward compatibility

If `contracts/types/app.ts` re-exports from this domain file, add the new type
to its re-export list. Check:

```typescript
// src/core/contracts/types/app.ts
export type { ..., NewType } from "../../api/public/dto/<domain>.js";
```

## Step 5: Verify

```bash
npx tsc --noEmit
```

All imports of the new DTO should go through `core/api/index.js` barrel.

# API Public/Private Split — Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development
> (if subagents available) or superpowers:executing-plans to implement this
> plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Split core/api/ into public/ and internal/ subdirectories with barrel
exports, grouping internal by role (facades/, ops/, infra/).

**Architecture:** Physical directory split with barrel re-exports. DTOs moved
from contracts/types/app.ts to public/dto/ by domain. createApp() merged into
public/app.ts alongside App interface.

**Tech Stack:** TypeScript, no new dependencies.

---

## Chunk 1: Public Surface

### Task 1: Create public/dto/ files

Split `contracts/types/app.ts` DTOs into domain-grouped files.

**Files:**

- Create: `src/core/api/public/dto/explore.ts`
- Create: `src/core/api/public/dto/ingest.ts`
- Create: `src/core/api/public/dto/collection.ts`
- Create: `src/core/api/public/dto/document.ts`
- Create: `src/core/api/public/dto/index.ts`
- Modify: `src/core/contracts/types/app.ts` → re-export from public/dto/

**DTO distribution:**

| File              | Types                                                                                                                                                                                   |
| ----------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| dto/explore.ts    | CollectionRef, TypedFilterParams, SemanticSearchRequest, HybridSearchRequest, RankChunksRequest, ExploreCodeRequest, SearchResult, ExploreResponse, SignalDescriptor, PresetDescriptors |
| dto/ingest.ts     | IndexOptions, IndexStats, IndexStatus, ChangeStats, ProgressCallback (moved from core/types.ts)                                                                                         |
| dto/collection.ts | CreateCollectionRequest, CollectionInfo                                                                                                                                                 |
| dto/document.ts   | AddDocumentsRequest, DeleteDocumentsRequest                                                                                                                                             |

- [ ] Create dto/explore.ts with all explore-domain DTOs
- [ ] Create dto/ingest.ts with App-facing ingest DTOs (from core/types.ts)
- [ ] Create dto/collection.ts
- [ ] Create dto/document.ts
- [ ] Create dto/index.ts barrel re-exporting all
- [ ] Update contracts/types/app.ts to re-export from public/dto/ (backward
      compat)
- [ ] Build + type-check

### Task 2: Create public/app.ts

Merge App interface + createApp() + AppDeps into single file.

**Files:**

- Create: `src/core/api/public/app.ts`
- Create: `src/core/api/public/index.ts` (barrel)
- Delete: `src/core/api/app.ts` (old location)
- Delete: `src/core/api/create-app.ts` (merged into public/app.ts)

- [ ] Create public/app.ts with App interface, AppDeps, createApp()
- [ ] Imports DTOs from ./dto/
- [ ] Imports internal classes from ../internal/
- [ ] Create public/index.ts barrel (App, createApp, AppDeps, all DTOs)
- [ ] Delete old app.ts and create-app.ts
- [ ] Build + type-check

## Chunk 2: Internal Restructure

### Task 3: Move internal files to subdirectories

**Files:**

- Move: `explore-facade.ts` → `internal/facades/explore-facade.ts`
- Move: `ingest-facade.ts` → `internal/facades/ingest-facade.ts`
- Move: `collection-ops.ts` → `internal/ops/collection-ops.ts`
- Move: `document-ops.ts` → `internal/ops/document-ops.ts`
- Move: `schema-builder.ts` → `internal/infra/schema-builder.ts`
- Move: `composition.ts` → `internal/composition.ts`

- [ ] Create internal/ directory structure
- [ ] Move each file, update internal imports
- [ ] Delete old files from api/ root
- [ ] Build + type-check

### Task 4: Create api/index.ts barrel

**Files:**

- Create: `src/core/api/index.ts`

Exports:

- Everything from public/ (App, createApp, AppDeps, all DTOs)
- SchemaBuilder from internal/infra/
- createComposition, CompositionResult from internal/

- [ ] Create barrel
- [ ] Build + type-check

## Chunk 3: Consumer Updates

### Task 5: Update all import paths

26 files import from core/api/. Update to use barrel or new paths.

**Production files (8):**

- `src/bootstrap/factory.ts`
- `src/mcp/tools/index.ts`
- `src/mcp/tools/explore.ts`
- `src/mcp/tools/code.ts`
- `src/mcp/tools/collection.ts`
- `src/mcp/tools/document.ts`
- `src/mcp/tools/schemas.ts`
- `src/mcp/resources/index.ts`

**Test files (18):** Mirror new paths.

- [ ] Update production imports to use barrel
- [ ] Update test imports to match new file locations
- [ ] Build + test (full suite)

### Task 6: Update contracts/types/app.ts

Make contracts/types/app.ts a thin re-export from public/dto/ for backward
compatibility. Any code importing from contracts/types/app still works.

- [ ] Replace DTOs with re-exports from public/dto/
- [ ] Build + type-check

### Task 7: Update CLAUDE.md and documentation

- [ ] Update project structure in .claude/CLAUDE.md
- [ ] Update spec if needed
- [ ] Build + full test suite
- [ ] Commit

# Domain Boundaries Refactoring — Design

## Goal

Fix all layer boundary violations, introduce `infra/` layer, rename `search/` to
`explore/`, update CLAUDE.md rules.

## Updated Layer Rules

```
                  api/                            ← Composition root
               ↗   ↑   ↖                           Imports from: everything (assembles DI)
             /     |     \
          explore/ trajectory/ ingest/            ← Domain modules
             \     |     /                          Import from: contracts/, infra/
              ↘    ↓    ↙                           NOT from each other
          contracts/   adapters/   infra/         ← Foundation (lowest level)
```

| Layer         | Imports from                                  | Exports to           |
| ------------- | --------------------------------------------- | -------------------- |
| `api/`        | domain modules, contracts/, adapters/, infra/ | external consumers   |
| `explore/`    | contracts/, infra/                            | api/                 |
| `trajectory/` | contracts/, adapters/, infra/                 | api/                 |
| `ingest/`     | contracts/, adapters/, infra/                 | api/                 |
| `contracts/`  | infra/                                        | domain modules, api/ |
| `adapters/`   | infra/                                        | domain modules, api/ |
| `infra/`      | nothing                                       | all layers           |

Key change: api/ as composition root can import from anywhere. explore/ does not
need adapters/.

## Changes

### 1. New `core/infra/` layer

- Create `src/core/infra/runtime.ts` with `isDebug()` extracted from
  `ingest/pipeline/infra/runtime.ts`
- Update 4 imports: `adapters/embeddings/ollama.ts`, `adapters/git/client.ts`,
  `trajectory/git/infra/chunk-reader.ts`, `trajectory/git/infra/file-reader.ts`

### 2. Move collection utilities to `ingest/`

- Move `resolveCollectionName`, `validatePath` from `contracts/collection.ts` to
  `ingest/`
- Move `computeCollectionStats` from `contracts/collection-stats.ts` to
  `ingest/`
- explore/ receives `collectionName` as parameter — no longer resolves itself
- api/ calls through ingest or imports directly (api/ can import from ingest/)

### 3. TrajectoryRegistry — DI through api/

- api/ creates `TrajectoryRegistry`, extracts data, passes to explore/ via
  constructor
- explore/ receives interface from contracts/, does not know about trajectory/
- Remove import of `trajectory/` from `search-module.ts`

### 4. Rename `search/` → `explore/`

- Rename directory `src/core/search/` → `src/core/explore/`
- Files inside keep their names (`search-module.ts`, `reranker.ts`)
- Update all import paths across codebase
- Rename `search-facade.ts` → `explore-facade.ts` in api/
- Tests: `tests/core/search/` → `tests/core/explore/`

### 5. Update CLAUDE.md

- New layer diagram with `infra/` and `explore/`
- Updated import rules
- Updated Project Structure section

## Out of Scope

- Internal file logic — only import paths change
- `adapters/` → `contracts/` imports — allowed
- `trajectory/` → `adapters/` imports — allowed
- `ingest/` → `adapters/` imports — allowed

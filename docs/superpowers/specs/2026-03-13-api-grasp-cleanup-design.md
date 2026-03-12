# API Layer GRASP/SOLID Cleanup

## Problem

`src/core/api/` and surrounding layers have 7 architectural violations against
GRASP, DDD layering, and SOLID principles established in CLAUDE.md:

1. `resolveCollectionName`/`validatePath` live in `ingest/collection.ts` but are
   imported by 5+ consumers across api/, infra/, ingest/ — including
   `infra/schema-drift-monitor.ts` which violates the `infra/ → nothing` rule
2. 7 files in core/ import directly from `bootstrap/config/paths.ts` — reverse
   dependency (core/ → bootstrap/)
3. `buildMergedFilter()` in ExploreFacade — 25 lines of Qdrant filter merge
   logic that doesn't belong in a facade
4. `resolveCollection()` helper in ExploreFacade — pure data resolution that
   belongs in foundation layer
5. ExploreFacade constructor takes 8 positional params (5 optional) — hard to
   read, easy to misorder
6. `core/infra/` described as "Runtime utilities" in CLAUDE.md — too narrow for
   its actual role as foundation utility layer

## Design

### 1. Collection utilities → `core/infra/collection-name.ts`

Move from `ingest/collection.ts` to `core/infra/collection-name.ts`:

- `validatePath(path: string): Promise<string>` — fs.realpath with fallback
- `resolveCollectionName(path: string): string` — md5 hash of absolute path
- `resolveCollection(collection?, path?)` — extracted from ExploreFacade.
  `CollectionRefError` moves with it (thrown by this function).

`CollectionNotFoundError` stays in ExploreFacade (thrown by
`validateCollectionExists` which needs qdrant — I/O concern).

Delete `ingest/collection.ts`. All 5+ consumers change import path to
`core/infra/collection-name.ts`.

**Rationale (Information Expert):** These are stateless pure functions with zero
domain dependencies. They map `path → collectionName` — a foundation concern
used by all layers.

**Layer violation fixed:** `infra/schema-drift-monitor.ts` will import from its
own layer instead of from `ingest/`.

### 2. All resolved paths → `AppConfig.paths`

Add `paths` section to `AppConfig`:

```typescript
interface AppConfig {
  // ... existing fields ...
  paths: ResolvedPaths;
}

interface ResolvedPaths {
  appData: string;
  snapshots: string;
  logs: string;
  models: string;
  daemonSocket: string;
  daemonPid: string;
  calibrationCache: string;
}
```

`parseAppConfig()` resolves all paths once. `bootstrap/config/paths.ts`
functions remain as implementation — `parseAppConfig()` calls them internally.

**Files in core/ that import from bootstrap/config/ (paths + config types):**

_Path function imports (8 files):_

| File                                    | Path(s) used                                                              | DI approach                                                                                                        |
| --------------------------------------- | ------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `api/ingest-facade.ts`                  | `snapshotsDir`                                                            | Constructor param                                                                                                  |
| `ingest/sync/synchronizer.ts`           | `snapshotsDir`                                                            | Already receives via `createIngestDependencies` deps — remove direct import, use injected value                    |
| `ingest/pipeline/base.ts`               | `snapshotsDir`                                                            | Receive via `IngestDependencies` (already injected) — replace lazy getter                                          |
| `ingest/pipeline/status-module.ts`      | `snapshotsDir`                                                            | Add constructor param                                                                                              |
| `ingest/pipeline/infra/debug-logger.ts` | `logsDir`, `getConfigDump`, `getZodConfig`                                | Add `init(opts: { logsDir, configDump?, concurrency? })` — passes all three values, removing all bootstrap imports |
| `adapters/embeddings/factory.ts`        | `modelsDir`, `daemonSocketPath`, `daemonPidFile` + `EmbeddingConfig` type | Pass paths as params to `create()`. Move `EmbeddingConfig` type to `core/contracts/types/`                         |
| `adapters/qdrant/embedded/daemon.ts`    | `appDataDir`                                                              | Pass `storagePath` param to `ensureDaemon()`                                                                       |
| `adapters/qdrant/embedded/download.ts`  | `appDataDir`                                                              | Pass `binaryDir` param to `downloadQdrant()` and `getBinaryPath()`                                                 |

_Config type imports (3 files — type-only but still layer violation):_

| File                             | Type imported         | DI approach                                             |
| -------------------------------- | --------------------- | ------------------------------------------------------- |
| `trajectory/git/provider.ts`     | `TrajectoryGitConfig` | Move type to `core/contracts/types/` or `core/types.ts` |
| `adapters/qdrant/accumulator.ts` | `QdrantTuneConfig`    | Move type to `core/contracts/types/` or `core/types.ts` |
| `adapters/embeddings/factory.ts` | `EmbeddingConfig`     | Move type to `core/contracts/types/` (covered above)    |

**Rationale (DIP):** core/ depends on abstractions (constructor params / types
in contracts/), not on concrete config resolution in bootstrap/. Paths are
resolved once at startup and injected downward. Config types that are consumed
by core/ belong in core/contracts/, not in bootstrap/.

### 3. Filter merge extraction

**New file: `adapters/qdrant/filter-utils.ts`**

```typescript
export function mergeQdrantFilters(
  a: QdrantFilter | undefined,
  b: QdrantFilter | undefined,
): QdrantFilter | undefined;
```

Pure function. Merges `must`, `must_not` arrays by concatenation. Preserves
`should` from raw filter only (replicating current ExploreFacade behavior —
typed filters never produce `should` conditions). Returns `undefined` if both
inputs are undefined.

**Type note:** incoming `rawFilter` from App DTOs is `Record<string, unknown>`
(untyped MCP JSON). The merge function casts to `QdrantFilter` internally — same
as the current facade code does.

**TrajectoryRegistry gains `buildMergedFilter()`:**

```typescript
buildMergedFilter(
  typedParams: Record<string, unknown>,
  rawFilter?: QdrantFilter,
  level?: FilterLevel,
): QdrantFilter | undefined {
  const typed = this.buildFilter(typedParams, level ?? "chunk");
  return mergeQdrantFilters(typed, rawFilter);
}
```

ExploreFacade deletes its 25-line `buildMergedFilter()` private method. Calls
`this.registry.buildMergedFilter(request, request.filter, level)`.

**Rationale (Information Expert):** Registry owns typed filter building. Generic
merge is Qdrant adapter knowledge. Facade just orchestrates.

### 4. ExploreFacade deps object

Replace 8 positional constructor params with named deps:

```typescript
export interface ExploreFacadeDeps {
  qdrant: QdrantManager;
  embeddings: EmbeddingProvider;
  reranker: Reranker;
  registry: TrajectoryRegistry;       // now required (buildMergedFilter)
  statsCache?: StatsCache;
  schemaDriftMonitor?: SchemaDriftMonitor;
  payloadSignals?: PayloadSignalDescriptor[];
  essentialKeys?: string[];
}

constructor(deps: ExploreFacadeDeps) { ... }
```

`registry` becomes required because facade now delegates `buildMergedFilter()`
to it.

**Rationale:** Named fields eliminate positional confusion. Tests simplify from
`new ExploreFacade(qdrant, embeddings, reranker, undefined, undefined, [], [], monitor)`
to `new ExploreFacade({ qdrant, embeddings, reranker, registry })`.

### 5. Stays in facade (no change)

- `ensureStats()` — orchestration glue (cold-start bridge between statsCache and
  reranker). 8 lines, one call site. Moving to reranker would add `StatsCache`
  dependency to a domain class that currently has none.
- `validateCollectionExists()` — I/O check requiring qdrant adapter.
  Orchestration responsibility, not foundation.
- `checkDrift()` — delegation to SchemaDriftMonitor. Thin, appropriate for
  facade.

### 6. CLAUDE.md update

Update `core/infra/` description from "Runtime utilities" to "Foundation
utilities". Add `collection-name.ts` to project structure.

## Affected Files

| File                                         | Action                                                                 |
| -------------------------------------------- | ---------------------------------------------------------------------- |
| `core/infra/collection-name.ts`              | Create (move from ingest/, add resolveCollection + CollectionRefError) |
| `core/ingest/collection.ts`                  | Delete                                                                 |
| `adapters/qdrant/filter-utils.ts`            | Create (mergeQdrantFilters)                                            |
| `bootstrap/config/index.ts`                  | Add paths to AppConfig                                                 |
| `core/api/explore-facade.ts`                 | Deps object, remove buildMergedFilter/resolveCollection                |
| `core/api/ingest-facade.ts`                  | Receive snapshotsDir via DI                                            |
| `core/trajectory/index.ts`                   | Add buildMergedFilter()                                                |
| `core/infra/schema-drift-monitor.ts`         | Change import path                                                     |
| `core/ingest/sync/synchronizer.ts`           | Remove direct import, use injected value                               |
| `core/ingest/pipeline/base.ts`               | Remove direct import, use deps                                         |
| `core/ingest/pipeline/status-module.ts`      | Add snapshotDir constructor param                                      |
| `core/ingest/pipeline/infra/debug-logger.ts` | Add init(opts) for logsDir + configDump + concurrency                  |
| `adapters/embeddings/factory.ts`             | Accept paths as create() params, move EmbeddingConfig type             |
| `adapters/qdrant/embedded/daemon.ts`         | Accept storagePath param                                               |
| `adapters/qdrant/embedded/download.ts`       | Accept binaryDir param                                                 |
| `trajectory/git/provider.ts`                 | Change import: TrajectoryGitConfig from contracts/                     |
| `adapters/qdrant/accumulator.ts`             | Change import: QdrantTuneConfig from contracts/                        |
| `core/contracts/types/`                      | Add EmbeddingConfig, TrajectoryGitConfig, QdrantTuneConfig types       |
| `bootstrap/factory.ts`                       | Wire paths through DI                                                  |
| `.claude/CLAUDE.md`                          | Update infra/ description                                              |
| Tests (multiple)                             | Update constructors, imports                                           |

## Constraints

- **App interface unchanged** — MCP layer not affected
- **Pure mechanical refactor** — no behavior changes
- **Layer rules restored** — core/ no longer imports from bootstrap/; infra/ no
  longer imports from domain modules
- `bootstrap/config/paths.ts` functions remain — `parseAppConfig()` calls them
  internally, they are not deleted

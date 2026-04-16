# Refactor: createAppContext — Phase Extraction + IngestFacadeDeps

## Problem

`createAppContext()` in `src/bootstrap/factory.ts:50-190` is a 140-line god
function with 35 commits and extreme churn. It handles infrastructure
resolution, embedding setup, composition wiring, facade construction, and health
probe assembly in a single function. Every infrastructure change touches this
function.

`IngestFacade` constructor accepts 12 positional arguments — a maintenance
hazard and a signal that the dependency set should be grouped.

## Solution

### Phase 1: Introduce `IngestFacadeDeps` config object

Replace positional constructor arguments with a typed deps object.

```typescript
// src/core/api/internal/facades/ingest-facade.ts

interface IngestFacadeDeps {
  qdrant: QdrantManager;
  embeddings: EmbeddingProvider;
  config: IngestCodeConfig;
  trajectoryConfig: TrajectoryIngestConfig;
  statsCache: StatsCache;
  allPayloadSignals: PayloadSignalDescriptor[];
  reranker: Reranker;
  deleteConfig: DeletionConfig;
  pipelineTuning: PipelineTuning;
  syncTuning: SynchronizerTuning;
  snapshotDir: string;
  modelGuard: EmbeddingModelGuard;
}
```

Constructor signature: `constructor(deps: IngestFacadeDeps)`.

### Phase 2: Extract phase functions in factory.ts

Split `createAppContext` into three focused functions:

```typescript
// Returns { qdrant, embeddings, modelGuard, embeddedRelease }
function resolveInfrastructure(
  config: AppConfig,
  zodConfig: ZodConfig,
): Promise<InfraContext>;

// Returns { registry, reranker, schemaBuilder, allPayloadSignalDescriptors, essentialTrajectoryFields }
function wireComposition(): CompositionContext;

// Orchestrates: resolveInfra → wireComposition → build facades → create app
async function createAppContext(config: AppConfig): Promise<AppContext>;
```

`createAppContext` becomes ~30 lines: call phases, assemble result.

### Phase 3: Update call site

Single call site in `src/bootstrap/factory.ts` — no external consumers.
`IngestFacade` constructor call in factory.ts switches to deps object.

## Scope

- Files modified: `src/bootstrap/factory.ts`,
  `src/core/api/internal/facades/ingest-facade.ts`
- No new files (types live next to their consumers)
- No behavior change — pure structural refactoring
- Existing tests must pass without modification

## Risks

- `IngestFacade` constructor change propagates to tests that instantiate it
  directly. Grep for `new IngestFacade` to find all call sites.
- Phase functions share `zodConfig` — pass as parameter, don't close over
  module-level state.

## Success Criteria

- `createAppContext` body is <= 35 lines
- `IngestFacade` constructor has 1 parameter (deps object)
- All existing tests pass
- No new files created (types colocated)

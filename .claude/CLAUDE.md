# tea-rags-mcp — Project Rules

## Domain Boundaries (MANDATORY)

### Layer Dependency Rules

```
                  api/                            ← Composition root
               ↗   ↑   ↖                           Imports from: domain modules ONLY
             /     |     \
          search/ trajectory/ ingest/             ← Domain modules
             \     |     /                          Import from: foundation ONLY
              ↘    ↓    ↙                           Export to: api/
          contracts/   adapters/                  ← Foundation (lowest level)
```

**Dependency rules:**

| Layer | Imports from | Exports to |
|-------|-------------|------------|
| `core/api/` | domain modules only | external consumers |
| `core/search/` | `contracts/`, `adapters/` | `api/` |
| `core/trajectory/` | `contracts/`, `adapters/` | `api/` |
| `core/ingest/` | `contracts/`, `adapters/` | `api/` |
| `core/contracts/` | `adapters/` (types only) | domain modules |
| `core/adapters/` | nothing | domain modules |

**api/ is the composition root:** it orchestrates domain modules through their
public APIs. Foundation (contracts/, adapters/) is an implementation detail
of domain modules — api/ never imports from foundation directly.

**Prohibited dependencies (hard errors):**

- `api/` -x-> `contracts/`, `adapters/` (use domain module APIs instead)
- Domain modules -x-> each other (`search` -x-> `trajectory`, etc.)
- Foundation -x-> any layer above

### Layer Responsibilities

**core/api/** — Composition root + MCP facades
- IngestFacade, SearchFacade
- SchemaBuilder (dynamic MCP schema generation via domain module APIs)
- Orchestrates domain modules: gets data from trajectory/, passes to search/
- Imports ONLY from domain modules, never from foundation directly

**core/search/** — Query-time reranking (domain module)
- GitReranker (trajectory-level: normalization, alpha-blending, confidence)
- GenericReranker (structural signals: similarity, chunkSize, docs, imports, pathRisk)
- CompositeReranker (orchestrator: providers[] -> adaptive bounds -> weighted score)

**core/trajectory/** — Trajectory implementations (domain module)
- Signal definitions (Signal[])
- Filter definitions (FilterDescriptor[])
- Provider implementations (EnrichmentProvider)
- Infra: readers, metrics, caches

**core/ingest/** — Indexing pipeline (domain module)
- Chunking, embedding, enrichment coordination
- Depends on EnrichmentProvider interface from contracts, NOT from trajectory

**core/contracts/** — Shared interfaces, registries, utilities (foundation)
- All shared interfaces and types (Signal, FilterDescriptor, EnrichmentProvider, etc.)
- TrajectoryRegistry (aggregates via TrajectoryQueryContract — interface-only)
- Signal utilities (normalize, p95, payload resolvers)
- Barrel exports via index.ts

**core/adapters/** — External system types (foundation)
- Qdrant types and client (QdrantFilter, QdrantFilterCondition, etc.)
- Git client, embedding providers

### Dependency Inversion Principle

Interfaces and registries live in `core/contracts/`. Implementations live in domain modules.
api/ orchestrates domain modules through their public APIs — never touches foundation.

**Registries in contracts/:** registries work ONLY through interfaces.
Domain modules use them internally. api/ interacts with registries
through domain module facades, not by importing from contracts/ directly.

Example flow:
- `EnrichmentProvider` interface → `core/contracts/types/provider.ts`
- `GitEnrichmentProvider` implementation → `core/trajectory/git/provider.ts`
- `EnrichmentCoordinator` in `core/ingest/` imports only the interface from `core/contracts/`
- `TrajectoryRegistry` in `core/contracts/` aggregates via `TrajectoryQueryContract` interface
- `trajectory/` exposes its query contract through public API
- `search/` exposes `registerTrajectory()` method
- `api/` calls `trajectory/` → gets contract → passes to `search/` (never imports registry directly)

## Terminology (MANDATORY)

| Term | Meaning |
|------|---------|
| Signal | Raw payload field in Qdrant (no normalization). Defined by Provider. |
| Filter | Qdrant filter condition builder. Defined by Provider. |
| Provider | Trajectory that defines signals, filters, and builds signal data. |
| Reranker | Normalizes signals, applies alpha-blending/confidence, owns presets. |
| CompositeReranker | Orchestrates trajectory rerankers + structural signals. |

### Naming Conventions

- `buildFileSignals` / `buildChunkSignals` (NOT buildFileMetadata/buildChunkMetadata)
- `GitFileSignals` / `GitChunkSignals` (NOT GitFileMetadata/ChunkChurnOverlay)
- `computeFileSignals` / `computeChunkSignals` (NOT computeFileMetadata/computeChunkOverlay)
- `fileSignalTransform` (NOT fileTransform)
- `Signal` type (NOT FieldDoc)
- `gitSignals: Signal[]` (NOT gitPayloadFields: FieldDoc[])

## Project Structure

```
core/
  api/                                 # Composition root
    ingest-facade.ts                   # IngestFacade (MCP entry)
    search-facade.ts                   # SearchFacade (MCP entry)
    schema-builder.ts                  # Dynamic MCP schema from registry
    shared.ts                          # resolveCollectionName, validatePath

  search/                              # Domain module: query-time reranking
    reranker.ts                        # Current monolith (→ decompose in Plan B)
    search-module.ts                   # Search orchestration

  trajectory/                          # Domain module: provider implementations
    git/
      signals.ts                       # gitSignals: Signal[]
      filters.ts                       # gitFilters: FilterDescriptor[]
      provider.ts                      # GitEnrichmentProvider
      infra/                           # readers, metrics, caches

  ingest/                              # Domain module: indexing pipeline
    pipeline/
      enrichment/                      # coordinator, applier

  contracts/                           # Foundation: interfaces + registries
    trajectory-registry.ts             # Aggregates via TrajectoryQueryContract
    signal-utils.ts                    # normalize, p95, payload resolvers
    types/
      provider.ts                      # Signal, FilterDescriptor, FilterLevel,
                                       # ScoringWeights, TrajectoryQueryContract,
                                       # EnrichmentProvider, FileSignalTransform,
                                       # FileSignalOverlay, ChunkSignalOverlay
      reranker.ts                      # RerankableResult, NormalizationBounds,
                                       # RerankMode, preset type unions
    index.ts                           # barrel re-export

  adapters/                            # Foundation: external system types
    qdrant/
      types.ts                         # QdrantFilter, QdrantFilterCondition
    git/
    embeddings/
```

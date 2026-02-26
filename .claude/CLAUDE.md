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
- Reranker (orchestrator: derived signals → adaptive bounds → scoring → ranking overlay)
- Derived signal descriptors from providers (via registry) + structural signals (built-in)
- Presets: weight configurations over derived signal names

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

### Signal Taxonomy

| Term | Definition | Example | Where |
|------|-----------|---------|-------|
| **Signal** (raw) | Value stored in Qdrant payload. Defined by Provider. Not normalized. | `ageDays=142`, `commitCount=23`, `bugFixRate=35` | `payload.git.file.*`, `payload.git.chunk.*` |
| **Derived Signal** | Normalized/transformed value computed from one or more raw signals at rerank time. Range 0-1. Used as weight keys in presets. | `recency` (from ageDays), `ownership` (from dominantAuthorPct+authors) | `DerivedSignalDescriptor` in provider |
| **Structural Signal** | Derived signal from payload structure, not from any trajectory provider. | `similarity`, `chunkSize`, `documentation`, `imports`, `pathRisk` | Reranker built-in |
| **Preset** | Named weight configuration over derived signal names. Defines a reranking strategy. | `techDebt: { age: 0.15, churn: 0.15, bugFix: 0.15 }` | search/ or provider |
| **Ranking Overlay** | Subset of raw + derived signals relevant to the active preset, attached to each reranked result. Includes both file and chunk levels. | `{ raw: { file: { ageDays: 142 } }, derived: { recency: 0.61 } }` | Reranker response |

### Domain Terms

| Term | Meaning |
|------|---------|
| Provider | Trajectory that defines signals, derived signals, filters, and builds signal data. |
| Filter | Qdrant filter condition builder. Defined by Provider. |
| Reranker | Orchestrates derived signal extraction, adaptive bounds, scoring, and ranking overlay. |
| Alpha-blending | L3 confidence-weighted blending of file vs chunk signals: `effective = alpha * chunk + (1-alpha) * file`. |
| Confidence dampening | Quadratic per-signal dampening for unreliable statistical signals: `(n/k)^2` where k is signal-specific threshold. |
| Adaptive bounds | Per-query normalization bounds computed from result set (p95), floored with defaults. |

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
    reranker.ts                        # Reranker: scoring, overlay, adaptive bounds
    structural-signals.ts              # Structural derived signal descriptors
    presets/                           # Preset definitions (weight configs)
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

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
- Receives descriptors + resolved presets via DI (constructor), never imports from trajectory/
- Derived signal descriptors from providers (via registry) + structural signals (built-in)
- Presets: 3-level hierarchy (generic → trajectory → composite), resolved at composition root

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
| **Preset** (`RerankPreset`) | Class with name, description, tools[], weights, overlayMask. 3-level hierarchy: Generic → Trajectory → Composite. Each preset is a class file. | `class TechDebtPreset { tools: ["semantic_search"], weights: {...}, overlayMask: {...} }` | `trajectory/git/rerank/presets/`, `search/rerank/presets/` |
| **Overlay Mask** (`OverlayMask`) | Curates which signals appear in ranking overlay for a preset. `derived: string[]` + optional `raw: { file?, chunk? }`. | `{ derived: ["age", "churn"], raw: { file: ["ageDays"] } }` | Each preset class |
| **Ranking Overlay** | Subset of raw + derived signals filtered by OverlayMask (or weight keys for custom), attached to each reranked result. | `{ raw: { file: { ageDays: 142 } }, derived: { recency: 0.61 } }` | Reranker response |

### Domain Terms

| Term | Meaning |
|------|---------|
| Provider | Trajectory that defines signals, derived signals, filters, and builds signal data. |
| Filter | Qdrant filter condition builder. Defined by Provider. |
| Reranker | Orchestrates derived signal extraction, adaptive bounds, scoring, and ranking overlay. Receives descriptors + resolved presets via DI. |
| SchemaBuilder | Generates Zod schemas for MCP tools from Reranker's public API (DIP). Lives in api/. |
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
    schema-builder.ts                  # SchemaBuilder: dynamic MCP schemas via Reranker API (DIP)
    shared.ts                          # resolveCollectionName, validatePath

  search/                              # Domain module: query-time reranking
    reranker.ts                        # Reranker: scoring, overlay mask, adaptive bounds
    rerank/
      derived-signals/                 # Structural signal classes (1 per file)
        similarity.ts                  # class SimilaritySignal
        chunk-size.ts                  # class ChunkSizeSignal
        documentation.ts               # class DocumentationSignal
        imports.ts                     # class ImportsSignal
        path-risk.ts                   # class PathRiskSignal
        index.ts                       # structuralSignals: DerivedSignalDescriptor[]
      presets/
        relevance.ts                   # class RelevancePreset (multi-tool: semantic_search + search_code)
        index.ts                       # RELEVANCE_PRESETS + resolvePresets() + getPresetNames/Weights
    search-module.ts                   # Search orchestration

  trajectory/                          # Domain module: provider implementations
    git/
      signals.ts                       # gitSignals: Signal[] (raw payload field docs)
      rerank/
        derived-signals/               # Git signal classes (1 per file) + shared helpers
          helpers.ts                   # computeAlpha, blend, payload accessors
          recency.ts                   # class RecencySignal
          stability.ts                 # class StabilitySignal
          churn.ts                     # class ChurnSignal
          age.ts                       # class AgeSignal
          ownership.ts                 # class OwnershipSignal
          bug-fix.ts                   # class BugFixSignal
          volatility.ts                # class VolatilitySignal
          density.ts                   # class DensitySignal
          chunk-churn.ts               # class ChunkChurnSignal
          relative-churn-norm.ts       # class RelativeChurnNormSignal
          burst-activity.ts            # class BurstActivitySignal
          knowledge-silo.ts            # class KnowledgeSiloSignal
          chunk-relative-churn.ts      # class ChunkRelativeChurnSignal
          block-penalty.ts             # class BlockPenaltySignal
          index.ts                     # gitDerivedSignals: DerivedSignalDescriptor[]
        presets/                       # Preset classes (1 per file)
          tech-debt.ts                 # class TechDebtPreset
          hotspots.ts                  # class HotspotsPreset
          code-review.ts               # class CodeReviewPreset
          onboarding.ts                # class OnboardingPreset
          security-audit.ts            # class SecurityAuditPreset
          refactoring.ts               # class RefactoringPreset
          ownership.ts                 # class OwnershipPreset
          recent.ts                    # class RecentPreset
          stable.ts                    # class StablePreset
          index.ts                     # barrel + GIT_PRESETS array
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
      reranker.ts                      # RerankableResult, RerankPreset,
                                       # OverlayMask, RerankMode,
                                       # DerivedSignalDescriptor,
                                       # RankingOverlay, RerankedResult
    index.ts                           # barrel re-export

  adapters/                            # Foundation: external system types
    qdrant/
      types.ts                         # QdrantFilter, QdrantFilterCondition
    git/
    embeddings/
```

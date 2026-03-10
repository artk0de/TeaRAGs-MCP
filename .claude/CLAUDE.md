# tea-rags — Project Rules

## Domain Boundaries (MANDATORY)

### Layer Dependency Rules

```
                  api/                            ← Composition root
               ↗   ↑   ↖                           Imports from: everything (assembles DI)
             /     |     \
          explore/ trajectory/ ingest/            ← Domain modules
             \     |     /                          Import from: contracts/, infra/
              ↘    ↓    ↙                           NOT from each other
          contracts/   adapters/   infra/         ← Foundation (lowest level)
```

**Dependency rules:**

| Layer | Imports from | Exports to |
|-------|-------------|------------|
| `core/api/` | domain modules, `contracts/`, `adapters/`, `infra/` | external consumers |
| `core/explore/` | `contracts/`, `infra/` | `api/` |
| `core/trajectory/` | `contracts/`, `adapters/`, `infra/` | `api/` |
| `core/ingest/` | `contracts/`, `adapters/`, `infra/` | `api/` |
| `core/contracts/` | `infra/` | domain modules, `api/` |
| `core/adapters/` | `infra/` | domain modules, `api/` |
| `core/infra/` | nothing | all layers |

**api/ is the composition root:** it assembles dependencies from all layers,
creates instances, and wires them together via DI.

**Prohibited dependencies (hard errors):**

- Domain modules -x-> each other (`explore` -x-> `trajectory`, etc.)
- Foundation -x-> any layer above (`contracts`/`adapters`/`infra` -x-> domain modules or `api/`)

### Layer Responsibilities

**core/api/** — Composition root + MCP facades
- IngestFacade, ExploreFacade
- SchemaBuilder (dynamic MCP schema generation via domain module APIs)
- Orchestrates domain modules: gets data from trajectory/, passes to explore/
- Imports from all layers (composition root assembles DI)

**core/explore/** — Query-time reranking engine (domain module)
- Reranker (orchestrator: derived signals → adaptive bounds → scoring → ranking overlay)
- Receives descriptors + resolved presets via DI (constructor), never imports from trajectory/
- No signal definitions — all signals come from trajectory/ via registry
- Presets: 2-level hierarchy (registry → composite), resolved at composition root

**core/trajectory/** — Trajectory implementations (domain module)
- Static trajectory: base payload signals, structural derived signals, generic presets, static filters
- Git trajectory: git-enriched signals, derived signals, git-specific presets and filters
- StaticPayloadBuilder: builds base Qdrant payload (injected into pipeline via PayloadBuilder DIP)
- Provider implementations (EnrichmentProvider — optional, not all trajectories have ingest enrichment)

**core/ingest/** — Indexing pipeline (domain module)
- Chunking, embedding, enrichment coordination
- Collection utilities (resolveCollectionName, validatePath, computeCollectionStats)
- Depends on PayloadBuilder and EnrichmentProvider interfaces from contracts, NOT from trajectory

**core/contracts/** — Shared interfaces, registries, utilities (foundation)
- All shared interfaces and types (Signal, FilterDescriptor, EnrichmentProvider, etc.)
- Signal utilities (normalize, p95, payload resolvers)
- Barrel exports via index.ts

**core/adapters/** — External system types (foundation)
- Qdrant types, client, embedded daemon (QdrantFilter, QdrantFilterCondition, etc.)
- Git client, embedding providers

**core/infra/** — Runtime utilities (foundation, lowest level)
- isDebug(), setDebug() — runtime config imported by all layers

### New Code Placement Rule (MANDATORY)

**All new code MUST be placed within the existing layer structure.**
Never create top-level directories under `src/` — all code goes into `core/`.

| New code type | Correct location | WRONG location |
|---------------|-----------------|----------------|
| Qdrant adapter/daemon | `core/adapters/qdrant/` | `src/embedded/` |
| Embedding adapter | `core/adapters/embeddings/` | `src/providers/` |
| New domain module | `core/<module-name>/` | `src/<module-name>/` |
| Bootstrap/config | `bootstrap/` | `src/config/` |

Tests mirror source structure: `tests/core/adapters/qdrant/` for `src/core/adapters/qdrant/`.

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
- `TrajectoryRegistry` in `trajectory/` aggregates trajectory implementations
- `trajectory/` exposes its query contract through public API
- `explore/` receives resolved data via DI (constructor params), never imports trajectory/
- `api/` creates registry from trajectory/, extracts data, passes to explore/

## Terminology (MANDATORY)

### Signal Taxonomy

| Term | Definition | Example | Where |
|------|-----------|---------|-------|
| **Signal** (raw) | Value stored in Qdrant payload. Defined by Provider. Not normalized. | `ageDays=142`, `commitCount=23`, `bugFixRate=35` | `payload.git.file.*`, `payload.git.chunk.*` |
| **Derived Signal** | Normalized/transformed value computed from one or more raw signals at rerank time. Range 0-1. Used as weight keys in presets. | `recency` (from ageDays), `ownership` (from dominantAuthorPct+authors) | `DerivedSignalDescriptor` in provider |
| **Structural Signal** | Derived signal from payload structure, not from any trajectory provider. | `similarity`, `chunkSize`, `documentation`, `imports`, `pathRisk` | Reranker built-in |
| **Preset** (`RerankPreset`) | Class with name, description, tools[], weights, overlayMask. 3-level hierarchy: Generic → Trajectory → Composite. Each preset is a class file. | `class TechDebtPreset { tools: ["semantic_search"], weights: {...}, overlayMask: {...} }` | `trajectory/git/rerank/presets/`, `explore/rerank/presets/` |
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
    explore-facade.ts                  # ExploreFacade (MCP entry)
    schema-builder.ts                  # SchemaBuilder: dynamic MCP schemas via Reranker API (DIP)

  explore/                             # Domain module: query-time reranking engine
    reranker.ts                        # Reranker: scoring, overlay mask, adaptive bounds
    rerank/
      presets/
        index.ts                       # resolvePresets() + getPresetNames/Weights (engine utility)
    search-module.ts                   # Search orchestration
    rank-module.ts                     # Scroll-based chunk ranking

  infra/                               # Foundation: runtime utilities
    runtime.ts                         # isDebug(), setDebug() — lowest layer

  trajectory/                          # Domain module: provider implementations
    static/
      index.ts                         # StaticTrajectory: base signals, structural derived, generic presets
      provider.ts                      # StaticPayloadBuilder.buildPayload(chunk, codebasePath)
      payload-signals.ts               # BASE_PAYLOAD_SIGNALS (base Qdrant payload fields)
      filters.ts                       # staticFilters: language, fileExtension, chunkType, isDocumentation
      rerank/
        derived-signals/               # Structural signal classes (1 per file)
          similarity.ts                # class SimilaritySignal
          chunk-size.ts                # class ChunkSizeSignal
          chunk-density.ts             # class ChunkDensitySignal
          documentation.ts             # class DocumentationSignal
          imports.ts                   # class ImportsSignal
          path-risk.ts                 # class PathRiskSignal
          index.ts                     # staticDerivedSignals: DerivedSignalDescriptor[]
        presets/
          relevance.ts                 # class RelevancePreset (multi-tool)
          decomposition.ts             # class DecompositionPreset (multi-tool)
          index.ts                     # STATIC_PRESETS[]
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
    collection.ts                      # resolveCollectionName, validatePath
    collection-stats.ts                # computeCollectionStats
    pipeline/
      enrichment/                      # coordinator, applier

  contracts/                           # Foundation: interfaces + registries
    signal-utils.ts                    # normalize, p95, payload resolvers
    types/
      provider.ts                      # Signal, FilterDescriptor, FilterLevel,
                                       # ScoringWeights, PayloadBuilder,
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
      client.ts                        # QdrantManager (REST client wrapper)
      embedded/                        # Embedded Qdrant daemon
        daemon.ts                      # Process manager with refcounting
        download.ts                    # Binary downloader (postinstall + lazy)
        types.ts                       # DaemonPaths, QdrantResolution
    git/
    embeddings/
```

## Commit Rules

### Commit Types (MANDATORY)

| Type       | When to use                               | Default bump |
|------------|-------------------------------------------|--------------|
| `feat`     | New capability that didn't exist before    | minor        |
| `improve`  | Enhancement to existing functionality      | patch        |
| `fix`      | Bug fix                                    | patch        |
| `perf`     | Performance improvement                    | patch        |
| `refactor` | Code restructuring, no behavior change     | patch        |
| `docs`     | Documentation only                         | patch        |
| `test`     | Adding/updating tests                      | none         |
| `chore`    | Build, dependencies, tooling               | none         |
| `ci`       | CI/CD changes                              | none         |
| `style`    | Code style/formatting                      | none         |
| `build`    | Build system changes                       | none         |

**feat vs improve**: `feat` = new capability. `improve` = enhancement to existing.

### Scope-Based Versioning (MANDATORY)

Scope determines version bump. **Always use a scope.**

**Public + Functional** (feat → minor):
`api`, `mcp`, `contracts`, `types`, `drift`, `explore`, `search`, `rerank`, `hybrid`,
`trajectory`, `signals`, `presets`, `filters`, `ingest`, `pipeline`, `chunker`

**Infrastructure** (feat → patch):
`onnx`, `embedding`, `embedded`, `adapters`, `qdrant`, `git`, `config`,
`factory`, `bootstrap`, `debug`, `logs`

**Non-release** (always none):
`test`, `beads`, `scripts`, `ci`, `website`, `deps`

A PostToolUse hook (`check-release-scope.sh`) warns when a commit uses
an unknown scope. When adding a new scope, update `.releaserc.json`
and the scope tables in `CONTRIBUTING.md`.

### BREAKING CHANGE footer (MANDATORY)

Add `BREAKING CHANGE:` footer to commit messages when:
- Environment variable names, defaults, or semantics change
- Configuration file format or location changes
- CLI flags or arguments change
- Package name changes
- Data directory paths change
- Any change that **requires user action** (update config, re-run setup, etc.)

Do NOT use BREAKING CHANGE for:
- Internal refactoring that doesn't affect user-facing behavior
- New features that are additive (no existing behavior changes)
- Bug fixes (unless the buggy behavior was documented/relied upon)

Format:

```text
feat(config): add embedded Qdrant support

BREAKING CHANGE: QDRANT_URL default changed from http://localhost:6333 to autodetect.
Users with Docker Qdrant should set QDRANT_URL=http://localhost:6333 explicitly.
```

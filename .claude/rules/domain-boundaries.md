---
paths:
  - "src/core/**"
  - "src/bootstrap/**"
  - "src/mcp/**"
---

# Domain Boundaries (MANDATORY)

## Layer Dependency Rules

```
                  api/                            <- Composition root
               /   |   \                           Imports from: everything (assembles DI)
             /     |     \
      domains/explore  domains/trajectory  domains/ingest  <- Domain modules
             \     |     /                          Import from: contracts/, adapters/, infra/
              \    |    /                           NOT from each other
          contracts/   adapters/   infra/         <- Foundation (lowest level)
```

**Dependency rules:**

| Layer                      | Imports from                                        | Exports to             |
| -------------------------- | --------------------------------------------------- | ---------------------- |
| `core/api/`                | domain modules, `contracts/`, `adapters/`, `infra/` | external consumers     |
| `core/domains/explore/`    | `contracts/`, `infra/`                              | `api/`                 |
| `core/domains/trajectory/` | `contracts/`, `adapters/`, `infra/`                 | `api/`                 |
| `core/domains/ingest/`     | `contracts/`, `adapters/`, `infra/`                 | `api/`                 |
| `core/contracts/`          | `infra/`                                            | domain modules, `api/` |
| `core/adapters/`           | `infra/`                                            | domain modules, `api/` |
| `core/infra/`              | nothing                                             | all layers             |

**api/ is the composition root:** it assembles dependencies from all layers,
creates instances, and wires them together via DI.

**Prohibited dependencies (hard errors):**

- Domain modules -x-> each other (`explore` -x-> `trajectory`, etc.)
- Foundation -x-> any layer above (`contracts`/`adapters`/`infra` -x-> domain
  modules or `api/`)

## Layer Responsibilities

**core/api/** — Composition root + unified App interface

- **public/**: App interface, createApp() factory, DTOs by domain
  - App interface (public/app.ts): unified public contract for MCP/CLI
  - createApp() + AppDeps: factory that wires internal classes into App
  - DTOs grouped by domain: explore, ingest, collection, document
- **internal/**: orchestration + wiring (not exported to MCP consumers)
  - facades/: ExploreFacade, IngestFacade (search/indexing orchestration)
  - ops/: CollectionOps, DocumentOps (CRUD operations)
  - infra/: SchemaBuilder (dynamic MCP schema generation via Reranker API)
  - composition.ts: trajectory registry assembly (which trajectories exist)
- **index.ts**: barrel exports public/ + SchemaBuilder + createComposition
- Imports from all layers (composition root assembles DI)

**core/domains/explore/** — Query-time exploration engine (domain module)

- Reranker (orchestrator: derived signals -> adaptive bounds -> scoring ->
  ranking overlay)
- SearchModule: vector search execution (dense/hybrid) with filter building
- RankModule: scroll-based chunk ranking without vector search
- post-process.ts: computeFetchLimit, postProcess, filterMetaOnly
- Receives descriptors + resolved presets via DI (constructor), never imports
  from trajectory/
- No signal definitions — all signals come from trajectory/ via registry
- Presets: 2-level hierarchy (registry -> composite), resolved at composition
  root

**core/domains/trajectory/** — Trajectory implementations (domain module)

- Static trajectory: base payload signals, structural derived signals, generic
  presets, static filters
- Git trajectory: git-enriched signals, derived signals, git-specific presets
  and filters
- StaticPayloadBuilder: builds base Qdrant payload (injected into pipeline via
  PayloadBuilder DIP)
- Provider implementations (EnrichmentProvider — optional, not all trajectories
  have ingest enrichment)

**core/domains/ingest/** — Indexing pipeline (domain module)

- Chunking, embedding, enrichment coordination
- Collection utilities (computeCollectionStats)
- Depends on PayloadBuilder and EnrichmentProvider interfaces from contracts,
  NOT from trajectory

**core/contracts/** — Shared interfaces, registries, utilities (foundation)

- All shared interfaces and types (Signal, FilterDescriptor, EnrichmentProvider,
  etc.)
- Signal utilities (normalize, p95, payload resolvers)
- Barrel exports via index.ts

**core/adapters/** — External system types (foundation)

- Qdrant types, client, embedded daemon (QdrantFilter, QdrantFilterCondition,
  etc.)
- Git client, embedding providers

**core/infra/** — Foundation utilities (lowest level)

- isDebug(), setDebug() — runtime config imported by all layers
- collection-name.ts: validatePath, resolveCollectionName, resolveCollection

## New Code Placement Rule (MANDATORY)

**All new code MUST be placed within the existing layer structure.** Never
create top-level directories under `src/` — all code goes into `core/`.

| New code type         | Correct location              | WRONG location       |
| --------------------- | ----------------------------- | -------------------- |
| Qdrant adapter/daemon | `core/adapters/qdrant/`       | `src/embedded/`      |
| Embedding adapter     | `core/adapters/embeddings/`   | `src/providers/`     |
| New domain module     | `core/domains/<module-name>/` | `src/<module-name>/` |
| Bootstrap/config      | `bootstrap/`                  | `src/config/`        |

Tests mirror source structure: `tests/core/adapters/qdrant/` for
`src/core/adapters/qdrant/`.

## Dependency Inversion Principle

Interfaces and registries live in `core/contracts/`. Implementations live in
domain modules. api/ orchestrates domain modules through their public APIs —
never touches foundation.

**Registries in contracts/:** registries work ONLY through interfaces. Domain
modules use them internally. api/ interacts with registries through domain
module facades, not by importing from contracts/ directly.

Example flow:

- `EnrichmentProvider` interface -> `core/contracts/types/provider.ts`
- `GitEnrichmentProvider` implementation ->
  `core/domains/trajectory/git/provider.ts`
- `EnrichmentCoordinator` in `core/domains/ingest/` imports only the interface
  from `core/contracts/`
- `TrajectoryRegistry` in `domains/trajectory/` aggregates implementations
- `domains/trajectory/` exposes its query contract through public API
- `domains/explore/` receives resolved data via DI (constructor params), never
  imports trajectory/
- `api/` creates registry from domains/trajectory/, passes to domains/explore/

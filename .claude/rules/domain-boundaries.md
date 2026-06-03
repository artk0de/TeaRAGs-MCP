---
paths:
  - "src/core/**"
  - "src/bootstrap/**"
  - "src/mcp/**"
---

# Domain Boundaries (MANDATORY)

## Layer Dependency Rules

```
   cli (entry) ── bootstrap (composition root) ── mcp (tool surface)
                       │
                       ▼
                  core/api  (core composition root)
                  /   |   \
                 /    |    \
            domains/{explore, trajectory, ingest, language}   <- Domain modules
                 \    |    /
                  \   |   /
              contracts   adapters   infra         <- Foundation (lowest level)
```

**Dependency rules:**

| Layer                      | Imports from                                                  | Exports to                   |
| -------------------------- | ------------------------------------------------------------- | ---------------------------- |
| `cli/`                     | `bootstrap/`, `core/api/public/`                              | (process entry)              |
| `mcp/`                     | `core/api/public/`                                            | tool surface                 |
| `bootstrap/`               | `mcp/`, `core/api/`, `core/{contracts, adapters, infra}/`     | composition root             |
| `src/index.ts`             | `bootstrap/`                                                  | process bootstrap            |
| `core/api/`                | domain modules, `contracts/`, `adapters/`, `infra/`           | `cli/`, `mcp/`, `bootstrap/` |
| `core/domains/explore/`    | `contracts/`, `adapters/`, `infra/`                           | `api/`                       |
| `core/domains/trajectory/` | `contracts/`, `adapters/`, `infra/`                           | `api/`                       |
| `core/domains/ingest/`     | `contracts/`, `adapters/`, `infra/`                           | `api/`                       |
| `core/domains/language/`   | `contracts/`, `infra/` _(leaf)_                               | injected via factory         |
| `core/contracts/`          | _(nothing — pure interfaces/types, zero `core/` deps)_        | domain modules, `api/`       |
| `core/adapters/`           | `infra/`                                                      | domain modules, `api/`       |
| `core/infra/`              | _(nothing)_                                                   | all `core/` layers           |

**Consumer surface rule (MANDATORY).** `cli`/`mcp` reach `core` ONLY through
`core/api/public/`. They do NOT import `api/internal`, `contracts`, `adapters`,
or `infra` directly. `api/public/index.ts` is the single curated re-export
facade: consumer-facing runtime symbols and types (error classes, registry
utilities, `EnrichmentHealthMap`, `IngestCodeConfig`) live in their internal
layer of origin and are re-exported through this barrel.

**Composition roots.**

- **`api/`** is the **core composition root** — assembles dependencies from
  every layer below and wires them via DI.
- **`bootstrap/`** is the **application composition root** above `api/`: parses
  config, builds the AppContext, and hands the wired `App` plus the MCP server
  registration to `cli` / `mcp`.

**Strict import-direction model.** Forbidden edges apply equally to runtime
imports AND `import type` declarations — no `allowTypeImports` escape hatch.
Relocating a type to a layer-correct home is always preferred over a typed-only
cross-layer reach. See spec
`docs/superpowers/specs/2026-05-27-dependency-direction-guard-design.md`.

**Prohibited dependencies (hard errors):**

- Domain modules -x-> each other (`explore` -x-> `trajectory`, etc.)
- Foundation -x-> any layer above (`contracts`/`adapters`/`infra` -x-> domain
  modules, `api/`, or outer layers)
- Outer layers -x-> `core` below `api/public` (`cli`/`mcp` -x-> `domains` /
  `contracts` / `adapters` / `infra` / `api/internal`)
- `contracts/` -x-> any `core/` layer (contracts are pure)

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
- **stats/** subdirectory (per trajectory): collection-stats accumulators the
  trajectory contributes to `computeCollectionStats`. Each accumulator reads
  only payload fields the trajectory owns (e.g. `git.file.dominantAuthor` lives
  in `git/stats/author-counts.ts`; `language` counts live in
  `static/stats/language-counts.ts`). Exported as
  `<domain>StatsAccumulators: readonly StatsAccumulatorDescriptor[]` and
  attached to the `Trajectory.statsAccumulators` field.

**core/domains/ingest/** — Indexing pipeline (domain module)

- Chunking, embedding, enrichment coordination
- Collection utilities (`computeCollectionStats` orchestrator)
- Depends on PayloadBuilder, EnrichmentProvider, and StatsAccumulatorDescriptor
  interfaces from contracts, NOT from trajectory
- Ingest MUST NOT reference trajectory-specific payload keys (e.g.
  `git.file.dominantAuthor`). Trajectory-owned aggregation lives in that
  trajectory's `stats/` subdirectory; ingest only orchestrates accumulators
  received via DI

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

Example flow (enrichment provider):

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

Example flow (stats accumulator):

- `StatsAccumulator<R>` / `StatsAccumulatorDescriptor` interfaces + well-known
  key constants (`STATS_ACCUMULATOR_KEYS`) ->
  `core/contracts/types/stats-accumulator.ts`
- `AuthorCountsAccumulator` (reads `git.file.dominantAuthor`) ->
  `core/domains/trajectory/git/stats/author-counts.ts`
- `LanguageCountsAccumulator` ->
  `core/domains/trajectory/static/stats/language-counts.ts`
- Each trajectory barrel (`stats/index.ts`) exports a
  `readonly StatsAccumulatorDescriptor[]` and the `Trajectory` instance attaches
  it as `statsAccumulators`
- `TrajectoryRegistry.getAllStatsAccumulators()` merges descriptors across
  registered trajectories; `createComposition()` pipes the merged list through
  `IngestFacadeDeps.statsAccumulators` → `IndexingOps.statsAccumulators` →
  `computeCollectionStats(points, signals, trajectoryAccumulators, ...)`
- `computeCollectionStats` in `domains/ingest/collection-stats.ts` only
  orchestrates — it derives a shared `PointContext` per point and calls `accept`
  on each accumulator instance, then collects results by key

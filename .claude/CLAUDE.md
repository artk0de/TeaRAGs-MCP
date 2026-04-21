# tea-rags — Project Rules

## Terminology (MANDATORY)

### Signal Taxonomy

| Term                             | Definition                                                                                                                                       | Example                                                                                   | Where                                                       |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------- | ----------------------------------------------------------- |
| **Signal** (raw)                 | Value stored in Qdrant payload. Defined by Provider. Not normalized.                                                                             | `ageDays=142`, `commitCount=23`, `bugFixRate=35`                                          | `payload.git.file.*`, `payload.git.chunk.*`                 |
| **Derived Signal**               | Normalized/transformed value computed from one or more raw signals at rerank time. Range 0-1. Used as weight keys in presets.                    | `recency` (from ageDays), `ownership` (from dominantAuthorPct+authors)                    | `DerivedSignalDescriptor` in provider                       |
| **Structural Signal**            | Derived signal from payload structure, not from any trajectory provider.                                                                         | `similarity`, `chunkSize`, `documentation`, `imports`, `pathRisk`                         | Reranker built-in                                           |
| **Preset** (`RerankPreset`)      | Class with name, description, tools[], weights, overlayMask. 3-level hierarchy: Generic -> Trajectory -> Composite. Each preset is a class file. | `class TechDebtPreset { tools: ["semantic_search"], weights: {...}, overlayMask: {...} }` | `trajectory/git/rerank/presets/`, `explore/rerank/presets/` |
| **Overlay Mask** (`OverlayMask`) | Curates which signals appear in ranking overlay for a preset. `derived: string[]` + optional `raw: { file?, chunk? }`.                           | `{ derived: ["age", "churn"], raw: { file: ["ageDays"] } }`                               | Each preset class                                           |
| **Ranking Overlay**              | Subset of raw + derived signals filtered by OverlayMask (or weight keys for custom), attached to each reranked result.                           | `{ raw: { file: { ageDays: 142 } }, derived: { recency: 0.61 } }`                         | Reranker response                                           |

### Domain Terms

| Term                 | Meaning                                                                                                                                |
| -------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| Provider             | Trajectory that defines signals, derived signals, filters, and builds signal data.                                                     |
| Filter               | Qdrant filter condition builder. Defined by Provider.                                                                                  |
| Reranker             | Orchestrates derived signal extraction, adaptive bounds, scoring, and ranking overlay. Receives descriptors + resolved presets via DI. |
| SchemaBuilder        | Generates Zod schemas for MCP tools from Reranker's public API (DIP). Lives in api/.                                                   |
| Alpha-blending       | L3 confidence-weighted blending of file vs chunk signals: `effective = alpha * chunk + (1-alpha) * file`.                              |
| Confidence dampening | Quadratic per-signal dampening for unreliable statistical signals: `(n/k)^2` where k is signal-specific threshold.                     |
| Adaptive bounds      | Per-query normalization bounds computed from result set (p95), floored with defaults.                                                  |

### Path Shortcuts

All paths relative to `src/core/`.

| Alias               | Path                                             |
| ------------------- | ------------------------------------------------ |
| `api-public`        | `api/public/`                                    |
| `api-internal`      | `api/internal/`                                  |
| `dto`               | `api/public/dto/`                                |
| `explore`           | `domains/explore/`                               |
| `explore-strats`    | `domains/explore/strategies/`                    |
| `explore-presets`   | `domains/explore/rerank/presets/`                |
| `ingest`            | `domains/ingest/`                                |
| `pipeline`          | `domains/ingest/pipeline/`                       |
| `chunker`           | `domains/ingest/pipeline/chunker/`               |
| `chunker-hooks`     | `domains/ingest/pipeline/chunker/hooks/`         |
| `enrichment`        | `domains/ingest/pipeline/enrichment/`            |
| `sync`              | `domains/ingest/sync/`                           |
| `traj-git`          | `domains/trajectory/git/`                        |
| `traj-git-signals`  | `domains/trajectory/git/rerank/derived-signals/` |
| `traj-git-presets`  | `domains/trajectory/git/rerank/presets/`         |
| `traj-git-stats`    | `domains/trajectory/git/stats/`                  |
| `traj-static`       | `domains/trajectory/static/`                     |
| `traj-static-stats` | `domains/trajectory/static/stats/`               |
| `contracts`         | `contracts/`                                     |
| `infra`             | `infra/`                                         |
| `migration`         | `infra/migration/`                               |
| `bootstrap`         | `bootstrap/`                                     |

### Design Principle: Don't Generate — Interrogate

The agent's instinct is to GENERATE variants fast and move on. The user's
strength is to INTERROGATE each variant until it breaks or holds.

**The anti-pattern that wastes time:**

1. Agent proposes "pure function renderOutline()" → user says it's wrong
2. Agent proposes "OutlineRenderer with strategies" → user says naming is wrong
3. Agent proposes "ChunkGroupView" → user says view doesn't reflect reality
4. Agent proposes "ChunkGrouper" → user approves

The agent went through 4 names because it generated instead of thinking. Each
time the user had to explain WHY it was wrong. The agent should have asked
itself: "what does this component DO?" → it groups chunks → ChunkGrouper. One
step, not four.

**Rule:** Before proposing a name or structure, answer three questions:

1. What does it DO? (verb → noun)
2. Who OWNS it? (domain)
3. What's the INTERFACE? (inputs/outputs)

If you can't answer all three — don't propose, investigate first.

**Why:** The user's time is more valuable than the agent's compute. Every bad
proposal the user has to reject is wasted human attention. Get it right in fewer
rounds.

### Naming Conventions

- `buildFileSignals` / `buildChunkSignals` (NOT
  buildFileMetadata/buildChunkMetadata)
- `GitFileSignals` / `GitChunkSignals` (NOT GitFileMetadata/ChunkChurnOverlay)
- `computeFileSignals` / `computeChunkSignals` (NOT
  computeFileMetadata/computeChunkOverlay)
- `fileSignalTransform` (NOT fileTransform)
- `Signal` type (NOT FieldDoc)
- `gitSignals: Signal[]` (NOT gitPayloadFields: FieldDoc[])

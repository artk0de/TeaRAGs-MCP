---
title: Custom Enrichments
sidebar_position: 2
---

# Custom Enrichments

How to add a new **trajectory enrichment provider** — a source of signals that decorate chunks with external metadata beyond what the code and git history carry. The architecture ships with two providers (`static` and `git`); the same contract lets you plug in more (e.g. test coverage, bug tracker metadata, code review history, deployment frequency).

For the query side — how enrichment signals turn into rerank weights and filters — see [Reranking](/introduction/core-concepts/reranking).

## What an Enrichment Provider Does

Each provider owns a **namespace** in the Qdrant payload (e.g. `git.*`, `static.*`, future `coverage.*`). It contributes:

- **Raw signals** — fields stored in the payload (`git.file.commitCount`, etc.)
- **Derived signals** — normalized 0–1 values computed from raw signals at rerank time (`recency`, `ownership`)
- **Filters** — typed filter parameters (e.g. `author`, `minCommitCount`) translated to Qdrant conditions
- **Presets** — rerank weight configurations that use the provider's signals (`techDebt`, `hotspots`)
- **Enrichment logic** — how to read raw signals from the external system and apply them to chunks

The contract enforces separation: query-side (signals, filters, presets) is read by the Reranker and MCP schema; ingest-side (enrichment logic) is driven by the indexing pipeline.

## The `EnrichmentProvider` Interface

Source: `src/core/contracts/types/provider.ts`

```ts
interface EnrichmentProvider {
  /** Namespace key for Qdrant payload: { [key].file: ..., [key].chunk: ... } */
  readonly key: string;

  // ── Query-side contract ──

  /** Payload signal descriptors (raw payload field docs for MCP schema generation) */
  readonly signals: PayloadSignalDescriptor[];
  /** Derived signal descriptors for reranking (normalized transforms of raw signals) */
  readonly derivedSignals: DerivedSignalDescriptor[];
  /** Typed filter parameters → Qdrant conditions */
  readonly filters: FilterDescriptor[];
  /** Trajectory-owned presets (weight configurations) */
  readonly presets: RerankPreset[];

  // ── Ingest-side contract ──

  /** Resolve the effective root for this provider (e.g. git repo root). */
  resolveRoot: (absolutePath: string) => string;
  /** Optional per-file transform applied at write time. */
  readonly fileSignalTransform?: FileSignalTransform;
  /** File-level signal enrichment (prefetch at T=0, or backfill for specific paths) */
  buildFileSignals: (root: string, options?: { paths?: string[] }) =>
    Promise<Map<string, FileSignalOverlay>>;
  /** Chunk-level signal enrichment (post-flush) */
  buildChunkSignals: (
    root: string,
    chunkMap: Map<string, ChunkLookupEntry[]>,
  ) => Promise<Map<string, Map<string, ChunkSignalOverlay>>>;
}
```

## Implementation Walkthrough — a Hypothetical `CoverageEnrichment`

Say you want to add test coverage as a signal (`coverage.file.linePct`, `coverage.file.branchPct`). Here's the end-to-end flow.

### 1. Choose the namespace

`key = "coverage"` → payloads become `coverage.file.linePct`, `coverage.chunk.linePct`, etc. Pick a short, unique, dot-free key.

### 2. Declare raw signals

`src/core/domains/trajectory/coverage/payload-signals.ts`:

```ts
export const coveragePayloadSignals: PayloadSignalDescriptor[] = [
  {
    key: "coverage.file.linePct",
    type: "number",
    description: "Line coverage for this file (0-100)",
    stats: { labels: { p25: "poor", p50: "fair", p75: "good", p95: "excellent" } },
    essential: true,
  },
  {
    key: "coverage.file.branchPct",
    type: "number",
    description: "Branch coverage for this file (0-100)",
  },
  {
    key: "coverage.chunk.linePct",
    type: "number",
    description: "Line coverage for this specific chunk (0-100)",
    stats: { labels: { p50: "fair", p75: "good" } },
  },
];
```

The `stats.labels` entries are what powers human-readable overlays in ranking results ("poor"/"good" based on codebase distribution).

### 3. Declare derived signals

`src/core/domains/trajectory/coverage/rerank/derived-signals/coverage-signal.ts`:

```ts
export class CoverageSignal implements DerivedSignalDescriptor {
  readonly name = "coverage";
  readonly description = "Test coverage: line % dampened by branch %.";
  readonly sources = ["file.linePct", "file.branchPct"];
  readonly defaultBound = 100;

  extract(raw: Record<string, unknown>, ctx?: ExtractContext): number {
    const line = fileNum(raw, "linePct") / 100;
    const branch = fileNum(raw, "branchPct") / 100;
    return Math.min(line, branch); // "min" = honest reading of "both must be high"
  }
}
```

One signal = one file in `derived-signals/`. Barrel-export from `derived-signals/index.ts`.

### 4. Declare filters

`src/core/domains/trajectory/coverage/filters.ts`:

```ts
export const coverageFilters: FilterDescriptor[] = [
  {
    name: "minLineCoverage",
    description: "Minimum line coverage percentage (0-100)",
    type: "number",
    toQdrant: (val) => ({ key: "coverage.file.linePct", range: { gte: val } }),
  },
  {
    name: "maxBranchCoverage",
    description: "Maximum branch coverage percentage",
    type: "number",
    toQdrant: (val) => ({ key: "coverage.file.branchPct", range: { lte: val } }),
  },
];
```

Filters automatically become MCP tool parameters via [`SchemaBuilder`](/architecture/overview) — no manual schema wiring needed.

### 5. Declare presets

`src/core/domains/trajectory/coverage/rerank/presets/untested.ts`:

```ts
export class UntestedPreset implements RerankPreset {
  readonly name = "untested";
  readonly description = "Find code with weak test coverage.";
  readonly tools = ["semantic_search", "rank_chunks", "hybrid_search"];
  readonly weights = {
    similarity: 0.2,
    coverage: -0.4,   // negative = prefer LOW coverage
    churn: 0.2,       // churny + untested = real risk
    bugFix: 0.2,
  };
  readonly overlayMask = {
    derived: ["coverage", "churn", "bugFix"],
    raw: { file: ["coverage.file.linePct", "coverage.file.branchPct"] },
  };
}
```

One preset = one class file. Barrel-export from `presets/index.ts`.

### 6. Implement the enrichment logic

`src/core/domains/trajectory/coverage/provider.ts`:

```ts
export class CoverageEnrichmentProvider implements EnrichmentProvider {
  readonly key = "coverage";
  readonly signals = coveragePayloadSignals;
  readonly derivedSignals = [new CoverageSignal()];
  readonly filters = coverageFilters;
  readonly presets = [new UntestedPreset()];

  constructor(private readonly config: CoverageConfig) {}

  resolveRoot(absolutePath: string) {
    return this.config.coverageRoot ?? absolutePath;
  }

  async buildFileSignals(root: string, options?: { paths?: string[] }) {
    const report = await readCoverageReport(root); // your external system
    const result = new Map<string, FileSignalOverlay>();
    for (const file of report.files) {
      if (options?.paths && !options.paths.includes(file.path)) continue;
      result.set(file.path, {
        "coverage.file.linePct": file.lineCoverage,
        "coverage.file.branchPct": file.branchCoverage,
      });
    }
    return result;
  }

  async buildChunkSignals(root: string, chunkMap: Map<string, ChunkLookupEntry[]>) {
    // Return: Map<filePath, Map<chunkId, overlay>>
    // Only needed if you have chunk-level granularity (e.g. per-function coverage)
    const out = new Map<string, Map<string, ChunkSignalOverlay>>();
    // ... map chunks to coverage lines via chunkMap[filePath][i].{startLine,endLine} ...
    return out;
  }
}
```

### 7. Register the provider

Edit `src/core/domains/ingest/pipeline/enrichment/trajectory/registry.ts` — or the current factory location — and add one line:

```ts
export function createEnrichmentProviders(config: AppConfig): EnrichmentProvider[] {
  return [
    new GitEnrichmentProvider(config.trajectoryGit, squashOpts),
    new CoverageEnrichmentProvider(config.coverage), // ← new line
  ];
}
```

Also register it in the trajectory composition so query-side signals are visible:

```ts
// src/core/api/internal/composition.ts
const trajectories = [
  new StaticTrajectory(),
  new GitTrajectory(gitConfig),
  new CoverageTrajectory(coverageConfig), // ← new line
];
```

That's it. `EnrichmentCoordinator` picks up the provider without any further wiring — its `Map<string, ProviderState>` manages multiple providers uniformly.

## Two Enrichment Strategies

`EnrichmentCoordinator` invokes your provider at two points:

| Stage | Method | When | Purpose |
|-------|--------|------|---------|
| Prefetch | `buildFileSignals(root)` | Once at indexing start | Bulk-load file-level signals for the whole codebase |
| Post-flush | `buildChunkSignals(root, chunkMap)` | After each batch of chunks is stored | Map chunks to their specific signals |

Most providers need both. If your data source is file-only (like a coverage summary), you can return an empty map from `buildChunkSignals` — the file-level signals propagate down to all chunks of that file automatically.

## Naming Conventions

From the project's internal style guide:

- Method names: `buildFileSignals`, `buildChunkSignals` (**not** `buildFileMetadata`)
- Type names: `FileSignalOverlay`, `ChunkSignalOverlay` (**not** `Metadata`)
- Namespace: `{provider.key}.file.*`, `{provider.key}.chunk.*`

Following these keeps your provider consistent with the existing error messages, docs, and tooling.

## Testing

Unit tests go under `tests/core/domains/trajectory/coverage/`:

- Derived signal tests — no mocks needed, pass plain objects to `extract()`
- Filter tests — verify `toQdrant` produces correct conditions
- Preset tests — direct instantiation, verify weights + overlayMask
- Provider tests — mock the external system (fs, HTTP), verify `buildFileSignals` / `buildChunkSignals` outputs

Integration tests live under `tests/core/domains/ingest/enrichment/`:

- End-to-end enrichment pipeline with mocked provider returning fixed signals
- Verify signals land in Qdrant payload under `coverage.*`

## Where Existing Providers Live

| Provider | Source |
|----------|--------|
| Static (structural signals) | `src/core/domains/trajectory/static/` |
| Git (authorship, churn, bug-fix rate) | `src/core/domains/trajectory/git/` |
| Enrichment coordinator (orchestrator) | `src/core/domains/ingest/pipeline/enrichment/coordinator.ts` |
| Provider applier (writes overlays to Qdrant) | `src/core/domains/ingest/pipeline/enrichment/applier.ts` |

Read the git provider as the canonical example — it's the most complex and exercises every part of the contract.

## Related

- [Data Model](/architecture/data-model) — where enriched signals end up
- [Git Enrichment Pipeline](/architecture/git-enrichment-pipeline) — fully-worked example of an enrichment provider
- [Reranking](/introduction/core-concepts/reranking) — how signals become scores
- [Custom Reranking](/agent-integration/search-strategies/custom-reranking) — agent-side usage of custom weights

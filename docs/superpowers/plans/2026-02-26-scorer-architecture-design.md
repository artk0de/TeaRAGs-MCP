# Scorer Architecture Design

## Terminology

- **Signal** — raw payload value stored in Qdrant (`git.file.commitCount`,
  `git.chunk.ageDays`)
- **Scorer** — reranking logic that reads signals and produces a normalized
  score (0-1)
- **CompositeScorer** — cross-trajectory scorer that combines leaf scorers from
  multiple trajectories

## Section 1: Metric Extractors + Assembler

### Problem

`metrics.ts` has a single `computeFileMetadata()` function (120 lines) that
computes all metrics inline. Not SOLID — adding a metric means editing one large
function.

### Solution: Strategy + Assembler

Each metric = pure function extractor. Assembler composes results.

```
trajectory/git/infra/
  metrics/
    extractors.ts        — pure functions per metric
    file-assembler.ts    — assembles GitFileMetadata from extractors
    chunk-assembler.ts   — assembles ChunkChurnOverlay from extractors
    types.ts             — ChunkAccumulator, shared types
```

**extractors.ts** — stateless pure functions:

- `computeDominantAuthor(commits) → { author, email, pct }`
- `computeTemporalMetrics(commits) → { lastModifiedAt, firstCreatedAt, ageDays, ... }`
- `computeChurnMetrics(churnData, lineCount) → { relativeChurn, recencyWeightedFreq, ... }`
- `computeBugFixRate(commits) → number`
- `computeChurnVolatility(commits) → number`
- `computeChangeDensity(commits) → number`
- `extractAllTaskIds(commits) → string[]`

**file-assembler.ts** — single responsibility:

```typescript
export function assembleFileMetadata(
  churnData: FileChurnData,
  currentLineCount: number,
): GitFileMetadata {
  const authorship = computeDominantAuthor(churnData.commits);
  const temporal = computeTemporalMetrics(churnData.commits);
  const churn = computeChurnMetrics(churnData, currentLineCount);
  // ...compose into GitFileMetadata
}
```

**chunk-assembler.ts** — same pattern for `ChunkChurnOverlay`.

Existing functions `isBugFixCommit()`, `overlaps()` stay as-is (already pure,
already extracted).

## Section 2: Scorer Class Architecture

### Interfaces — `core/api/scorer.ts`

```typescript
export interface Scorer {
  readonly name: string;
  readonly description: string;
  readonly defaultBound?: number;
  readonly needsConfidence?: boolean;
  readonly confidenceField?: string;
  extract(payload: Record<string, unknown>): number;
}

export interface CompositeScorer extends Scorer {
  readonly dependencies: string[];
  bind(scorers: Map<string, Scorer>): void;
}
```

### Leaf Scorer Classes — `trajectory/git/scorers/`

14 classes, one per file. Each implements `Scorer`.

```
trajectory/git/scorers/
  index.ts                 — exports gitScorers: Scorer[]
  recency.ts               — RecencyScorer
  stability.ts             — StabilityScorer
  churn.ts                 — ChurnScorer
  age.ts                   — AgeScorer
  ownership.ts             — OwnershipScorer
  bug-fix.ts               — BugFixScorer
  volatility.ts            — VolatilityScorer
  density.ts               — DensityScorer
  chunk-churn.ts           — ChunkChurnScorer
  relative-churn.ts        — RelativeChurnScorer
  burst-activity.ts        — BurstActivityScorer
  knowledge-silo.ts        — KnowledgeSiloScorer
  chunk-relative-churn.ts  — ChunkRelativeChurnScorer
  block-penalty.ts         — BlockPenaltyScorer
  _helpers.ts              — normalize(), fileNum(), chunkNum(), etc.
```

### Composite Scorer Classes — `core/search/scorers/`

Cross-trajectory scorers that call base scorer `extract()` directly.

```
core/search/scorers/
  tech-debt.ts             — TechDebtScorer
  hotspot.ts               — HotspotScorer
```

### Rename: `fields.ts` -> `signals.ts`

`trajectory/git/fields.ts` renamed to `trajectory/git/signals.ts` — these
`FieldDoc[]` entries describe raw signal values in the payload.

## Section 3: Registration & Uniqueness

### TrajectoryQueryContract update

```typescript
export interface TrajectoryQueryContract {
  readonly scorers: Scorer[];
  readonly filters: FilterDescriptor[];
  readonly presets: Record<string, ScoringWeights>;
  readonly payloadFields: FieldDoc[];
}
```

### Registration — two levels

**Trajectory level** — each trajectory registers its own leaf scorers.
Encapsulation preserved.

```typescript
// trajectory/git/contract.ts
export const gitContract: TrajectoryQueryContract = {
  scorers: gitScorers,
  filters: gitFilters,
  presets: gitPresets,
  payloadFields: gitPayloadFields,
};
```

**API level** — composite scorers defined in `core/api/scorers.ts`, registered
after all trajectories.

```typescript
// core/api/scorers.ts — factory returning composite scorers
export function createCompositeScorers(): CompositeScorer[] {
  return [new TechDebtScorer(), new HotspotScorer()];
}
```

### TrajectoryRegistry changes

- `getAllScorers(): Scorer[]` — leaf scorers from all trajectories
- `registerComposites(composites: CompositeScorer[])` — composites override
  same-named leafs
- `getAllPresets()` — presets reference scorer names

### Uniqueness rules

1. Leaf scorer name collision across trajectories = error
2. Composite always overrides leaf with same name
3. Composite depends on unregistered scorer = warning, lazy resolution

### Binding flow

```
1. register("git", gitContract)        → 14 leaf scorers
2. register("codegraph", cgContract)   → N leaf scorers
3. registerComposites([...])           → override + bind(resolvedDeps)
```

No trajectory sees another trajectory's scorers. Cross-cutting happens only at
the API layer via composites.

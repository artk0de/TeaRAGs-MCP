# Reranker Modularization — Final Decomposition

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to
> implement this plan task-by-task.

**Goal:** Decompose the 656-line monolithic `reranker.ts` into clean modules
with proper domain boundaries. Introduce `RerankPreset` type with 3-level
hierarchy (generic → trajectory → composite). Route MCP schemas through
`api/schema-builder.ts` via DIP. No functional changes — pure structural
refactoring.

**Architecture:**

- `RerankPreset`: typed preset with name, description, tool, weights
- 3-level resolution: Generic (RelevancePreset) → Trajectory (provider-defined)
  → Composite (future, overrides by key)
- Reranker receives resolved presets + descriptors via constructor (DI), never
  imports from trajectory/
- MCP schemas generated via `api/schema-builder.ts` (DIP), never direct
  domain/foundation imports
- Composition root (`bootstrap/factory.ts`) wires everything

**Tech Stack:** TypeScript, Vitest

**Supersedes:** `2026-02-26-reranker-v2-impl.md` Tasks 11-16

**Preserves:** All scoring improvements (L3 alpha-blending, quadratic
confidence, adaptive bounds, ranking overlay)

---

## Current state → Target state

### Current problems (8):

1. **Type duplication** — ScoringWeights, preset unions, RerankMode,
   RerankableResult duplicated in contracts/ AND search/reranker.ts
2. **Domain boundary violation** — search/reranker.ts imports
   `gitDerivedSignals` from trajectory/git/signals.ts
3. **Presets hardcoded without descriptions** — SEMANTIC_SEARCH_PRESETS,
   SEARCH_CODE_PRESETS are flat weight maps in reranker.ts, no descriptions, no
   typing
4. **No generic RelevancePreset** — `relevance` preset hardcoded in both preset
   maps, not separated as always-available default
5. **Git-specific types in search/** — GitFileFields, GitChunkFields,
   GitMetadata don't belong in search layer
6. **Facade pattern with singleton** — getFacadeReranker() creates hidden
   singleton, facade functions strip overlay
7. **normalize() tripled** — exists in contracts/signal-utils.ts (unused),
   structural-signals.ts (inline), git/signals.ts (inline)
8. **MCP schemas bypass api/** — schemas.ts imports structuralSignals from
   search/, gitDerivedSignals from trajectory/, DerivedSignalDescriptor from
   contracts/

### Preset hierarchy (target):

```
Generic:     RelevancePreset (structural only, always available)
                 ↓ overridden by
Trajectory:  techDebt, hotspots, codeReview, ... (provider-defined)
                 ↓ overridden by
Composite:   future (combines multiple trajectories, overrides by name+tool)
```

**Uniqueness rules:**

1. Within ANY trajectory: preset name unique (per tool)
2. Within ANY composite level: preset name unique (per tool)
3. Composite key overrides trajectory key (same name+tool)

### Target dependency flow:

```
bootstrap/factory.ts (composition root — can import from anywhere)
  ├─ creates TrajectoryRegistry, registers GitEnrichmentProvider
  ├─ resolves presets: generic + registry.getAllPresets() + composite
  ├─ creates Reranker(allDescriptors, resolvedPresets)
  ├─ creates SchemaBuilder(reranker)
  ├─ passes Reranker to SearchFacade (required)
  └─ passes SchemaBuilder to MCP tool registration

api/schema-builder.ts (DIP — MCP's interface to domain data)
  ├─ imports from search/ only (Reranker type)
  ├─ builds ScoringWeightsSchema from reranker.getDescriptorInfo()
  └─ builds PresetSchemas from reranker.getPresetNames(tool)

search/reranker.ts (pure, ~280 lines)
  ├─ Reranker class only
  ├─ imports from contracts/ only
  ├─ receives descriptors + resolvedPresets via constructor
  └─ exposes getDescriptorInfo(), getPresetNames(tool), getPresetWeights(name, tool)

search/presets/index.ts
  ├─ RELEVANCE_PRESETS (generic, structural-only)
  ├─ resolvePresets(generic, trajectory, composite) → RerankPreset[]
  └─ getPresetNames(), getPresetWeights() helpers

trajectory/git/presets.ts (NEW — Git trajectory presets with descriptions)
  └─ GIT_PRESETS: RerankPreset[] (techDebt, hotspots, ..., recent, stable)

contracts/types/reranker.ts (canonical types only)
  ├─ RerankPreset interface (name, description, tool, weights)
  ├─ DerivedSignalDescriptor, RerankableResult, RerankMode<T>
  └─ RankingOverlay, RankingOverlayRaw, RerankedResult
```

---

## Task 1: Define RerankPreset interface + update provider contract

**Files:**

- Modify: `src/core/contracts/types/reranker.ts` — add RerankPreset, remove
  preset type unions
- Modify: `src/core/contracts/types/provider.ts` — update
  EnrichmentProvider.presets type
- Modify: `src/core/contracts/trajectory-registry.ts` — update getAllPresets()
  return type
- Modify: `src/core/trajectory/git/provider.ts` — update presets field type
  (still empty)

**Step 1: Add RerankPreset to contracts/types/reranker.ts**

```typescript
/** Typed preset definition with description for schema generation and DI. */
export interface RerankPreset {
  readonly name: string;
  readonly description: string;
  readonly tool: "semantic_search" | "search_code";
  readonly weights: ScoringWeights;
}
```

Remove `SemanticSearchRerankPreset` and `SearchCodeRerankPreset` type unions
(lines 45-56).

**Step 2: Update EnrichmentProvider.presets in provider.ts**

```typescript
// Before:
readonly presets: Record<string, ScoringWeights>;

// After:
readonly presets: RerankPreset[];
```

Import `RerankPreset` from `./reranker.js`.

**Step 3: Update TrajectoryRegistry.getAllPresets()**

```typescript
// Before:
getAllPresets(): Record<string, ScoringWeights> {
  const merged: Record<string, ScoringWeights> = {};
  for (const provider of this.providers.values()) {
    Object.assign(merged, provider.presets);
  }
  return merged;
}

// After:
getAllPresets(): RerankPreset[] {
  const all: RerankPreset[] = [];
  for (const provider of this.providers.values()) {
    all.push(...provider.presets);
  }
  return all;
}
```

**Step 4: Update GitEnrichmentProvider.presets type**

```typescript
// Before:
readonly presets: Record<string, ScoringWeights> = {};

// After:
readonly presets: RerankPreset[] = [];
```

**Step 5: Run**

```bash
npx tsc --noEmit && npx vitest run
```

Expected: ALL PASS (no external consumers of old preset format — reranker.ts
still has its own local copies)

**Step 6: Commit**

```bash
git commit -m "refactor(contracts): add RerankPreset interface, update provider preset contract"
```

---

## Task 2: Create Git trajectory presets with descriptions

**Files:**

- Create: `src/core/trajectory/git/presets.ts`
- Modify: `src/core/trajectory/git/provider.ts` — import and use GIT_PRESETS

**Step 1: Create `src/core/trajectory/git/presets.ts`**

Move presets from reranker.ts, convert to `RerankPreset[]` with descriptions.
**Exclude `relevance`** — that is the generic RelevancePreset.

```typescript
import type { RerankPreset } from "../../contracts/types/reranker.js";

/** Git trajectory presets — reranking strategies using git-derived + structural signals. */
export const GIT_PRESETS: RerankPreset[] = [
  // ── semantic_search presets ──
  {
    name: "techDebt",
    description:
      "Find legacy code with high churn, old age, and frequent bug fixes",
    tool: "semantic_search",
    weights: {
      similarity: 0.2,
      age: 0.15,
      churn: 0.15,
      bugFix: 0.15,
      volatility: 0.1,
      knowledgeSilo: 0.1,
      density: 0.1,
      blockPenalty: -0.05,
    },
  },
  {
    name: "hotspots",
    description: "Identify frequently-changing bug-prone code areas",
    tool: "semantic_search",
    weights: {
      similarity: 0.25,
      chunkChurn: 0.15,
      chunkRelativeChurn: 0.15,
      burstActivity: 0.15,
      bugFix: 0.15,
      volatility: 0.15,
      blockPenalty: -0.15,
    },
  },
  {
    name: "codeReview",
    description: "Surface recent high-activity code for review",
    tool: "semantic_search",
    weights: {
      similarity: 0.35,
      recency: 0.15,
      burstActivity: 0.15,
      density: 0.15,
      chunkChurn: 0.2,
      blockPenalty: -0.1,
    },
  },
  {
    name: "onboarding",
    description: "Documentation and stable code for new team members",
    tool: "semantic_search",
    weights: { similarity: 0.4, documentation: 0.3, stability: 0.3 },
  },
  {
    name: "securityAudit",
    description: "Old code in security-critical paths needing review",
    tool: "semantic_search",
    weights: {
      similarity: 0.3,
      age: 0.15,
      ownership: 0.1,
      bugFix: 0.15,
      pathRisk: 0.15,
      volatility: 0.15,
    },
  },
  {
    name: "refactoring",
    description: "Large, churning, volatile code — candidates for refactoring",
    tool: "semantic_search",
    weights: {
      similarity: 0.2,
      chunkChurn: 0.15,
      relativeChurnNorm: 0.15,
      chunkSize: 0.15,
      volatility: 0.15,
      bugFix: 0.1,
      age: 0.1,
      blockPenalty: -0.1,
    },
  },
  {
    name: "ownership",
    description: "Code with single dominant author — knowledge transfer risk",
    tool: "semantic_search",
    weights: { similarity: 0.4, ownership: 0.35, knowledgeSilo: 0.25 },
  },
  {
    name: "impactAnalysis",
    description: "Highly-imported modules — changes affect many dependents",
    tool: "semantic_search",
    weights: { similarity: 0.5, imports: 0.5 },
  },

  // ── search_code presets ──
  {
    name: "recent",
    description: "Boost recently modified code",
    tool: "search_code",
    weights: { similarity: 0.7, recency: 0.3 },
  },
  {
    name: "stable",
    description: "Boost low-churn stable code",
    tool: "search_code",
    weights: { similarity: 0.7, stability: 0.3 },
  },
];
```

**Step 2: Update GitEnrichmentProvider**

```typescript
import { GIT_PRESETS } from "./presets.js";

export class GitEnrichmentProvider implements EnrichmentProvider {
  // ...
  readonly presets: RerankPreset[] = GIT_PRESETS;
  // ...
}
```

**Step 3: Run**

```bash
npx tsc --noEmit && npx vitest run
```

Expected: ALL PASS

**Step 4: Commit**

```bash
git commit -m "feat(trajectory): add Git trajectory presets with descriptions"
```

---

## Task 3: Create RelevancePreset + preset resolution infrastructure

**Files:**

- Create: `src/core/search/presets/index.ts`
- Create: `tests/core/search/presets/index.test.ts`

**Step 1: Write tests for preset resolution**

```typescript
import { describe, expect, it } from "vitest";

import type { RerankPreset } from "../../../../src/core/contracts/types/reranker.js";
import {
  getPresetNames,
  getPresetWeights,
  RELEVANCE_PRESETS,
  resolvePresets,
} from "../../../../src/core/search/presets/index.js";

describe("RELEVANCE_PRESETS", () => {
  it("provides relevance for semantic_search", () => {
    expect(getPresetNames(RELEVANCE_PRESETS, "semantic_search")).toContain(
      "relevance",
    );
  });

  it("provides relevance for search_code", () => {
    expect(getPresetNames(RELEVANCE_PRESETS, "search_code")).toContain(
      "relevance",
    );
  });

  it("uses only similarity weight", () => {
    const weights = getPresetWeights(
      RELEVANCE_PRESETS,
      "relevance",
      "semantic_search",
    );
    expect(weights).toEqual({ similarity: 1.0 });
  });
});

describe("resolvePresets", () => {
  const generic: RerankPreset[] = [
    {
      name: "relevance",
      description: "default",
      tool: "semantic_search",
      weights: { similarity: 1.0 },
    },
  ];
  const trajectory: RerankPreset[] = [
    {
      name: "techDebt",
      description: "debt",
      tool: "semantic_search",
      weights: { similarity: 0.2, age: 0.15 },
    },
  ];

  it("merges generic + trajectory", () => {
    const resolved = resolvePresets(generic, trajectory, []);
    expect(getPresetNames(resolved, "semantic_search")).toContain("relevance");
    expect(getPresetNames(resolved, "semantic_search")).toContain("techDebt");
  });

  it("composite overrides trajectory by name+tool", () => {
    const composite: RerankPreset[] = [
      {
        name: "techDebt",
        description: "overridden",
        tool: "semantic_search",
        weights: { similarity: 0.5 },
      },
    ];
    const resolved = resolvePresets(generic, trajectory, composite);
    expect(getPresetWeights(resolved, "techDebt", "semantic_search")).toEqual({
      similarity: 0.5,
    });
  });

  it("does not mix tools", () => {
    const resolved = resolvePresets(generic, trajectory, []);
    expect(getPresetNames(resolved, "search_code")).not.toContain("techDebt");
  });

  it("preserves generic when trajectory has different names", () => {
    const resolved = resolvePresets(generic, trajectory, []);
    expect(getPresetWeights(resolved, "relevance", "semantic_search")).toEqual({
      similarity: 1.0,
    });
  });
});
```

**Step 2: Run tests — verify RED**

```bash
npx vitest run tests/core/search/presets/
```

Expected: FAIL (module not found)

**Step 3: Implement `src/core/search/presets/index.ts`**

```typescript
import type { ScoringWeights } from "../../contracts/types/provider.js";
import type { RerankPreset } from "../../contracts/types/reranker.js";

// Re-export for consumers
export type { RerankPreset } from "../../contracts/types/reranker.js";

/** Generic relevance presets — always available regardless of registered trajectories. */
export const RELEVANCE_PRESETS: RerankPreset[] = [
  {
    name: "relevance",
    description: "Pure semantic similarity ranking",
    tool: "semantic_search",
    weights: { similarity: 1.0 },
  },
  {
    name: "relevance",
    description: "Pure semantic similarity ranking",
    tool: "search_code",
    weights: { similarity: 1.0 },
  },
];

/**
 * Resolve presets by 3-level hierarchy: generic → trajectory → composite.
 * Later levels override earlier by (name, tool) key.
 */
export function resolvePresets(
  generic: RerankPreset[],
  trajectory: RerankPreset[],
  composite: RerankPreset[],
): RerankPreset[] {
  const map = new Map<string, RerankPreset>();
  for (const preset of [...generic, ...trajectory, ...composite]) {
    map.set(`${preset.tool}:${preset.name}`, preset);
  }
  return [...map.values()];
}

/** Get preset names for a specific tool. */
export function getPresetNames(
  presets: RerankPreset[],
  tool: string,
): string[] {
  return presets.filter((p) => p.tool === tool).map((p) => p.name);
}

/** Get preset weights by name + tool. */
export function getPresetWeights(
  presets: RerankPreset[],
  name: string,
  tool: string,
): ScoringWeights | undefined {
  return presets.find((p) => p.name === name && p.tool === tool)?.weights;
}
```

**Step 4: Run tests — verify GREEN**

```bash
npx vitest run tests/core/search/presets/
```

Expected: ALL PASS

**Step 5: Run full suite**

```bash
npx tsc --noEmit && npx vitest run
```

Expected: ALL PASS

**Step 6: Commit**

```bash
git commit -m "feat(search): add RelevancePreset + preset resolution infrastructure"
```

---

## Task 4: Wire resolved presets into Reranker

**Files:**

- Modify: `src/core/search/reranker.ts` — add optional resolvedPresets param,
  use for lookup
- Modify: `tests/core/search/reranker.test.ts` — add test for preset-based
  Reranker

**Step 1: Add optional `resolvedPresets` parameter to Reranker constructor**

```typescript
// Before:
constructor(
  private readonly gitDerivedSignals: DerivedSignalDescriptor[],
  private readonly structuralSignals: DerivedSignalDescriptor[],
)

// After — backward compatible:
constructor(
  private readonly gitDerivedSignals: DerivedSignalDescriptor[],
  private readonly structuralSignals: DerivedSignalDescriptor[],
  private readonly resolvedPresets?: RerankPreset[],
)
```

Import `RerankPreset` from `../contracts/types/reranker.js` and `ScoringWeights`
from `../contracts/types/provider.js` (for type reference in getWeights).

**Step 2: Update preset lookup in rerank() method**

Add a private method to look up presets from resolvedPresets first, fallback to
hardcoded:

```typescript
private getWeights(mode: string, tool: string): ScoringWeights {
  // If resolved presets injected — use them
  if (this.resolvedPresets) {
    const preset = this.resolvedPresets.find(
      (p) => p.name === mode && p.tool === tool,
    );
    if (preset) return preset.weights;
  }
  // Fallback to hardcoded (removed in Task 7)
  if (tool === "semantic_search") return SEMANTIC_SEARCH_PRESETS[mode as SemanticSearchRerankPreset];
  return SEARCH_CODE_PRESETS[mode as SearchCodeRerankPreset];
}
```

**Step 3: Add public methods for SchemaBuilder (Task 8 will consume these)**

```typescript
/** Descriptor info for MCP schema generation. */
getDescriptorInfo(): { name: string; description: string }[] {
  return [...this.gitDerivedSignals, ...this.structuralSignals].map((d) => ({
    name: d.name,
    description: d.description,
  }));
}

/** Preset names for a specific tool. */
getPresetNames(tool: string): string[] {
  if (this.resolvedPresets) {
    return this.resolvedPresets.filter((p) => p.tool === tool).map((p) => p.name);
  }
  // Fallback (removed in Task 7)
  if (tool === "semantic_search") return Object.keys(SEMANTIC_SEARCH_PRESETS);
  return Object.keys(SEARCH_CODE_PRESETS);
}
```

**Step 4: Run**

```bash
npx tsc --noEmit && npx vitest run
```

Expected: ALL PASS (backward compatible — no existing caller passes
resolvedPresets)

**Step 5: Commit**

```bash
git commit -m "refactor(search): wire resolved presets into Reranker via optional DI"
```

---

## Task 5: Consolidate types — remove duplication from reranker.ts

**Files:**

- Modify: `src/core/search/reranker.ts` — delete duplicate types, import from
  contracts/
- Modify: `tests/core/search/reranker.test.ts` — update imports if needed

**Step 1: Delete from reranker.ts:**

- `ScoringWeights` interface (lines 27-47) — import from
  `contracts/types/provider.js`
- `RerankMode<T>` type (line 74) — import from `contracts/types/reranker.js`
- `RerankableResult` interface (lines 125-139) — import from
  `contracts/types/reranker.js`
- `GitFileFields` interface (lines 79-93) — delete entirely (unused outside
  reranker.ts)
- `GitChunkFields` interface (lines 98-108) — delete entirely
- `GitMetadata` interface (lines 116-120) — delete entirely
- `SemanticSearchRerankPreset` type (lines 52-61) — keep TEMPORARILY (facade
  still uses it, removed in Task 7)
- `SearchCodeRerankPreset` type (lines 66-69) — keep TEMPORARILY

**Step 2: Update imports at top of reranker.ts**

```typescript
import type { ScoringWeights } from "../contracts/types/provider.js";
import type {
  DerivedSignalDescriptor,
  RankingOverlay,
  RerankableResult,
  RerankMode,
  RerankPreset,
} from "../contracts/types/reranker.js";
```

**Step 3: Run**

```bash
npx tsc --noEmit && npx vitest run
```

Expected: ALL PASS

**Step 4: Commit**

```bash
git commit -m "refactor(search): consolidate types — remove duplication from reranker.ts"
```

---

## Task 6: Wire Reranker via composition root

**Files:**

- Modify: `src/bootstrap/factory.ts` — create Reranker with resolved presets,
  add to AppContext
- Modify: `src/core/api/search-facade.ts` — Reranker required (not optional)
- Modify: `src/core/search/search-module.ts` — Reranker required, remove facade
  fallback
- Modify: `src/mcp/tools/search.ts` — add Reranker to SearchToolDependencies,
  pass to applyPostProcessing
- Modify: `src/mcp/tools/formatters/search-pipeline.ts` — Reranker required in
  options, remove facade import

**Step 1: Create Reranker in factory.ts**

```typescript
import {
  RELEVANCE_PRESETS,
  resolvePresets,
} from "../core/search/presets/index.js";
import { Reranker } from "../core/search/reranker.js";
import { structuralSignals } from "../core/search/structural-signals.js";
import { GIT_PRESETS } from "../core/trajectory/git/presets.js";
import { gitDerivedSignals } from "../core/trajectory/git/signals.js";

export interface AppContext {
  qdrant: QdrantManager;
  embeddings: EmbeddingProvider;
  ingest: IngestFacade;
  search: SearchFacade;
  reranker: Reranker;
}

export function createAppContext(config: AppConfig): AppContext {
  const qdrant = new QdrantManager(config.qdrantUrl, config.qdrantApiKey);
  const embeddings = EmbeddingProviderFactory.createFromEnv();

  const allDescriptors = [...gitDerivedSignals, ...structuralSignals];
  const resolvedPresets = resolvePresets(RELEVANCE_PRESETS, GIT_PRESETS, []);
  const reranker = new Reranker(
    gitDerivedSignals,
    structuralSignals,
    resolvedPresets,
  );

  const ingest = new IngestFacade(qdrant, embeddings, config.code);
  const search = new SearchFacade(qdrant, embeddings, config.code, reranker);
  return { qdrant, embeddings, ingest, search, reranker };
}
```

**Step 2: Make Reranker required in SearchFacade** — remove `?` from constructor
param

**Step 3: Make Reranker required in SearchModule** — remove `?`, remove facade
fallback branch

**Step 4: Add Reranker to SearchToolDependencies** in `mcp/tools/search.ts`,
pass to `applyPostProcessing`

**Step 5: Make Reranker required in `applyPostProcessing`** options, remove
facade import + fallback

**Step 6: Run**

```bash
npx tsc --noEmit && npx vitest run
```

Expected: ALL PASS

**Step 7: Commit**

```bash
git commit -m "refactor: wire Reranker via composition root, make required in all consumers"
```

---

## Task 7: Remove facade functions + fix domain boundary + clean constructor

**Files:**

- Modify: `src/core/search/reranker.ts` — delete facade functions, delete
  imports, simplify constructor

**Step 1: Delete from reranker.ts:**

- `import { gitDerivedSignals } from "../trajectory/git/signals.js"` — **THE
  domain boundary violation**
- `import { structuralSignals } from "./structural-signals.js"` — only used by
  facade
- `SemanticSearchRerankPreset` type (kept temporarily in Task 5)
- `SearchCodeRerankPreset` type
- `SEMANTIC_SEARCH_PRESETS` constant
- `SEARCH_CODE_PRESETS` constant
- `_facadeReranker` singleton
- `getFacadeReranker()` function
- `rerankResults()` function
- `rerankSemanticSearchResults()` function
- `rerankSearchCodeResults()` function
- `getAvailablePresets()` standalone function

**Step 2: Make resolvedPresets required, simplify constructor**

```typescript
// Before (from Task 4):
constructor(
  private readonly gitDerivedSignals: DerivedSignalDescriptor[],
  private readonly structuralSignals: DerivedSignalDescriptor[],
  private readonly resolvedPresets?: RerankPreset[],
)

// After:
constructor(
  private readonly descriptors: DerivedSignalDescriptor[],
  private readonly resolvedPresets: RerankPreset[],
)
```

Update all internal references from
`this.gitDerivedSignals`/`this.structuralSignals` to `this.descriptors`.

**Step 3: Remove fallback branches** — `getWeights()` and `getPresetNames()` no
longer need hardcoded fallbacks

**Step 4: Update factory.ts** — adjust Reranker constructor call:

```typescript
// Before:
const reranker = new Reranker(
  gitDerivedSignals,
  structuralSignals,
  resolvedPresets,
);

// After:
const allDescriptors = [...gitDerivedSignals, ...structuralSignals];
const reranker = new Reranker(allDescriptors, resolvedPresets);
```

**Step 5: Update tests** — Reranker construction in tests now takes
`(descriptors, presets)`

**Step 6: Run**

```bash
npx tsc --noEmit && npx vitest run
```

Expected: ALL PASS. reranker.ts now ~280 lines, imports ONLY from contracts/.

**Step 7: Commit**

```bash
git commit -m "refactor(search): remove facade functions, fix domain boundary, simplify constructor"
```

---

## Task 8: Create api/schema-builder.ts — MCP schemas via DIP

**Files:**

- Create: `src/core/api/schema-builder.ts`
- Create: `tests/core/api/schema-builder.test.ts`
- Modify: `src/mcp/tools/schemas.ts` — remove hardcoded imports, use
  SchemaBuilder
- Modify: `src/mcp/tools/index.ts` — pass SchemaBuilder to tool registration
- Modify: `src/mcp/tools/search.ts` — receive schemas from SchemaBuilder
- Modify: `src/bootstrap/factory.ts` — create SchemaBuilder, add to AppContext

**Step 1: Write tests for SchemaBuilder**

```typescript
import { describe, expect, it } from "vitest";

import { SchemaBuilder } from "../../../../src/core/api/schema-builder.js";

describe("SchemaBuilder", () => {
  const mockReranker = {
    getDescriptorInfo: () => [
      { name: "recency", description: "Inverse of age" },
      { name: "similarity", description: "Semantic similarity" },
    ],
    getPresetNames: (tool: string) => {
      if (tool === "semantic_search") return ["relevance", "techDebt"];
      return ["relevance", "recent"];
    },
  };

  it("builds scoring weights schema with all descriptors", () => {
    const builder = new SchemaBuilder(mockReranker as any);
    const schema = builder.buildScoringWeightsSchema();
    const shape = schema.shape;
    expect(shape).toHaveProperty("recency");
    expect(shape).toHaveProperty("similarity");
  });

  it("builds preset schema for semantic_search", () => {
    const builder = new SchemaBuilder(mockReranker as any);
    const schema = builder.buildPresetSchema("semantic_search");
    expect(schema.options).toEqual(["relevance", "techDebt"]);
  });

  it("builds preset schema for search_code", () => {
    const builder = new SchemaBuilder(mockReranker as any);
    const schema = builder.buildPresetSchema("search_code");
    expect(schema.options).toEqual(["relevance", "recent"]);
  });
});
```

**Step 2: Run tests — verify RED**

```bash
npx vitest run tests/core/api/schema-builder
```

Expected: FAIL (module not found)

**Step 3: Implement `src/core/api/schema-builder.ts`**

```typescript
import { z } from "zod";

import type { Reranker } from "../search/reranker.js";

/**
 * Dynamic MCP schema generation via Reranker API.
 * MCP layer imports this from api/, never touches domain/foundation directly.
 */
export class SchemaBuilder {
  constructor(private readonly reranker: Reranker) {}

  /** Build Zod schema for custom scoring weights. */
  buildScoringWeightsSchema(): z.ZodObject<
    Record<string, z.ZodOptional<z.ZodNumber>>
  > {
    const shape: Record<string, z.ZodOptional<z.ZodNumber>> = {};
    for (const d of this.reranker.getDescriptorInfo()) {
      shape[d.name] = z.number().optional().describe(d.description);
    }
    return z.object(shape);
  }

  /** Build Zod enum schema for preset names by tool. */
  buildPresetSchema(tool: string): z.ZodEnum<[string, ...string[]]> {
    const names = this.reranker.getPresetNames(tool);
    return z.enum(names as [string, ...string[]]);
  }
}
```

**Step 4: Run tests — verify GREEN**

**Step 5: Update schemas.ts** — remove hardcoded imports, receive SchemaBuilder

```typescript
// REMOVE these imports:
// import type { DerivedSignalDescriptor } from "../../core/contracts/types/reranker.js";
// import { structuralSignals } from "../../core/search/structural-signals.js";
// import { gitDerivedSignals } from "../../core/trajectory/git/signals.js";

// Replace with parameterized schema creation:
import type { SchemaBuilder } from "../../core/api/schema-builder.js";

export function createSchemas(schemaBuilder: SchemaBuilder) {
  const ScoringWeightsSchema = schemaBuilder.buildScoringWeightsSchema();
  const SemanticSearchRerankPresetSchema =
    schemaBuilder.buildPresetSchema("semantic_search");
  const SearchCodeRerankPresetSchema =
    schemaBuilder.buildPresetSchema("search_code");
  // ... build and return all tool schemas using these
}
```

**Step 6: Wire SchemaBuilder in factory.ts + tool registration**

```typescript
// factory.ts:
import { SchemaBuilder } from "../core/api/schema-builder.js";

export interface AppContext {
  // ... existing fields
  schemaBuilder: SchemaBuilder;
}

// In createAppContext:
const schemaBuilder = new SchemaBuilder(reranker);
```

Update `mcp/tools/index.ts` to receive SchemaBuilder and pass to tool
registration.

**Step 7: Run**

```bash
npx tsc --noEmit && npx vitest run
```

Expected: ALL PASS

**Step 8: Commit**

```bash
git commit -m "refactor(api): add SchemaBuilder — MCP schemas via DIP, no hardcoded imports"
```

---

## Task 9: Consolidate normalize() utility

**Files:**

- Modify: `src/core/search/structural-signals.ts` — remove inline normalize,
  import from contracts
- Modify: `src/core/trajectory/git/signals.ts` — remove inline normalize, import
  from contracts
- Modify: `src/core/contracts/signal-utils.ts` — add p95() (currently in
  reranker.ts)
- Modify: `src/core/search/reranker.ts` — import p95 from
  contracts/signal-utils.js

**Step 1: Move p95() from reranker.ts to contracts/signal-utils.ts**

**Step 2: Update structural-signals.ts** — replace inline `normalize()` with
`import { normalize } from "../contracts/signal-utils.js"`

**Step 3: Update git/signals.ts** — replace inline `normalize()` with
`import { normalize } from "../../contracts/signal-utils.js"`

**Step 4: Update reranker.ts** — import p95 from `../contracts/signal-utils.js`

**Step 5: Run**

```bash
npx tsc --noEmit && npx vitest run
```

Expected: ALL PASS

**Step 6: Commit**

```bash
git commit -m "refactor: consolidate normalize() and p95() in contracts/signal-utils"
```

---

## Task 10: Update CLAUDE.md + final verification

**Files:**

- Modify: `.claude/CLAUDE.md` — update project structure, types, preset docs

**Step 1: Update CLAUDE.md** project structure section to reflect:

- `search/presets/` directory with RelevancePreset + resolution logic
- `trajectory/git/presets.ts` with Git trajectory presets
- `api/schema-builder.ts` for dynamic MCP schemas via DIP
- Updated `contracts/types/reranker.ts` (RerankPreset, no preset type unions)
- Updated `search/reranker.ts` (pure Reranker class, no facades)

**Step 2: Full verification**

```bash
npx tsc --noEmit && npx vitest run
```

Expected: ALL PASS, 0 type errors

**Step 3: Verify domain boundaries**

```bash
# search/ must NOT import from trajectory/
grep -r "from.*trajectory" src/core/search/
# contracts/ must NOT import from search/ or trajectory/
grep -r "from.*search\|from.*trajectory" src/core/contracts/
# mcp/ must NOT import structuralSignals, gitDerivedSignals, DerivedSignalDescriptor directly
grep -r "structuralSignals\|gitDerivedSignals\|DerivedSignalDescriptor" src/mcp/
```

All must return 0 results.

**Step 4: Commit**

```bash
git commit -m "docs: update CLAUDE.md for reranker modularization"
```

---

## Summary

| Task | Description                                       | Key change                                             |
| ---- | ------------------------------------------------- | ------------------------------------------------------ |
| 1    | Define RerankPreset + update provider contract    | New type, updated EnrichmentProvider.presets           |
| 2    | Create Git trajectory presets with descriptions   | trajectory/git/presets.ts, provider populated          |
| 3    | RelevancePreset + preset resolution (TDD)         | search/presets/index.ts, 3-level hierarchy             |
| 4    | Wire resolved presets into Reranker               | Optional DI, backward compatible                       |
| 5    | Consolidate types                                 | Delete 5 type defs from reranker.ts                    |
| 6    | Wire composition root                             | factory.ts creates Reranker with resolved presets      |
| 7    | Remove facades + fix boundary + clean constructor | Delete 7 functions, simplify to (descriptors, presets) |
| 8    | Create api/schema-builder.ts (TDD)                | MCP schemas via DIP, no hardcoded imports              |
| 9    | Consolidate normalize()                           | Single source in contracts/signal-utils.ts             |
| 10   | Update CLAUDE.md + verify                         | Documentation + domain boundary verification           |

**Total commits:** 10 **reranker.ts:** 656 lines → ~280 lines **New files:**
`search/presets/index.ts`, `trajectory/git/presets.ts`, `api/schema-builder.ts`
**Domain boundary violations fixed:** 4 (reranker.ts→trajectory,
schemas.ts→search+trajectory+contracts, search-pipeline.ts→reranker facades)
**No functional changes** — pure structural refactoring, all tests must pass at
every step

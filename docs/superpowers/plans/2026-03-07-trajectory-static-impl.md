# trajectory/static Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to
> implement this plan task-by-task.

**Goal:** Move structural signals, generic presets, and base payload
construction into trajectory/static for architectural uniformity.

**Architecture:** Create StaticTrajectory (implements Trajectory) with payload
signals, derived signals, presets, and filters. Extract payload construction
from chunk-pipeline into StaticPayloadBuilder. Make Trajectory.enrichment
optional. Update composition.ts to register StaticTrajectory alongside
GitTrajectory.

**Tech Stack:** TypeScript, Vitest

---

### Task 1: Make Trajectory.enrichment optional

**Files:**

- Modify: `src/core/contracts/types/trajectory.ts:72-83`
- Modify: `src/core/trajectory/index.ts:100-103`

**Step 1: Update Trajectory interface**

In `src/core/contracts/types/trajectory.ts`, change line 82:

```typescript
  // Before:
  readonly enrichment: EnrichmentProvider;
  // After:
  readonly enrichment?: EnrichmentProvider;
```

**Step 2: Update TrajectoryRegistry.getAllEnrichmentProviders()**

In `src/core/trajectory/index.ts`, change line 102:

```typescript
  // Before:
  getAllEnrichmentProviders(): EnrichmentProvider[] {
    return [...this.trajectories.values()].map((t) => t.enrichment);
  }
  // After:
  getAllEnrichmentProviders(): EnrichmentProvider[] {
    return [...this.trajectories.values()]
      .filter((t): t is Trajectory & { enrichment: EnrichmentProvider } => t.enrichment !== undefined)
      .map((t) => t.enrichment);
  }
```

**Step 3: Run tests**

Run: `npx vitest run` Expected: All pass (no behavior change — GitTrajectory
still has enrichment)

**Step 4: Commit**

```bash
git add src/core/contracts/types/trajectory.ts src/core/trajectory/index.ts
git commit -m "refactor(trajectory): make enrichment optional on Trajectory interface"
```

---

### Task 2: Create trajectory/static module — signals, presets, filters, payload-signals

Move files from `search/rerank/` to `trajectory/static/rerank/` and from
`contracts/` to `trajectory/static/`. Update internal import paths in moved
files. Add new files (filters, StaticPayloadBuilder, StaticTrajectory).

**Files to create/move:**

**Derived signals** — move 6 signal files + index from
`src/core/search/rerank/derived-signals/` to
`src/core/trajectory/static/rerank/derived-signals/`:

- `similarity.ts`
- `chunk-size.ts`
- `chunk-density.ts`
- `documentation.ts`
- `imports.ts`
- `path-risk.ts`
- `index.ts` — rename export from `structuralSignals` to `staticDerivedSignals`

Each moved signal file needs import path updates. The imports reference
`../../../contracts/...` which will become `../../../../contracts/...` (one
level deeper). Example for chunk-size.ts:

```typescript
// Before (in search/rerank/derived-signals/):

// After (in trajectory/static/rerank/derived-signals/):
import { normalize } from "../../../../contracts/signal-utils.js";
import type { DerivedSignalDescriptor } from "../../../../contracts/types/reranker.js";
import type { ExtractContext } from "../../../../contracts/types/trajectory.js";
import { normalize } from "../../../contracts/signal-utils.js";
import type { DerivedSignalDescriptor } from "../../../contracts/types/reranker.js";
import type { ExtractContext } from "../../../contracts/types/trajectory.js";
```

Apply the same `../../../` → `../../../../` fix to ALL 6 signal files.

The index.ts becomes:

```typescript
import type { DerivedSignalDescriptor } from "../../../../contracts/types/reranker.js";
import { ChunkDensitySignal } from "./chunk-density.js";
import { ChunkSizeSignal } from "./chunk-size.js";
import { DocumentationSignal } from "./documentation.js";
import { ImportsSignal } from "./imports.js";
import { PathRiskSignal } from "./path-risk.js";
import { SimilaritySignal } from "./similarity.js";

export { ChunkDensitySignal } from "./chunk-density.js";
export { ChunkSizeSignal } from "./chunk-size.js";
export { DocumentationSignal } from "./documentation.js";
export { ImportsSignal } from "./imports.js";
export { PathRiskSignal } from "./path-risk.js";
export { SimilaritySignal } from "./similarity.js";

export const staticDerivedSignals: DerivedSignalDescriptor[] = [
  new SimilaritySignal(),
  new ChunkSizeSignal(),
  new ChunkDensitySignal(),
  new DocumentationSignal(),
  new ImportsSignal(),
  new PathRiskSignal(),
];
```

**Presets** — move 2 preset files + create new index from
`src/core/search/rerank/presets/` to
`src/core/trajectory/static/rerank/presets/`:

- `relevance.ts` — update `../../../contracts/` → `../../../../contracts/`
- `decomposition.ts` — same path update

Create new `index.ts`:

```typescript
import type { RerankPreset } from "../../../../contracts/types/reranker.js";
import { DecompositionPreset } from "./decomposition.js";
import { RelevancePreset } from "./relevance.js";

export { DecompositionPreset } from "./decomposition.js";
export { RelevancePreset } from "./relevance.js";

export const STATIC_PRESETS: RerankPreset[] = [
  new RelevancePreset(),
  new DecompositionPreset(),
];
```

**Payload signals** — move from `src/core/contracts/payload-signals.ts` to
`src/core/trajectory/static/payload-signals.ts`:

```typescript
import type { PayloadSignalDescriptor } from "../../contracts/types/trajectory.js";

export const BASE_PAYLOAD_SIGNALS: PayloadSignalDescriptor[] = [
  {
    key: "relativePath",
    type: "string",
    description: "File path relative to project root",
  },
  {
    key: "fileExtension",
    type: "string",
    description: "File extension (e.g. '.ts')",
  },
  { key: "language", type: "string", description: "Programming language" },
  {
    key: "startLine",
    type: "number",
    description: "Start line of chunk in file",
  },
  { key: "endLine", type: "number", description: "End line of chunk in file" },
  {
    key: "chunkIndex",
    type: "number",
    description: "Chunk position within file",
  },
  {
    key: "isDocumentation",
    type: "boolean",
    description: "Whether chunk is documentation",
  },
  {
    key: "chunkType",
    type: "string",
    description: "Chunk type (function, class, block, etc.)",
  },
  {
    key: "name",
    type: "string",
    description: "Symbol name (class, function, etc.)",
  },
  { key: "parentName", type: "string", description: "Parent symbol name" },
  { key: "parentType", type: "string", description: "Parent symbol type" },
  {
    key: "imports",
    type: "string[]",
    description: "File-level imports inherited by all chunks",
  },
  {
    key: "symbolId",
    type: "string",
    description: "Unique symbol identifier (e.g. 'MyClass.processData')",
  },
  {
    key: "methodLines",
    type: "number",
    description: "Original method/block line count before splitting",
  },
  {
    key: "methodDensity",
    type: "number",
    description:
      "Code density: characters per line (contentSize / methodLines)",
  },
  {
    key: "contentSize",
    type: "number",
    description: "Character count of chunk content",
  },
];
```

Note: added `methodLines`, `methodDensity`, `contentSize` which were missing
from original BASE_PAYLOAD_SIGNALS.

**Filters** — create `src/core/trajectory/static/filters.ts`:

```typescript
import type { FilterDescriptor } from "../../contracts/types/provider.js";

export const staticFilters: FilterDescriptor[] = [
  {
    param: "language",
    description: "Filter by programming language",
    type: "string",
    toCondition: (value: unknown) => [
      { key: "language", match: { value: value as string } },
    ],
  },
  {
    param: "fileExtension",
    description: "Filter by file extension (e.g. '.ts')",
    type: "string",
    toCondition: (value: unknown) => [
      { key: "fileExtension", match: { value: value as string } },
    ],
  },
  {
    param: "chunkType",
    description: "Filter by chunk type (function, class, interface, block)",
    type: "string",
    toCondition: (value: unknown) => [
      { key: "chunkType", match: { value: value as string } },
    ],
  },
  {
    param: "isDocumentation",
    description: "Filter documentation chunks",
    type: "boolean",
    toCondition: (value: unknown) => [
      { key: "isDocumentation", match: { value: value as boolean } },
    ],
  },
];
```

**StaticPayloadBuilder** — create `src/core/trajectory/static/provider.ts`:

```typescript
import { extname, relative } from "node:path";

import type { CodeChunk } from "../../types.js";

export class StaticPayloadBuilder {
  static buildPayload(
    chunk: CodeChunk,
    codebasePath: string,
  ): Record<string, unknown> {
    const relativePath = relative(codebasePath, chunk.metadata.filePath);
    return {
      content: chunk.content,
      contentSize: chunk.content.length,
      relativePath,
      startLine: chunk.startLine,
      endLine: chunk.endLine,
      fileExtension: extname(chunk.metadata.filePath),
      language: chunk.metadata.language,
      codebasePath,
      chunkIndex: chunk.metadata.chunkIndex,
      ...(chunk.metadata.name && { name: chunk.metadata.name }),
      ...(chunk.metadata.chunkType && { chunkType: chunk.metadata.chunkType }),
      ...(chunk.metadata.parentName && {
        parentName: chunk.metadata.parentName,
      }),
      ...(chunk.metadata.parentType && {
        parentType: chunk.metadata.parentType,
      }),
      ...(chunk.metadata.symbolId && { symbolId: chunk.metadata.symbolId }),
      ...(chunk.metadata.isDocumentation && {
        isDocumentation: chunk.metadata.isDocumentation,
      }),
      ...(chunk.metadata.imports?.length && {
        imports: chunk.metadata.imports,
      }),
      ...(chunk.metadata.methodLines && {
        methodLines: chunk.metadata.methodLines,
        methodDensity: Math.round(
          chunk.content.length / chunk.metadata.methodLines,
        ),
      }),
    };
  }
}
```

**StaticTrajectory** — create `src/core/trajectory/static/index.ts`:

```typescript
import type { Trajectory } from "../../contracts/types/trajectory.js";
import { staticFilters } from "./filters.js";
import { BASE_PAYLOAD_SIGNALS } from "./payload-signals.js";
import { staticDerivedSignals } from "./rerank/derived-signals/index.js";
import { STATIC_PRESETS } from "./rerank/presets/index.js";

export class StaticTrajectory implements Trajectory {
  readonly key = "static";
  readonly name = "Static";
  readonly description =
    "Base payload signals, structural derived signals, and generic presets";
  readonly payloadSignals = BASE_PAYLOAD_SIGNALS;
  readonly derivedSignals = staticDerivedSignals;
  readonly filters = staticFilters;
  readonly presets = STATIC_PRESETS;
}
```

**Step: Run type check**

Run: `npx tsc --noEmit` Expected: May have errors from old files still existing
— that's OK, we fix in next tasks.

**Step: Commit**

```bash
git add src/core/trajectory/static/
git commit -m "feat(trajectory): create static trajectory module with signals, presets, filters, payload builder"
```

---

### Task 3: Update composition.ts and simplify resolvePresets

**Files:**

- Modify: `src/core/api/composition.ts`
- Modify: `src/core/search/rerank/presets/index.ts`

**Step 1: Simplify resolvePresets**

In `src/core/search/rerank/presets/index.ts`, remove RELEVANCE_PRESETS,
individual preset imports, and re-exports. Keep only `resolvePresets`,
`getPresetNames`, `getPresetWeights`:

```typescript
/**
 * Preset resolution infrastructure — merges presets from 2-level hierarchy:
 *   1. Registry presets (from all registered trajectories)
 *   2. Composite (future — combines multiple trajectories, overrides by key)
 *
 * Resolution rule: later levels override earlier by (name, tool) key.
 */

import type { ScoringWeights } from "../../../contracts/types/provider.js";
import type { RerankPreset } from "../../../contracts/types/reranker.js";

export type { RerankPreset } from "../../../contracts/types/reranker.js";

/**
 * Resolve presets by 2-level hierarchy: registry -> composite.
 * Later levels override earlier by (name, tool) key.
 * Multi-tool presets are indexed for each tool they support.
 */
export function resolvePresets(
  registry: RerankPreset[],
  composite: RerankPreset[],
): RerankPreset[] {
  const map = new Map<string, RerankPreset>();
  for (const preset of [...registry, ...composite]) {
    for (const t of preset.tools) {
      map.set(`${t}:${preset.name}`, preset);
    }
  }
  return [...new Set(map.values())];
}

export function getPresetNames(
  presets: RerankPreset[],
  tool: string,
): string[] {
  return presets.filter((p) => p.tools.includes(tool)).map((p) => p.name);
}

export function getPresetWeights(
  presets: RerankPreset[],
  name: string,
  tool: string,
): ScoringWeights | undefined {
  return presets.find((p) => p.name === name && p.tools.includes(tool))
    ?.weights;
}
```

**Step 2: Update composition.ts**

```typescript
/**
 * Composition root — assembles the full application graph from trajectories.
 *
 * Uses TrajectoryRegistry to aggregate payloadSignals, derivedSignals,
 * filters, and presets from all registered trajectories. The only place
 * that knows which trajectories exist.
 */

import type {
  DerivedSignalDescriptor,
  RerankPreset,
} from "../contracts/types/reranker.js";
import type { PayloadSignalDescriptor } from "../contracts/types/trajectory.js";
import { resolvePresets } from "../search/rerank/presets/index.js";
import { Reranker } from "../search/reranker.js";
import { GitTrajectory } from "../trajectory/git.js";
import { TrajectoryRegistry } from "../trajectory/index.js";
import { StaticTrajectory } from "../trajectory/static/index.js";

export interface CompositionResult {
  registry: TrajectoryRegistry;
  reranker: Reranker;
  allPayloadSignalDescriptors: PayloadSignalDescriptor[];
  allDerivedSignals: DerivedSignalDescriptor[];
  resolvedPresets: RerankPreset[];
}

export function createComposition(): CompositionResult {
  const registry = new TrajectoryRegistry();
  registry.register(new StaticTrajectory());
  registry.register(new GitTrajectory());

  const allPayloadSignalDescriptors = registry.getAllPayloadSignalDescriptors();
  const allDerivedSignals = registry.getAllDerivedSignals();
  const resolvedPresets = resolvePresets(registry.getAllPresets(), []);
  const reranker = new Reranker(
    allDerivedSignals,
    resolvedPresets,
    allPayloadSignalDescriptors,
  );

  return {
    registry,
    reranker,
    allPayloadSignalDescriptors,
    allDerivedSignals,
    resolvedPresets,
  };
}
```

**Step 3: Remove BASE_PAYLOAD_SIGNALS from contracts barrel**

In `src/core/contracts/index.ts`, remove line 6:

```typescript
export { BASE_PAYLOAD_SIGNALS } from "./payload-signals.js";
```

**Step 4: Run type check and tests**

Run: `npx vitest run` Expected: Some test failures due to old import paths —
fixed in Task 5.

**Step 5: Commit**

```bash
git add src/core/api/composition.ts src/core/search/rerank/presets/index.ts src/core/contracts/index.ts
git commit -m "refactor(composition): register StaticTrajectory, simplify resolvePresets to 2-level"
```

---

### Task 4: Delegate payload construction to StaticPayloadBuilder

**Files:**

- Modify: `src/core/ingest/pipeline/chunk-pipeline.ts:317-360`

**Step 1: Replace inline payload construction**

In `chunk-pipeline.ts`, replace the payload construction block (lines 317-360).
First add the import at the top:

```typescript
import { StaticPayloadBuilder } from "../../trajectory/static/provider.js";
```

Then replace the point-building block:

```typescript
// 3. Build points
const points = batch.items.map((item, idx) => ({
  id: item.chunkId,
  vector: embeddings[idx].embedding,
  payload: StaticPayloadBuilder.buildPayload(item.chunk, item.codebasePath),
}));
```

Also remove the `relative` and `extname` imports if they are no longer used
elsewhere in the file. Check before removing.

**Step 2: Run tests**

Run: `npx vitest run` Expected: Pass (same payload structure, just delegated)

**Step 3: Commit**

```bash
git add src/core/ingest/pipeline/chunk-pipeline.ts
git commit -m "refactor(pipeline): delegate payload construction to StaticPayloadBuilder"
```

---

### Task 5: Update all imports and delete old files

**Files to update (imports):**

In **src/**:

- No remaining src/ imports to old paths (composition.ts already updated)

In **tests/** — update ALL imports from old paths to new paths:

| Old import                                                                                | New import                                                                                                                                                                                    |
| ----------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `from "...src/core/search/rerank/derived-signals/index.js"` → `structuralSignals`         | `from "...src/core/trajectory/static/rerank/derived-signals/index.js"` → `staticDerivedSignals`                                                                                               |
| `from "...src/core/search/rerank/presets/index.js"` → `RELEVANCE_PRESETS, resolvePresets` | `from "...src/core/trajectory/static/rerank/presets/index.js"` → `STATIC_PRESETS` AND `from "...src/core/search/rerank/presets/index.js"` → `resolvePresets` (resolvePresets stays in search) |
| `from "...src/core/search/rerank/derived-signals/chunk-density.js"`                       | `from "...src/core/trajectory/static/rerank/derived-signals/chunk-density.js"`                                                                                                                |
| `from "...src/core/search/rerank/derived-signals/chunk-size.js"`                          | `from "...src/core/trajectory/static/rerank/derived-signals/chunk-size.js"`                                                                                                                   |
| `from "...src/core/search/rerank/presets/decomposition.js"`                               | `from "...src/core/trajectory/static/rerank/presets/decomposition.js"`                                                                                                                        |

**Test files to update:**

1. `tests/core/search/structural-signals.test.ts` — change `structuralSignals` →
   `staticDerivedSignals`, update import path
2. `tests/core/search/reranker.test.ts` — update both imports
3. `tests/core/search/search-module.test.ts` — update both imports
4. `tests/core/search/presets/index.test.ts` — replace `RELEVANCE_PRESETS` with
   `STATIC_PRESETS`, update import. `resolvePresets` stays from search/
5. `tests/core/search/rerank/presets/decomposition.test.ts` — update both
   imports
6. `tests/core/search/rerank/derived-signals/chunk-density.test.ts` — update
   import path
7. `tests/core/search/rerank/derived-signals/chunk-size.test.ts` — update import
   path
8. `tests/core/ingest/indexer.test.ts` — update both imports
9. `tests/integration/integration.test.ts` — update both imports
10. `tests/bootstrap/factory.test.ts` — check mock references, update if needed

For each test, replace:

- `structuralSignals` → `staticDerivedSignals`
- `RELEVANCE_PRESETS` → `STATIC_PRESETS`
- Import paths adjusted accordingly

`resolvePresets` import stays from `src/core/search/rerank/presets/index.js` —
it's the engine utility, not a trajectory artifact. BUT its signature changed
from 3 args to 2. Update all call sites:

```typescript
// Before:
resolvePresets(RELEVANCE_PRESETS, GIT_PRESETS, []);
// After:
resolvePresets([...STATIC_PRESETS, ...GIT_PRESETS], []);
```

**Files to DELETE:**

1. `src/core/search/rerank/derived-signals/similarity.ts`
2. `src/core/search/rerank/derived-signals/chunk-size.ts`
3. `src/core/search/rerank/derived-signals/chunk-density.ts`
4. `src/core/search/rerank/derived-signals/documentation.ts`
5. `src/core/search/rerank/derived-signals/imports.ts`
6. `src/core/search/rerank/derived-signals/path-risk.ts`
7. `src/core/search/rerank/derived-signals/index.ts`
8. `src/core/search/rerank/presets/relevance.ts`
9. `src/core/search/rerank/presets/decomposition.ts`
10. `src/core/contracts/payload-signals.ts`

After deletion, if `src/core/search/rerank/derived-signals/` directory is empty,
delete the directory.

**Step 1: Update all test imports**

Update all 10 test files listed above with correct import paths and renamed
symbols.

**Step 2: Delete old files**

```bash
rm src/core/search/rerank/derived-signals/similarity.ts
rm src/core/search/rerank/derived-signals/chunk-size.ts
rm src/core/search/rerank/derived-signals/chunk-density.ts
rm src/core/search/rerank/derived-signals/documentation.ts
rm src/core/search/rerank/derived-signals/imports.ts
rm src/core/search/rerank/derived-signals/path-risk.ts
rm src/core/search/rerank/derived-signals/index.ts
rm src/core/search/rerank/presets/relevance.ts
rm src/core/search/rerank/presets/decomposition.ts
rm src/core/contracts/payload-signals.ts
rmdir src/core/search/rerank/derived-signals
```

**Step 3: Run full test suite**

Run: `npx vitest run` Expected: All pass

**Step 4: Commit**

```bash
git add -A
git commit -m "refactor(trajectory): move structural signals and presets to trajectory/static, delete old files"
```

---

### Task 6: Add tests for new components + update CLAUDE.md

**Files:**

- Create: `tests/core/trajectory/static/static-trajectory.test.ts`
- Create: `tests/core/trajectory/static/provider.test.ts`
- Create: `tests/core/trajectory/static/filters.test.ts`
- Modify: `.claude/CLAUDE.md`

**Step 1: StaticTrajectory test**

```typescript
import { describe, expect, it } from "vitest";

import { StaticTrajectory } from "../../../../src/core/trajectory/static/index.js";

describe("StaticTrajectory", () => {
  const trajectory = new StaticTrajectory();

  it("has key 'static'", () => {
    expect(trajectory.key).toBe("static");
  });

  it("has no enrichment provider", () => {
    expect(trajectory.enrichment).toBeUndefined();
  });

  it("has payload signals including base fields", () => {
    const keys = trajectory.payloadSignals.map((s) => s.key);
    expect(keys).toContain("relativePath");
    expect(keys).toContain("language");
    expect(keys).toContain("methodLines");
    expect(keys).toContain("methodDensity");
    expect(keys).toContain("contentSize");
  });

  it("has 6 derived signals", () => {
    expect(trajectory.derivedSignals).toHaveLength(6);
    const names = trajectory.derivedSignals.map((d) => d.name);
    expect(names).toContain("similarity");
    expect(names).toContain("chunkSize");
    expect(names).toContain("chunkDensity");
  });

  it("has 2 presets", () => {
    expect(trajectory.presets).toHaveLength(2);
    expect(trajectory.presets.map((p) => p.name)).toContain("relevance");
    expect(trajectory.presets.map((p) => p.name)).toContain("decomposition");
  });

  it("has 4 static filters", () => {
    expect(trajectory.filters).toHaveLength(4);
    expect(trajectory.filters.map((f) => f.param)).toEqual(
      expect.arrayContaining([
        "language",
        "fileExtension",
        "chunkType",
        "isDocumentation",
      ]),
    );
  });
});
```

**Step 2: StaticPayloadBuilder test**

```typescript
import { describe, expect, it } from "vitest";

import { StaticPayloadBuilder } from "../../../../src/core/trajectory/static/provider.js";
import type { CodeChunk } from "../../../../src/core/types.js";

describe("StaticPayloadBuilder", () => {
  const chunk: CodeChunk = {
    content: "function hello() { return 1; }",
    startLine: 10,
    endLine: 20,
    metadata: {
      filePath: "/project/src/hello.ts",
      language: "typescript",
      chunkIndex: 0,
      chunkType: "function",
      name: "hello",
      symbolId: "hello",
      methodLines: 10,
    },
  };

  it("builds payload with all base fields", () => {
    const payload = StaticPayloadBuilder.buildPayload(chunk, "/project");
    expect(payload.content).toBe(chunk.content);
    expect(payload.contentSize).toBe(chunk.content.length);
    expect(payload.relativePath).toBe("src/hello.ts");
    expect(payload.startLine).toBe(10);
    expect(payload.endLine).toBe(20);
    expect(payload.language).toBe("typescript");
    expect(payload.chunkType).toBe("function");
    expect(payload.name).toBe("hello");
    expect(payload.symbolId).toBe("hello");
  });

  it("computes methodDensity from content and methodLines", () => {
    const payload = StaticPayloadBuilder.buildPayload(chunk, "/project");
    expect(payload.methodLines).toBe(10);
    expect(payload.methodDensity).toBe(Math.round(chunk.content.length / 10));
  });

  it("omits optional fields when not present", () => {
    const minimal: CodeChunk = {
      content: "x",
      startLine: 1,
      endLine: 1,
      metadata: {
        filePath: "/project/a.ts",
        language: "typescript",
        chunkIndex: 0,
      },
    };
    const payload = StaticPayloadBuilder.buildPayload(minimal, "/project");
    expect(payload.name).toBeUndefined();
    expect(payload.methodLines).toBeUndefined();
    expect(payload.methodDensity).toBeUndefined();
  });
});
```

**Step 3: Static filters test**

```typescript
import { describe, expect, it } from "vitest";

import { staticFilters } from "../../../../src/core/trajectory/static/filters.js";

describe("staticFilters", () => {
  it("has 4 filters", () => {
    expect(staticFilters).toHaveLength(4);
  });

  it("language filter produces correct condition", () => {
    const f = staticFilters.find((f) => f.param === "language")!;
    const conditions = f.toCondition("typescript");
    expect(conditions).toEqual([
      { key: "language", match: { value: "typescript" } },
    ]);
  });

  it("chunkType filter produces correct condition", () => {
    const f = staticFilters.find((f) => f.param === "chunkType")!;
    const conditions = f.toCondition("function");
    expect(conditions).toEqual([
      { key: "chunkType", match: { value: "function" } },
    ]);
  });

  it("isDocumentation filter produces correct condition", () => {
    const f = staticFilters.find((f) => f.param === "isDocumentation")!;
    const conditions = f.toCondition(true);
    expect(conditions).toEqual([
      { key: "isDocumentation", match: { value: true } },
    ]);
  });
});
```

**Step 4: Update CLAUDE.md**

Update `.claude/CLAUDE.md` Project Structure section. Replace the `search/` and
`contracts/` entries and add `trajectory/static/`:

In the `search/` section, remove `derived-signals/` and update presets:

```
  search/                              # Domain module: query-time reranking
    reranker.ts                        # Reranker: scoring, overlay mask, adaptive bounds
    rerank/
      presets/
        index.ts                       # resolvePresets() + getPresetNames/Weights (engine utility)
    search-module.ts                   # Search orchestration
```

Add `trajectory/static/` section:

```
  trajectory/                          # Domain module: provider implementations
    static/
      index.ts                         # StaticTrajectory: base signals, structural derived, generic presets
      provider.ts                      # StaticPayloadBuilder.buildPayload(chunk, codebasePath)
      payload-signals.ts               # BASE_PAYLOAD_SIGNALS (base Qdrant fields)
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
      ...                              # (unchanged)
```

In `contracts/` section, remove `payload-signals.ts` reference.

**Step 5: Run full tests**

Run: `npx vitest run` Expected: All pass

**Step 6: Commit**

```bash
git add tests/core/trajectory/static/ .claude/CLAUDE.md
git commit -m "test(trajectory/static): add tests, update CLAUDE.md with new boundaries"
```

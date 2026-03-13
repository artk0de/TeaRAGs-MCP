---
name: add-rerank-preset
description: Add a new rerank preset to a trajectory provider
---

# Add Rerank Preset

Add a new rerank preset that defines scoring weights for search result ranking.

## Step 1: Choose trajectory

- **Git trajectory** (`traj-git-presets`): presets using git-derived signals
  (techDebt, hotspots, codeReview, etc.)
- **Static trajectory** (`domains/trajectory/static/rerank/presets/`): presets
  using structural signals (relevance, decomposition)
- **Explore domain** (`explore-presets`): composite presets that combine signals
  from multiple trajectories

## Step 2: Create the preset file

Create `<preset-name>.ts` in the appropriate presets directory.

**Template:**

```typescript
import type { ScoringWeights } from "../../../../../contracts/types/provider.js";
import type {
  OverlayMask,
  RerankPreset,
} from "../../../../../contracts/types/reranker.js";

export class MyPreset implements RerankPreset {
  readonly name = "myPreset";
  readonly description = "What this preset optimizes for";
  readonly tools = ["semantic_search", "hybrid_search", "rank_chunks"];
  readonly weights: ScoringWeights = {
    similarity: 0.3,
    // Add derived signal names as keys, weights as values
  };
  readonly overlayMask: OverlayMask = {
    derived: ["signalA", "signalB"],
    file: ["rawField1", "rawField2"],
  };
}
```

## Step 3: Key design decisions

- **`name`**: lowercase camelCase, unique across all presets
- **`tools`**: which MCP tools support this preset. Usually all three, but
  `rank_chunks` only makes sense if the preset doesn't rely on `similarity`
- **`weights`**: keys must match `DerivedSignalDescriptor.name` values. Negative
  weights penalize (e.g., `blockPenalty: -0.05`). Weights don't need to sum to 1
  — they're relative.
- **`overlayMask`**: curates which signals appear in ranking overlay results.
  `derived` = derived signal names, `file`/`chunk` = raw payload field names.
- **`groupBy`**: optional, for `rank_chunks` only. Groups results by a payload
  field (e.g., `"parentName"` to group by class).

## Step 4: Register in barrel

Edit `index.ts` in the same directory:

1. Import: `import { MyPreset } from "./my-preset.js";`
2. Export: `export { MyPreset } from "./my-preset.js";`
3. Add instance to the array:
   - Git: `GIT_PRESETS`
   - Static: `STATIC_PRESETS`

No other registration needed — `TrajectoryRegistry.getAllPresets()` collects
presets automatically. `SchemaBuilder` generates the enum for MCP tools.

## Step 5: Update documentation

Update these locations with the new preset:

- `CLAUDE.md` global → tea-rags section → rerank presets tables
- Project `CLAUDE.md` if it changes available rerank options

## Step 6: Write tests

Create `tests/core/domains/trajectory/{domain}/rerank/presets/<name>.test.ts` or
add to the existing presets test file.

Minimal test:

```typescript
import { MyPreset } from "<path>";
import { describe, expect, it } from "vitest";

describe("MyPreset", () => {
  const preset = new MyPreset();

  it("has valid structure", () => {
    expect(preset.name).toBe("myPreset");
    expect(preset.tools).toContain("semantic_search");
    expect(Object.keys(preset.weights).length).toBeGreaterThan(0);
  });

  it("overlay mask references valid signals", () => {
    for (const key of Object.keys(preset.weights)) {
      // weights should only reference known derived signal names
      expect(typeof preset.weights[key]).toBe("number");
    }
  });
});
```

## Step 7: Verify

```bash
npx tsc --noEmit
npx vitest run tests/core/domains/trajectory/
```

## Registration chain (automatic)

```
Preset class → barrel index.ts → {DOMAIN}_PRESETS array
  → Trajectory.presets → TrajectoryRegistry.getAllPresets()
  → createComposition() → Reranker(resolvedPresets)
  → SchemaBuilder.buildPresetSchema(tool) → MCP tool enum
```

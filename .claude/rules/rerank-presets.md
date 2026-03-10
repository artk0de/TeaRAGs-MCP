---
paths:
  - "src/core/trajectory/**/rerank/presets/**/*.ts"
  - "src/core/explore/rerank/presets/**/*.ts"
---

# Rerank Preset Rules

Applies to all trajectory providers — not just git. Any provider can define presets following these rules.

## Preset Structure

Each preset is a class implementing `RerankPreset`:

```typescript
export class MyPreset implements RerankPreset {
  readonly name = "myPreset";                    // kebab or camelCase
  readonly description = "What this preset does"; // human-readable
  readonly tools = ["semantic_search"];           // which MCP tools support this preset
  readonly weights: ScoringWeights = { ... };    // signal name → weight (-1 to 1)
  readonly overlayMask: OverlayMask = { ... };   // raw signals to expose in ranking overlay
}
```

## Orientation Categories

Every preset has a primary orientation that determines which signal types dominate:

| Orientation | When to use | Signal mix |
|-------------|-------------|------------|
| **File-level** | Analyzing file properties (age, ownership, tech debt) | File-only + blended signals |
| **Chunk-primary** | Finding specific code areas (hotspots, review targets) | Chunk-primary + blended signals |
| **Structural** | Non-git analysis (imports, documentation) | Structural signals only |

### File-level presets
Focus on file-wide characteristics. Blended signals are OK (file dominates via alpha).

### Chunk-primary presets
Need at least 2-3 chunk-primary signals for meaningful chunk-level discrimination. Include `blockPenalty` (negative weight) to penalize chunks without enrichment data.

## Weights Rules

1. **Weights MUST sum to ~1.0** (absolute values, accounting for negative penalties)
2. **`similarity` always present** — minimum 0.20 for relevance
3. **`blockPenalty`** — negative weight (-0.05 to -0.15) in chunk-primary presets to penalize block chunks without git data
4. **No signal weight > 0.50** — prevents single-signal dominance
5. **Weight names = derived signal names** — must match `DerivedSignalDescriptor.name` exactly

### Signal type reference

Weight keys must match `DerivedSignalDescriptor.name`. Signals fall into three categories:

| Type | Behavior | When to use |
|------|----------|-------------|
| **Structural** | From payload structure, no provider data | Relevance, documentation, chunk size |
| **Blended** | Alpha-blended file+chunk | General-purpose signals (age, churn, stability) |
| **File-only** | Only file-level data | Authorship, ownership (no chunk equivalent) |
| **Chunk-primary** | Chunk value × alpha dampener | Per-chunk discrimination (hotspots, code review) |

Check `derived-signals/index.ts` in the relevant trajectory provider for available signal names.

## Overlay Mask Rules

`overlayMask` determines which **raw payload signals** appear in the ranking overlay for this preset. These are the actual Qdrant payload field names (without `git.` prefix).

```typescript
readonly overlayMask: OverlayMask = {
  file: ["ageDays", "commitCount", "bugFixRate"],     // from git.file.*
  chunk: ["commitCount", "churnRatio"],                // from git.chunk.*
};
```

### Rules

1. **Show signals relevant to the preset's purpose** — don't dump all signals
2. **Chunk-primary presets** MUST have `chunk:` section with relevant chunk fields
3. **File-level presets** can omit `chunk:` section
4. **Available overlay fields** = field names from the provider's file/chunk signal interfaces (without provider prefix). Check `types.ts` in the relevant trajectory provider.

## Tools Field

`tools` declares which MCP tools support this preset:

| Tool | Purpose |
|------|---------|
| `semantic_search` | Analytical queries, full metadata, complex filters |
| `search_code` | Quick semantic lookup, human-readable output |

- **Analytics presets** (techDebt, hotspots, codeReview, etc.): `["semantic_search"]`
- **General search presets** (recent, stable, relevance): `["search_code", "semantic_search"]`

## Adding a New Preset

### Checklist

1. **Create class file** in `presets/<name>.ts`
2. **Implement `RerankPreset`**: name, description, tools, weights, overlayMask
3. **Register** in `presets/index.ts` (import + export + add to `GIT_PRESETS[]`)
4. **Verify weights sum** ≈ 1.0 (absolute values)
5. **Verify all weight keys** match existing `DerivedSignalDescriptor.name`
6. **Add chunk overlay** if preset is chunk-primary
7. **Update CLAUDE.md** if preset adds to the public API (mentioned in user docs)
8. **Update SchemaBuilder** in `api/schema-builder.ts` if tools list changes
9. **Add tests**

### Template

```typescript
import type { ScoringWeights } from "contracts/types/provider.js";
import type { OverlayMask, RerankPreset } from "contracts/types/reranker.js";

export class MyPreset implements RerankPreset {
  readonly name = "myPreset";
  readonly description = "What this preset identifies or boosts";
  readonly tools = ["semantic_search"];
  readonly weights: ScoringWeights = {
    similarity: 0.30,
    // ... provider-specific derived signals
    blockPenalty: -0.10, // include for chunk-primary presets
  };
  readonly overlayMask: OverlayMask = {
    file: ["field1", "field2"],           // raw provider signal names
    chunk: ["field1", "field2"],          // include for chunk-primary
  };
}
```

## Verification

After any preset change:
```bash
npx tsc --noEmit && npx vitest run
```

Verify:
- All weight keys are valid derived signal names
- Weights sum to ~1.0
- Overlay fields match actual payload signal keys (without `git.` prefix)
- Chunk-primary presets have at least 2 chunk signals + blockPenalty

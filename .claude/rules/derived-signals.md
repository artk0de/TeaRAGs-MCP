---
paths:
  - "src/core/trajectory/**/rerank/derived-signals/**/*.ts"
  - "src/core/explore/rerank/derived-signals/**/*.ts"
---

# Derived Signal Rules

Applies to all trajectory providers — not just git. Any provider can define derived signals following these rules.

## Signal Types

| Type | How `extract()` reads data | Normalization | Alpha behavior |
|------|---------------------------|---------------|----------------|
| **File-only** | `fileField()` / `fileNum()` | Single bound from `ctx.bounds["file.<field>"]` | No alpha |
| **Blended** | `blendNormalized(field, fb, cb)` | Per-source: normalize each before blending | `alpha × normalizedChunk + (1-alpha) × normalizedFile` |
| **Chunk-primary** | `chunkNum()` × `payloadAlpha()` | Single bound from `ctx.bounds["chunk.<field>"]` | Alpha as quality dampener |

## Alpha-Blending (L3)

```
alpha = (chunk.commitCount / file.commitCount) × min(1, chunk.commitCount / MATURITY_THRESHOLD)
```

- Most chunks have alpha < 0.2 → **file-level dominates**
- Chunks with many commits → alpha → 1.0 → **chunk-level dominates**
- Low-commit chunks → maturity factor dampens alpha

**Use blending when:** Signal has both file and chunk equivalents, and chunk-level adds discrimination. Alpha handles unreliable low-commit chunk statistics automatically.

**Don't blend when:** Signal is inherently file-only (no chunk equivalent) or chunk data is meaningless.

## Sources Declaration (MANDATORY)

`sources` on `DerivedSignalDescriptor` serves TWO runtime purposes:

1. **`computeAdaptiveBounds()`** — reads ALL sources for per-query p95 normalization (per-source bounds)
2. **`buildOverlay()` for custom weights** — iterates ALL sources for raw ranking overlay

### Rules

| Signal type | sources MUST contain |
|-------------|---------------------|
| **Blended** | Both: `["file.<field>", "chunk.<field>"]` |
| **File-only** | File only: `["file.<field>"]` |
| **Chunk-primary** | Primary chunk + alpha dep: `["chunk.<field>", "file.commitCount"]` |

Each source gets its own p95 bound — `computeAdaptiveBounds()` iterates ALL sources across all descriptors.

### Examples

```typescript
// Blended — reads both levels
readonly sources = ["file.ageDays", "chunk.ageDays"];

// File-only — no chunk equivalent
readonly sources = ["file.dominantAuthorPct", "file.authors"];

// Chunk-primary — alpha depends on file.commitCount
readonly sources = ["chunk.commitCount", "file.commitCount"];
```

### Dampening ≠ Sources

Dampening (`(n/k)^2`) is declared via `dampeningSource`, NOT in `sources`:

```typescript
readonly dampeningSource = { key: "provider.file.commitCount", percentile: 25 };
```

## Confidence Dampening

Quadratic dampening for signals needing minimum sample size:

```typescript
readonly dampeningSource = PROVIDER_DAMPENING_CONFIG;
private static readonly FALLBACK_THRESHOLD = 5;

extract(rawSignals, ctx) {
  let value = /* compute signal */;
  const k = ctx?.dampeningThreshold ?? FALLBACK_THRESHOLD;
  value *= confidenceDampening(fileNum(rawSignals, "commitCount"), k);
  return value;
}
```

- `dampeningThreshold` from collection stats cache (percentile 25)
- `FALLBACK_THRESHOLD` when no collection stats available

## Adding a New Derived Signal

### Checklist

1. **Create class file** in `derived-signals/<name>.ts`
2. **Implement `DerivedSignalDescriptor`**: `name`, `description`, `sources`, `extract()`
3. **Set correct `sources`** per rules above
4. **Set `defaultBound`** if signal needs adaptive normalization (p95)
5. **Set `dampeningSource`** if signal needs confidence dampening
6. **Register** in `derived-signals/index.ts` barrel export
7. **Add to preset(s)** that should use this signal
8. **Ensure payload signals exist** — every source must have a matching `PayloadSignalDescriptor`
9. **Add tests**

### Template — Blended signal

```typescript
import type { DerivedSignalDescriptor } from "contracts/types/reranker.js";
import type { ExtractContext } from "contracts/types/trajectory.js";
import { blendNormalized } from "./helpers.js";

export class MySignal implements DerivedSignalDescriptor {
  readonly name = "mySignal";
  readonly description = "What this signal measures. L3 blends chunk+file <field>.";
  readonly sources = ["file.<field>", "chunk.<field>"];
  readonly defaultBound = 100;
  extract(rawSignals: Record<string, unknown>, ctx?: ExtractContext): number {
    const fb = ctx?.bounds?.["file.<field>"] ?? this.defaultBound;
    const cb = ctx?.bounds?.["chunk.<field>"] ?? this.defaultBound;
    return blendNormalized(rawSignals, "<field>", fb, cb);
  }
}
```

### Template — Chunk-primary signal

```typescript
import { normalize } from "contracts/signal-utils.js";
import type { DerivedSignalDescriptor } from "contracts/types/reranker.js";
import type { ExtractContext } from "contracts/types/trajectory.js";
import { chunkNum, payloadAlpha } from "./helpers.js";

export class MyChunkSignal implements DerivedSignalDescriptor {
  readonly name = "myChunkSignal";
  readonly description = "Chunk-level <field>, dampened by alpha.";
  readonly sources = ["chunk.<field>", "file.commitCount"];
  readonly defaultBound = 30;
  extract(rawSignals: Record<string, unknown>, ctx?: ExtractContext): number {
    const b = ctx?.bounds?.["chunk.<field>"] ?? this.defaultBound;
    const value = chunkNum(rawSignals, "<field>");
    const alpha = payloadAlpha(rawSignals);
    return normalize(value, b) * alpha;
  }
}
```

## Verification

After any derived signal change:
```bash
npx tsc --noEmit && npx vitest run
```

Sources + bounds consistency check:
- `blendNormalized(payload, "<field>", fb, cb)` → sources has BOTH `file.<field>` and `chunk.<field>`, extract reads both from `ctx.bounds`
- `fileNum("<field>")` with `ctx.bounds["file.<field>"]` → sources has `file.<field>`
- `chunkNum("<field>")` with `ctx.bounds["chunk.<field>"]` + `payloadAlpha()` → sources has `chunk.<field>` and `file.commitCount`
- Every `ctx.bounds["<key>"]` read in extract() must match an entry in `sources`

---
paths:
  - "src/core/domains/trajectory/**/rerank/derived-signals/**/*.ts"
---

# Derived Signal Rules

Applies all trajectory providers — not just git. Any provider defines derived
signals per these rules.

## Signal Types

| Type              | How `extract()` reads data       | Normalization                                   | Alpha behavior                                         |
| ----------------- | -------------------------------- | ----------------------------------------------- | ------------------------------------------------------ |
| **File-only**     | `fileField()` / `fileNum()`      | Single bound from `ctx.bounds["file.<field>"]`  | No alpha                                               |
| **Blended**       | `blendNormalized(field, fb, cb)` | Per-source: normalize each before blending      | `alpha × normalizedChunk + (1-alpha) × normalizedFile` |
| **Chunk-primary** | `chunkNum()` × `payloadAlpha()`  | Single bound from `ctx.bounds["chunk.<field>"]` | Alpha as quality dampener                              |

## Alpha-Blending (L3)

```
alpha = (chunk.commitCount / file.commitCount) × min(1, chunk.commitCount / MATURITY_THRESHOLD)
```

- Most chunks alpha < 0.2 → **file-level dominates**
- Chunks many commits → alpha → 1.0 → **chunk-level dominates**
- Low-commit chunks → maturity factor dampens alpha

**Use blending when:** Signal has both file and chunk equivalents, chunk-level
adds discrimination. Alpha auto-handles unreliable low-commit chunk stats.

**Don't blend when:** Signal inherently file-only (no chunk equivalent) or chunk
data meaningless.

## Sources Declaration (MANDATORY)

`sources` on `DerivedSignalDescriptor` serves TWO runtime purposes:

1. **`computeAdaptiveBounds()`** — reads ALL sources for per-query p95
   normalization (per-source bounds)
2. **`buildOverlay()` for custom weights** — iterates ALL sources for raw
   ranking overlay

### Rules

| Signal type       | sources MUST contain                                               |
| ----------------- | ------------------------------------------------------------------ |
| **Blended**       | Both: `["file.<field>", "chunk.<field>"]`                          |
| **File-only**     | File only: `["file.<field>"]`                                      |
| **Chunk-primary** | Primary chunk + alpha dep: `["chunk.<field>", "file.commitCount"]` |

Each source gets own p95 bound — `computeAdaptiveBounds()` iterates ALL sources
across all descriptors.

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

Dampening (`(n/k)^2`) is NOT declared on the derived signal at all — it is
declared on the PAYLOAD descriptor, as `stats.confidence`, and reaches the
signal through `ExtractContext`. `sources` is what routes it: the reranker walks
them to find a descriptor carrying a confidence block, so a signal whose
`sources` reach no such descriptor gets no dampening context and falls back to
its class constant. See "Confidence Dampening" below.

## Confidence Dampening

Quadratic dampening for signals needing minimum sample size. The consumer
pattern for a FILE-ONLY signal (`OwnershipSignal`, `InstabilitySignal` and
`RecentActivityConcentrationSignal` are the live ones):

```typescript
private static readonly FALLBACK_K = 5;

extract(rawSignals, ctx) {
  let value = /* compute signal */;
  const k = ctx?.dampeningThreshold ?? ctx?.confidence?.score?.threshold ?? MySignal.FALLBACK_K;
  value *= confidenceDampening(fileNum(rawSignals, ctx?.confidence?.support ?? "commitCount"), k);
  return value;
}
```

A signal that BLENDS file and chunk resolves the floor once and then two `k`s
from it — `kf` from `ctx.dampeningThreshold`, `kc` from
`ctx.dampeningThresholdChunk` — and dampens each component before the blend
(`VolatilitySignal` is the reference). Copying the single-`k` form above into a
blended signal silently gives the chunk component the file's confidence.

- `ctx.dampeningThreshold` — resolved by the reranker as
  `max(adaptive percentile, declared floor)`. Present only when a payload
  descriptor the signal's `sources` reach declares `stats.confidence`.
- `ctx.confidence.score.threshold` — that descriptor's floor, reached when
  collection stats carry no percentile for the support.
- `FALLBACK_K` — the class constant, and what a signal with NO declaration
  behind it uses on every query.

The declaration side, the scope-aware `k_f` / `k_c` split, and which descriptors
actually opt in are owned by [`signal-confidence.md`](./signal-confidence.md) —
do not restate them here. The legacy `dampeningSource` /
`PROVIDER_DAMPENING_CONFIG` / `FALLBACK_THRESHOLD` API this section used to show
is deleted; a new signal declaring it will not compile.

## JSDoc Documentation (MANDATORY)

Every derived signal class MUST have JSDoc above class declaration. Applies new
signals AND modifications to existing ones.

Required sections:

- **Purpose**: what question signal answers
- **Detects**: what code patterns it surfaces
- **Scoring**: how score computed, direction (higher = what?)
- **Used in**: which presets reference this signal
- **Compare**: how it differs from similar signals (if any)
- **Inverse**: paired signal if applicable (e.g., age ↔ recency, churn ↔
  stability)

Modifying signal behavior → update JSDoc to new semantics.

## Adding a New Derived Signal

### Checklist

1. **Create class file** in `derived-signals/<name>.ts` with JSDoc (see above)
2. **Implement `DerivedSignalDescriptor`**: `name`, `description`, `sources`,
   `extract()`
3. **Set correct `sources`** per rules above
4. **Set `defaultBound`** if signal needs adaptive normalization (p95)
5. **Declare `stats.confidence`** on the payload descriptor the signal's
   `sources` reach, if the signal needs confidence dampening — plus a
   `FALLBACK_K` on the class for when no block resolves
6. **Register** in `derived-signals/index.ts` barrel export
7. **Add to preset(s)** that should use this signal
8. **Ensure payload signals exist** — every source must have matching
   `PayloadSignalDescriptor`
9. **Add tests**

### Template — Blended signal

```typescript
import type { DerivedSignalDescriptor } from "contracts/types/reranker.js";
import type { ExtractContext } from "contracts/types/trajectory.js";

import { blendNormalized } from "./helpers.js";

export class MySignal implements DerivedSignalDescriptor {
  readonly name = "mySignal";
  readonly description =
    "What this signal measures. L3 blends chunk+file <field>.";
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
import type { DerivedSignalDescriptor } from "contracts/types/reranker.js";
import type { ExtractContext } from "contracts/types/trajectory.js";
import { normalize } from "infra/signal-utils.js";

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

- `blendNormalized(payload, "<field>", fb, cb)` → sources has BOTH
  `file.<field>` and `chunk.<field>`, extract reads both from `ctx.bounds`
- `fileNum("<field>")` with `ctx.bounds["file.<field>"]` → sources has
  `file.<field>`
- `chunkNum("<field>")` with `ctx.bounds["chunk.<field>"]` + `payloadAlpha()` →
  sources has `chunk.<field>` and `file.commitCount`
- Every `ctx.bounds["<key>"]` read in extract() must match an entry in `sources`

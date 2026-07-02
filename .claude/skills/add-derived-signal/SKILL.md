---
name: add-derived-signal
description:
  Define new normalized 0-1 ranking signal computed from raw payload fields at
  rerank time, registered under trajectory provider (git or static). Triggers on
  "add freshness signal", "new churn metric", "score code by ownership", "новый
  сигнал для git churn". NOT for adding rerank preset combining existing signals
  — use add-rerank-preset for that.
---

# Add Derived Signal

Add new normalized (0-1) signal computed from raw payload at rerank time.

## Step 1: Choose trajectory

- **Git trajectory** (`traj-git-signals`): signals from git history (age, churn,
  ownership, etc.). Use `helpers.ts` for payload access + alpha-blending.
- **Static trajectory** (`domains/trajectory/static/rerank/derived-signals/`):
  signals from code structure (chunk size, imports, documentation). Use
  `normalize()` from `infra/signal-utils.ts`.

## Step 2: Create the signal file (with JSDoc)

Every derived signal class MUST have JSDoc above class declaration covering:

- **Purpose**: what question this signal answers
- **Detects**: what code patterns it surfaces
- **Scoring**: how score computed, direction (higher = what?)
- **Used in**: which presets reference this signal
- **Compare**: how it differs from similar signals (if any)
- **Inverse**: paired signal if applicable (e.g., age ↔ recency)

See existing signals for reference style. Applies to new signals AND
modifications (update comment if behavior changes).

Create `<signal-name>.ts` in appropriate derived-signals directory.

**Git signal template:**

```typescript
import type { DerivedSignalDescriptor } from "../../../../../contracts/types/reranker.js";
import type { ExtractContext } from "../../../../../contracts/types/trajectory.js";
import { blendNormalized } from "./helpers.js";

export class MySignal implements DerivedSignalDescriptor {
  readonly name = "mySignal";
  readonly description = "What this signal measures";
  readonly sources = ["file.fieldName", "chunk.fieldName"];
  readonly defaultBound = 100;

  extract(rawSignals: Record<string, unknown>, ctx?: ExtractContext): number {
    const fb = ctx?.bounds?.["file.fieldName"] ?? this.defaultBound;
    const cb = ctx?.bounds?.["chunk.fieldName"] ?? this.defaultBound;
    return blendNormalized(rawSignals, "fieldName", fb, cb);
  }
}
```

**Static signal template:**

```typescript
import type { DerivedSignalDescriptor } from "../../../../../contracts/types/reranker.js";
import type { ExtractContext } from "../../../../../contracts/types/trajectory.js";
import { normalize } from "../../../../../infra/signal-utils.js";

export class MySignal implements DerivedSignalDescriptor {
  readonly name = "mySignal";
  readonly description = "What this signal measures";
  readonly sources = ["payloadField"];
  readonly defaultBound = 500;

  extract(rawSignals: Record<string, unknown>, ctx?: ExtractContext): number {
    const value = (rawSignals.payloadField as number) || 0;
    if (value <= 0) return 0;
    const bound = ctx?.bounds?.["payloadField"] ?? this.defaultBound;
    return normalize(value, bound);
  }
}
```

## Step 3: Key design decisions

- **`inverted`**: set `readonly inverted = true` if higher raw value = lower
  score (e.g., age: older code scores lower for recency)
- **`dampeningSource`**: set to `GIT_FILE_DAMPENING` (from `../constants.js`) if
  signal unreliable with few commits. Applies quadratic dampening `(n/k)^2`.
- **`defaultBound`**: reasonable upper bound for normalization. Adaptive bounds
  (p95) override this at query time.

## Step 4: Register in barrel

Edit `index.ts` in same directory:

1. Add export: `export { MySignal } from "./my-signal.js";`
2. Add instance to array:
   - Git: `gitDerivedSignals` array
   - Static: `staticDerivedSignals` array

No other registration — trajectory provider picks up all signals from array
automatically.

## Step 5: Update documentation

If signal user-facing (usable in custom weights), update these docs:

- `CLAUDE.md` global → tea-rags section → "Available weight keys" table
- Signal Taxonomy table in project `CLAUDE.md` if introduces new concept

## Step 6: Write tests

Create
`tests/core/domains/trajectory/{git|static}/derived-signals/<name>.test.ts`.

Test pattern:

```typescript
import { MySignal } from "<path>";
import { describe, expect, it } from "vitest";

describe("MySignal", () => {
  const signal = new MySignal();

  it("returns 0 for missing data", () => {
    expect(signal.extract({})).toBe(0);
  });

  it("normalizes within bounds", () => {
    const result = signal.extract(
      { payloadField: 50 },
      { bounds: { payloadField: 100 } },
    );
    expect(result).toBeCloseTo(0.5);
  });

  it("clamps at 1.0", () => {
    const result = signal.extract(
      { payloadField: 999 },
      { bounds: { payloadField: 100 } },
    );
    expect(result).toBe(1);
  });
});
```

## Step 7: Verify

```bash
npx tsc --noEmit
npx vitest run tests/core/domains/trajectory/
```

## Helper reference (git signals)

| Function                                          | Purpose                                   |
| ------------------------------------------------- | ----------------------------------------- |
| `fileNum(payload, field)`                         | Read file-level numeric field (default 0) |
| `chunkNum(payload, field)`                        | Read chunk-level numeric field            |
| `blendNormalized(payload, field, fBound, cBound)` | Normalize + alpha-blend file/chunk        |
| `blendSignal(payload, field)`                     | Alpha-blend raw file/chunk value          |
| `confidenceDampening(n, k)`                       | Quadratic dampening `(n/k)^2`             |
| `payloadAlpha(payload)`                           | Compute alpha from commit counts          |
| `normalize(value, max)`                           | Clamp to [0, 1]                           |

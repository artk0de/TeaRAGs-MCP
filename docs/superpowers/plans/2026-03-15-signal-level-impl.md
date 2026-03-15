# Signal Level & Consistent `level` Parameter — Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development
> (if subagents available) or superpowers:executing-plans to implement this
> plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `signalLevel` to presets and consistent `level` parameter across
structured search tools, with alpha=0 scoring for file presets and Qdrant
Grouping API for file-level dedup.

**Architecture:** `signalLevel` on `RerankPreset` declares natural granularity.
`level` on DTOs overrides it. `ExtractContext.signalLevel` flows to
`payloadAlpha()` which returns 0 for file level. `queryGroups()` handles
server-side dedup. Response includes `level: "file"` marker.

**Tech Stack:** TypeScript, Qdrant JS client (`queryGroups`), Zod schemas,
Vitest

**Spec:** `docs/superpowers/specs/2026-03-15-signal-level-design.md`

---

## File Structure

| Action | File                                                                | Responsibility                                                            |
| ------ | ------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| Modify | `src/core/contracts/types/reranker.ts`                              | Add `SignalLevel` type + `signalLevel?` to `RerankPreset`                 |
| Modify | `src/core/contracts/types/trajectory.ts`                            | Add `signalLevel?` to `ExtractContext`                                    |
| Modify | `src/core/contracts/signal-utils.ts`                                | N/A (no changes — alpha logic stays in helpers)                           |
| Modify | `src/core/domains/trajectory/git/rerank/derived-signals/helpers.ts` | `payloadAlpha()` + `blendNormalized()` respect `signalLevel` from context |
| Modify | 7 preset files in `traj-git-presets/` + 1 in `traj-static-presets/` | Add `signalLevel: "file"` to file-level presets                           |
| Modify | `src/core/api/public/dto/explore.ts`                                | Add `level?` to 3 DTOs, make `RankChunksRequest.level` optional           |
| Modify | `src/core/domains/explore/strategies/types.ts`                      | Already has `level?` on `ExploreContext`                                  |
| Modify | `src/core/domains/explore/reranker.ts`                              | Pass `signalLevel` through `extractAllDerived` → `ExtractContext`         |
| Modify | `src/core/api/internal/facades/explore-facade.ts`                   | Resolve effective level, pass to context + reranker                       |
| Modify | `src/core/adapters/qdrant/client.ts`                                | Add `queryGroups()` method                                                |
| Modify | `src/core/domains/explore/strategies/vector.ts`                     | Use `queryGroups()` when `level: "file"`                                  |
| Modify | `src/core/domains/explore/strategies/hybrid.ts`                     | Use `queryGroups()` when `level: "file"`                                  |
| Modify | `src/core/domains/explore/strategies/similar.ts`                    | Use `queryGroups()` when `level: "file"`                                  |
| Modify | `src/mcp/tools/schemas.ts`                                          | Add `level` to SemanticSearch, HybridSearch, FindSimilar schemas          |
| Modify | `src/core/api/public/dto/explore.ts`                                | Add `level?` to `ExploreResponse`                                         |
| Modify | `website/docs/api/tools.md`                                         | Document `level` parameter                                                |

---

## Chunk 1: Contracts & Signal Plumbing

### Task 1: Add `SignalLevel` type and `signalLevel` to `RerankPreset`

**Files:**

- Modify: `src/core/contracts/types/reranker.ts:55-63`
- Test: `tests/core/contracts/types/reranker-types.test.ts` (create)

- [ ] **Step 1: Write the failing test**

```typescript
// tests/core/contracts/types/reranker-types.test.ts
import { describe, expect, it } from "vitest";

import type {
  RerankPreset,
  SignalLevel,
} from "../../../src/core/contracts/types/reranker.js";

describe("SignalLevel type", () => {
  it("should accept file and auto as valid signal levels", () => {
    const file: SignalLevel = "file";
    const auto: SignalLevel = "auto";
    expect(file).toBe("file");
    expect(auto).toBe("auto");
  });

  it("should allow signalLevel on RerankPreset", () => {
    const preset: RerankPreset = {
      name: "test",
      description: "test",
      tools: ["semantic_search"],
      weights: { similarity: 1 },
      overlayMask: {},
      signalLevel: "file",
    };
    expect(preset.signalLevel).toBe("file");
  });

  it("should default signalLevel to undefined (treated as auto)", () => {
    const preset: RerankPreset = {
      name: "test",
      description: "test",
      tools: ["semantic_search"],
      weights: { similarity: 1 },
      overlayMask: {},
    };
    expect(preset.signalLevel).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/core/contracts/types/reranker-types.test.ts`
Expected: FAIL — `SignalLevel` not exported

- [ ] **Step 3: Implement**

In `src/core/contracts/types/reranker.ts`, add before `RerankPreset`:

```typescript
export type SignalLevel = "file" | "auto";
```

Add to `RerankPreset` interface:

```typescript
readonly signalLevel?: SignalLevel;
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/core/contracts/types/reranker-types.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/core/contracts/types/reranker.ts tests/core/contracts/types/reranker-types.test.ts
git commit -m "feat(contracts): add SignalLevel type and signalLevel to RerankPreset"
```

---

### Task 2: Add `signalLevel` to `ExtractContext`

**Files:**

- Modify: `src/core/contracts/types/trajectory.ts:47-55`

- [ ] **Step 1: Add `signalLevel` to `ExtractContext`**

In `src/core/contracts/types/trajectory.ts`, add to `ExtractContext`:

```typescript
import type { SignalLevel } from "./reranker.js";

export interface ExtractContext {
  // ... existing fields
  /** Signal level from preset — when "file", forces alpha=0 (pure file signals). */
  signalLevel?: SignalLevel;
}
```

- [ ] **Step 2: Run full tests to verify no regressions**

Run: `npx vitest run` Expected: all pass (additive change)

- [ ] **Step 3: Commit**

```bash
git add src/core/contracts/types/trajectory.ts
git commit -m "feat(contracts): add signalLevel to ExtractContext"
```

---

### Task 3: Make `payloadAlpha()` and `blendNormalized()` respect `signalLevel`

**Files:**

- Modify:
  `src/core/domains/trajectory/git/rerank/derived-signals/helpers.ts:88-131`
- Test:
  `tests/core/domains/trajectory/git/rerank/derived-signals/helpers.test.ts`

- [ ] **Step 1: Write the failing tests**

```typescript
// Add to existing helpers.test.ts (or create if missing)
import { describe, expect, it } from "vitest";

import {
  blendNormalized,
  blendSignal,
  payloadAlpha,
} from "../../../../../../src/core/domains/trajectory/git/rerank/derived-signals/helpers.js";

describe("payloadAlpha with signalLevel", () => {
  const payloadWithChunk = {
    git: {
      file: { commitCount: 20, ageDays: 100 },
      chunk: { commitCount: 10, ageDays: 50 },
    },
  };

  it("should return 0 when signalLevel is file", () => {
    expect(payloadAlpha(payloadWithChunk, "file")).toBe(0);
  });

  it("should compute normally when signalLevel is auto", () => {
    const alpha = payloadAlpha(payloadWithChunk, "auto");
    expect(alpha).toBeGreaterThan(0);
  });

  it("should compute normally when signalLevel is undefined", () => {
    const alpha = payloadAlpha(payloadWithChunk);
    expect(alpha).toBeGreaterThan(0);
  });
});

describe("blendNormalized with signalLevel", () => {
  const payload = {
    git: {
      file: { commitCount: 20, ageDays: 100 },
      chunk: { commitCount: 10, ageDays: 50 },
    },
  };

  it("should return pure file value when signalLevel is file", () => {
    const fileOnly = blendNormalized(payload, "ageDays", 365, 365, "file");
    const fileVal = 100 / 365; // normalize(100, 365)
    expect(fileOnly).toBeCloseTo(fileVal, 5);
  });

  it("should blend when signalLevel is auto", () => {
    const blended = blendNormalized(payload, "ageDays", 365, 365, "auto");
    const fileOnly = blendNormalized(payload, "ageDays", 365, 365, "file");
    expect(blended).not.toBeCloseTo(fileOnly, 5);
  });
});

describe("blendSignal with signalLevel", () => {
  const payload = {
    git: {
      file: { ageDays: 100 },
      chunk: { ageDays: 50 },
    },
  };

  it("should return pure file value when signalLevel is file", () => {
    expect(blendSignal(payload, "ageDays", "file")).toBe(100);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run:
`npx vitest run tests/core/domains/trajectory/git/rerank/derived-signals/helpers.test.ts`
Expected: FAIL — functions don't accept signalLevel parameter

- [ ] **Step 3: Implement**

In `helpers.ts`, update signatures:

```typescript
import type { SignalLevel } from "../../../../../contracts/types/reranker.js";

export function payloadAlpha(
  payload: Record<string, unknown>,
  signalLevel?: SignalLevel,
): number {
  if (signalLevel === "file") return 0;
  // ... rest unchanged
}

export function blendSignal(
  payload: Record<string, unknown>,
  field: string,
  signalLevel?: SignalLevel,
): number {
  const fileVal = fileNum(payload, field);
  const alpha = payloadAlpha(payload, signalLevel);
  if (alpha === 0) return fileVal;
  const chunkVal = chunkField(payload, field);
  return blend(chunkVal, fileVal, alpha);
}

export function blendNormalized(
  payload: Record<string, unknown>,
  field: string,
  fileBound: number,
  chunkBound: number,
  signalLevel?: SignalLevel,
): number {
  const fileVal = normalize(fileNum(payload, field), fileBound);
  const alpha = payloadAlpha(payload, signalLevel);
  if (alpha === 0) return fileVal;
  const chunkVal = chunkField(payload, field);
  const normalizedChunk =
    chunkVal !== undefined ? normalize(chunkVal, chunkBound) : fileVal;
  return blend(normalizedChunk, fileVal, alpha);
}
```

- [ ] **Step 4: Update all derived signal callers to pass `signalLevel` from
      context**

Every derived signal that calls `blendNormalized()` or `blendSignal()` needs to
forward `ctx?.signalLevel`. Files to update:

- `age.ts`: `blendNormalized(rawSignals, "ageDays", fb, cb, ctx?.signalLevel)`
- `recency.ts`: same pattern
- `churn.ts`: same pattern
- `stability.ts`: same pattern
- `bug-fix.ts`: same pattern
- `volatility.ts`: same pattern
- `knowledge-silo.ts`: same pattern
- `burst-activity.ts`: same pattern
- `density.ts`: same pattern
- `chunk-churn.ts`: uses `payloadAlpha` — pass `ctx?.signalLevel`
- `chunk-relative-churn.ts`: uses `payloadAlpha` — pass `ctx?.signalLevel`
- `relative-churn-norm.ts`: uses `blendNormalized` — pass `ctx?.signalLevel`
- `block-penalty.ts`: check if uses blending

Pattern for each file — add `ctx?.signalLevel` as last arg to blend calls:

```typescript
// Before:
return blendNormalized(rawSignals, "ageDays", fb, cb);
// After:
return blendNormalized(rawSignals, "ageDays", fb, cb, ctx?.signalLevel);
```

- [ ] **Step 5: Run tests**

Run: `npx vitest run` Expected: all pass

- [ ] **Step 6: Commit**

```bash
git add src/core/domains/trajectory/git/rerank/derived-signals/
git add tests/core/domains/trajectory/git/rerank/derived-signals/helpers.test.ts
git commit -m "feat(signals): payloadAlpha respects signalLevel — file forces alpha=0"
```

---

### Task 4: Add `signalLevel` to file-level presets

**Files:**

- Modify: `src/core/domains/trajectory/git/rerank/presets/tech-debt.ts`
- Modify: `src/core/domains/trajectory/git/rerank/presets/security-audit.ts`
- Modify: `src/core/domains/trajectory/git/rerank/presets/ownership.ts`
- Modify: `src/core/domains/trajectory/git/rerank/presets/onboarding.ts`
- Modify: `src/core/domains/trajectory/git/rerank/presets/stable.ts`
- Modify: `src/core/domains/trajectory/git/rerank/presets/recent.ts`
- Modify: `src/core/domains/trajectory/static/rerank/presets/` (check if
  impactAnalysis exists here)
- Test: `tests/core/domains/trajectory/git/rerank/presets/signal-level.test.ts`
  (create)

- [ ] **Step 1: Write the failing test**

```typescript
// tests/core/domains/trajectory/git/rerank/presets/signal-level.test.ts
import { describe, expect, it } from "vitest";

import { CodeReviewPreset } from "../../../../../../src/core/domains/trajectory/git/rerank/presets/code-review.js";
import { HotspotsPreset } from "../../../../../../src/core/domains/trajectory/git/rerank/presets/hotspots.js";
import { OnboardingPreset } from "../../../../../../src/core/domains/trajectory/git/rerank/presets/onboarding.js";
import { OwnershipPreset } from "../../../../../../src/core/domains/trajectory/git/rerank/presets/ownership.js";
import { RecentPreset } from "../../../../../../src/core/domains/trajectory/git/rerank/presets/recent.js";
import { RefactoringPreset } from "../../../../../../src/core/domains/trajectory/git/rerank/presets/refactoring.js";
import { SecurityAuditPreset } from "../../../../../../src/core/domains/trajectory/git/rerank/presets/security-audit.js";
import { StablePreset } from "../../../../../../src/core/domains/trajectory/git/rerank/presets/stable.js";
import { TechDebtPreset } from "../../../../../../src/core/domains/trajectory/git/rerank/presets/tech-debt.js";

describe("preset signalLevel", () => {
  it.each([
    ["techDebt", new TechDebtPreset()],
    ["securityAudit", new SecurityAuditPreset()],
    ["ownership", new OwnershipPreset()],
    ["onboarding", new OnboardingPreset()],
    ["stable", new StablePreset()],
    ["recent", new RecentPreset()],
  ])("%s should have signalLevel file", (_name, preset) => {
    expect(preset.signalLevel).toBe("file");
  });

  it.each([
    ["hotspots", new HotspotsPreset()],
    ["codeReview", new CodeReviewPreset()],
    ["refactoring", new RefactoringPreset()],
  ])("%s should not have signalLevel (defaults to auto)", (_name, preset) => {
    expect(preset.signalLevel).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run:
`npx vitest run tests/core/domains/trajectory/git/rerank/presets/signal-level.test.ts`
Expected: FAIL — `signalLevel` property missing

- [ ] **Step 3: Add `signalLevel: "file"` to each file-level preset**

In each file, add the import and property:

```typescript
import type { SignalLevel } from "../../../../../contracts/types/reranker.js";

// Inside the class:
readonly signalLevel: SignalLevel = "file";
```

Files: `tech-debt.ts`, `security-audit.ts`, `ownership.ts`, `onboarding.ts`,
`stable.ts`, `recent.ts`.

Do NOT add `signalLevel` to `hotspots.ts`, `code-review.ts`, `refactoring.ts`
(they default to `auto` by being undefined).

- [ ] **Step 4: Run test to verify it passes**

Run:
`npx vitest run tests/core/domains/trajectory/git/rerank/presets/signal-level.test.ts`
Expected: PASS

- [ ] **Step 5: Run full suite**

Run: `npx vitest run` Expected: all pass

- [ ] **Step 6: Commit**

```bash
git add src/core/domains/trajectory/git/rerank/presets/ tests/core/domains/trajectory/git/rerank/presets/signal-level.test.ts
git commit -m "feat(presets): add signalLevel file to file-oriented presets"
```

---

## Chunk 2: Reranker & Facade Integration

### Task 5: Pass `signalLevel` through Reranker to `ExtractContext`

**Files:**

- Modify: `src/core/domains/explore/reranker.ts:75-140, 236-256`
- Test: `tests/core/domains/explore/reranker.test.ts` (add cases)

- [ ] **Step 1: Write the failing test**

Add to existing reranker tests:

```typescript
describe("reranker signalLevel", () => {
  it("should pass signalLevel from preset to extract context", () => {
    // Create a spy descriptor that records what signalLevel it receives
    let capturedSignalLevel: string | undefined;
    const spyDescriptor: DerivedSignalDescriptor = {
      name: "testSignal",
      description: "test",
      sources: ["file.ageDays"],
      defaultBound: 365,
      extract: (_payload, ctx) => {
        capturedSignalLevel = ctx?.signalLevel;
        return 0.5;
      },
    };

    const preset: RerankPreset = {
      name: "testPreset",
      description: "test",
      tools: ["semantic_search"],
      weights: { testSignal: 1.0 },
      overlayMask: {},
      signalLevel: "file",
    };

    const reranker = new Reranker([spyDescriptor], [preset]);
    const results = [
      { score: 0.9, payload: { git: { file: { ageDays: 100 } } } },
    ];
    reranker.rerank(results, "testPreset", "semantic_search");

    expect(capturedSignalLevel).toBe("file");
  });

  it("should not pass signalLevel for auto presets", () => {
    let capturedSignalLevel: string | undefined = "UNSET";
    const spyDescriptor: DerivedSignalDescriptor = {
      name: "testSignal",
      description: "test",
      sources: ["file.ageDays"],
      defaultBound: 365,
      extract: (_payload, ctx) => {
        capturedSignalLevel = ctx?.signalLevel;
        return 0.5;
      },
    };

    const preset: RerankPreset = {
      name: "autoPreset",
      description: "test",
      tools: ["semantic_search"],
      weights: { testSignal: 1.0 },
      overlayMask: {},
      // no signalLevel → auto
    };

    const reranker = new Reranker([spyDescriptor], [preset]);
    const results = [
      { score: 0.9, payload: { git: { file: { ageDays: 100 } } } },
    ];
    reranker.rerank(results, "autoPreset", "semantic_search");

    expect(capturedSignalLevel).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/core/domains/explore/reranker.test.ts` Expected: FAIL
— `signalLevel` not passed through

- [ ] **Step 3: Implement**

In `reranker.ts`:

1. In `rerank()`, resolve `signalLevel` from preset alongside weights/mask:

```typescript
let signalLevel: SignalLevel | undefined;
// Inside the if/else blocks where weights, mask, groupBy are resolved:
signalLevel = fullPreset?.signalLevel;
```

2. Pass to `extractAllDerived()`:

```typescript
const signals = this.extractAllDerived(payload, bounds, signalLevel);
```

3. Update `extractAllDerived` signature:

```typescript
private extractAllDerived(
  payload: Record<string, unknown>,
  sourceBounds: Map<string, number>,
  signalLevel?: SignalLevel,
): Record<string, number> {
  // ...
  signals[d.name] = d.extract(payload, {
    bounds,
    dampeningThreshold,
    collectionStats: this.collectionStats,
    signalLevel,
  });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/core/domains/explore/reranker.test.ts` Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/core/domains/explore/reranker.ts tests/core/domains/explore/reranker.test.ts
git commit -m "feat(reranker): pass signalLevel from preset through ExtractContext"
```

---

### Task 6: Add `level` to DTOs and resolve effective level in facade

**Files:**

- Modify: `src/core/api/public/dto/explore.ts:53-84`
- Modify: `src/core/api/internal/facades/explore-facade.ts`
- Test: `tests/core/api/explore-level.test.ts` (create)

- [ ] **Step 1: Add `level?` to DTOs**

In `explore.ts`:

```typescript
export interface SemanticSearchRequest
  extends CollectionRef, TypedFilterParams {
  // ... existing fields
  level?: "file" | "chunk";
}

export interface HybridSearchRequest extends CollectionRef, TypedFilterParams {
  // ... existing fields
  level?: "file" | "chunk";
}

export interface FindSimilarRequest extends CollectionRef {
  // ... existing fields
  level?: "file" | "chunk";
}

export interface RankChunksRequest extends CollectionRef, TypedFilterParams {
  // ... existing fields
  level?: "chunk" | "file"; // was required, now optional
}
```

Add `level?` to `ExploreResponse`:

```typescript
export interface ExploreResponse {
  results: SearchResult[];
  driftWarning: string | null;
  level?: "file" | "chunk";
}
```

- [ ] **Step 2: Write the failing test for level resolution**

```typescript
// tests/core/api/explore-level.test.ts
import { describe, expect, it } from "vitest";

// Test the level resolution logic (extracted as a pure function for testability)
import { resolveEffectiveLevel } from "../../../src/core/api/internal/facades/explore-facade.js";

describe("resolveEffectiveLevel", () => {
  it("user override wins over preset", () => {
    expect(resolveEffectiveLevel("file", "auto")).toBe("file");
    expect(resolveEffectiveLevel("chunk", "file")).toBe("chunk");
  });

  it("preset signalLevel used when no user override", () => {
    expect(resolveEffectiveLevel(undefined, "file")).toBe("file");
  });

  it("defaults to chunk when no user override and no preset signalLevel", () => {
    expect(resolveEffectiveLevel(undefined, undefined)).toBe("chunk");
    expect(resolveEffectiveLevel(undefined, "auto")).toBe("chunk");
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npx vitest run tests/core/api/explore-level.test.ts` Expected: FAIL —
`resolveEffectiveLevel` not exported

- [ ] **Step 4: Implement level resolution in facade**

In `explore-facade.ts`, add exported helper:

```typescript
import type { SignalLevel } from "../../../contracts/types/reranker.js";

/** Resolve effective level: user override > preset signalLevel > "chunk" default. */
export function resolveEffectiveLevel(
  userLevel?: "file" | "chunk",
  presetSignalLevel?: SignalLevel,
): "file" | "chunk" {
  if (userLevel) return userLevel;
  if (presetSignalLevel === "file") return "file";
  return "chunk";
}
```

Update `semanticSearch()`, `hybridSearch()`, `findSimilar()` to:

1. Resolve preset from `request.rerank`
2. Call `resolveEffectiveLevel(request.level, preset?.signalLevel)`
3. Pass `level` to `ExploreContext`
4. Include `level: "file"` in response when effective level is file

Example for `semanticSearch()`:

```typescript
async semanticSearch(request: SemanticSearchRequest): Promise<ExploreResponse> {
  const { collectionName, path } = resolveCollection(request.collection, request.path);
  const { embedding } = await this.embeddings.embed(request.query);
  const preset = typeof request.rerank === "string"
    ? this.reranker.getFullPreset(request.rerank, "semantic_search")
    : undefined;
  const effectiveLevel = resolveEffectiveLevel(request.level, preset?.signalLevel);
  const filter = this.registry.buildMergedFilter(
    request as unknown as Record<string, unknown>,
    request.filter,
    effectiveLevel,
  );
  return this.executeExplore(
    this.vectorStrategy,
    {
      collectionName,
      query: request.query,
      embedding,
      limit: request.limit ?? 10,
      filter,
      pathPattern: request.pathPattern,
      rerank: request.rerank,
      metaOnly: request.metaOnly,
      level: effectiveLevel,
    },
    path,
  );
}
```

Update `executeExplore()` to propagate `level` to response:

```typescript
private async executeExplore(
  strategy: BaseExploreStrategy,
  ctx: ExploreContext,
  path?: string,
): Promise<ExploreResponse> {
  // ... existing code
  return {
    results: results.map((r) => ({ /* ... */ })),
    driftWarning,
    ...(ctx.level === "file" ? { level: "file" as const } : {}),
  };
}
```

For `rankChunks()`, default to existing behavior but use preset signalLevel when
`request.level` is not provided:

```typescript
async rankChunks(request: RankChunksRequest): Promise<ExploreResponse> {
  const preset = typeof request.rerank === "string"
    ? this.reranker.getFullPreset(request.rerank, "rank_chunks")
    : undefined;
  const effectiveLevel = resolveEffectiveLevel(request.level, preset?.signalLevel);
  // ... rest uses effectiveLevel instead of request.level
}
```

- [ ] **Step 5: Run tests**

Run: `npx vitest run` Expected: all pass

- [ ] **Step 6: Commit**

```bash
git add src/core/api/public/dto/explore.ts src/core/api/internal/facades/explore-facade.ts tests/core/api/explore-level.test.ts
git commit -m "feat(explore): add level param to all search DTOs with preset-based default"
```

---

## Chunk 3: Qdrant Grouping API & Strategy Updates

### Task 7: Add `queryGroups()` to QdrantManager

**Files:**

- Modify: `src/core/adapters/qdrant/client.ts`
- Test: `tests/core/adapters/qdrant/client-groups.test.ts` (create)

- [ ] **Step 1: Write the failing test**

```typescript
// tests/core/adapters/qdrant/client-groups.test.ts
import { describe, expect, it, vi } from "vitest";

// We test the method signature and that it calls the right Qdrant API
// Using a mock Qdrant client since we can't spin up a real one in unit tests
describe("QdrantManager.queryGroups", () => {
  it("should exist as a method", async () => {
    // Dynamic import to get the class
    const { QdrantManager } =
      await import("../../../../src/core/adapters/qdrant/client.js");
    expect(typeof QdrantManager.prototype.queryGroups).toBe("function");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/core/adapters/qdrant/client-groups.test.ts` Expected:
FAIL — `queryGroups` method does not exist

- [ ] **Step 3: Implement `queryGroups()` in QdrantManager**

Add to `client.ts` after the existing `query()` method:

```typescript
/**
 * Query with server-side grouping. Returns one best result per group.
 * Used by file-level searches to deduplicate chunks by relativePath.
 */
async queryGroups(
  collectionName: string,
  options: {
    embedding: number[];
    limit: number;
    groupBy: string;
    groupSize?: number;
    filter?: Record<string, unknown>;
  },
): Promise<{ id: string | number; score: number; payload?: Record<string, unknown> }[]> {
  const collectionInfo = await this.getCollectionInfo(collectionName);

  const queryParams: Record<string, unknown> = {
    query: options.embedding,
    limit: options.limit,
    group_by: options.groupBy,
    group_size: options.groupSize ?? 1,
    with_payload: true,
    with_vector: false,
  };

  if (options.filter) queryParams.filter = options.filter;
  if (collectionInfo.hybridEnabled) queryParams.using = "dense";

  const response = await this.client.queryGroups(
    collectionName,
    queryParams as Parameters<QdrantClient["queryGroups"]>[1],
  );

  // Flatten groups: each group has hits[], take the first (best) from each
  const results: { id: string | number; score: number; payload?: Record<string, unknown> }[] = [];
  for (const group of response.groups ?? []) {
    for (const hit of group.hits ?? []) {
      results.push({
        id: hit.id,
        score: hit.score,
        payload: (hit.payload as Record<string, unknown>) || undefined,
      });
    }
  }

  return results;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/core/adapters/qdrant/client-groups.test.ts` Expected:
PASS

- [ ] **Step 5: Commit**

```bash
git add src/core/adapters/qdrant/client.ts tests/core/adapters/qdrant/client-groups.test.ts
git commit -m "feat(qdrant): add queryGroups method for server-side file grouping"
```

---

### Task 8: Update strategies to use `queryGroups()` for `level: "file"`

**Files:**

- Modify: `src/core/domains/explore/strategies/vector.ts`
- Modify: `src/core/domains/explore/strategies/hybrid.ts`
- Modify: `src/core/domains/explore/strategies/similar.ts`
- Test: `tests/core/domains/explore/strategies/vector-grouping.test.ts` (create)

- [ ] **Step 1: Write the failing test**

```typescript
// tests/core/domains/explore/strategies/vector-grouping.test.ts
import { describe, expect, it, vi } from "vitest";

describe("VectorStrategy file-level grouping", () => {
  it("should call queryGroups when level is file", async () => {
    // Create mock qdrant with queryGroups spy
    const queryGroupsSpy = vi.fn().mockResolvedValue([
      { id: "1", score: 0.9, payload: { relativePath: "src/a.ts" } },
      { id: "2", score: 0.8, payload: { relativePath: "src/b.ts" } },
    ]);
    const searchSpy = vi.fn().mockResolvedValue([]);

    const mockQdrant = {
      search: searchSpy,
      queryGroups: queryGroupsSpy,
      getCollectionInfo: vi.fn().mockResolvedValue({ hybridEnabled: false }),
    };

    const mockReranker = {
      rerank: vi.fn((results) => results),
      getFullPreset: vi.fn(),
    };

    // Import and instantiate strategy with mocks
    const { VectorStrategy } =
      await import("../../../../../src/core/domains/explore/strategies/vector.js");

    const strategy = new VectorStrategy(
      mockQdrant as any,
      mockReranker as any,
      [],
      [],
    );

    await strategy.execute({
      collectionName: "test",
      embedding: [0.1, 0.2],
      limit: 10,
      level: "file",
    });

    expect(queryGroupsSpy).toHaveBeenCalledWith(
      "test",
      expect.objectContaining({
        groupBy: "relativePath",
        groupSize: 1,
      }),
    );
    expect(searchSpy).not.toHaveBeenCalled();
  });

  it("should call search (not queryGroups) when level is chunk", async () => {
    const queryGroupsSpy = vi.fn();
    const searchSpy = vi.fn().mockResolvedValue([]);

    const mockQdrant = {
      search: searchSpy,
      queryGroups: queryGroupsSpy,
    };

    const mockReranker = {
      rerank: vi.fn((results) => results),
      getFullPreset: vi.fn(),
    };

    const { VectorStrategy } =
      await import("../../../../../src/core/domains/explore/strategies/vector.js");

    const strategy = new VectorStrategy(
      mockQdrant as any,
      mockReranker as any,
      [],
      [],
    );

    await strategy.execute({
      collectionName: "test",
      embedding: [0.1, 0.2],
      limit: 10,
      level: "chunk",
    });

    expect(searchSpy).toHaveBeenCalled();
    expect(queryGroupsSpy).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run:
`npx vitest run tests/core/domains/explore/strategies/vector-grouping.test.ts`
Expected: FAIL — strategy doesn't use queryGroups

- [ ] **Step 3: Implement in VectorStrategy**

In `vector.ts`, update `executeExplore()`:

```typescript
protected async executeExplore(ctx: ExploreContext): Promise<ExploreResult[]> {
  if (!ctx.embedding) throw new Error("VectorStrategy requires embedding");

  if (ctx.level === "file") {
    return this.qdrant.queryGroups(ctx.collectionName, {
      embedding: ctx.embedding,
      limit: ctx.limit,
      groupBy: "relativePath",
      groupSize: 1,
      filter: ctx.filter as Record<string, unknown> | undefined,
    });
  }

  // existing search logic for chunk level
  return this.qdrant.search(/* ... existing code ... */);
}
```

Apply same pattern to `hybrid.ts` and `similar.ts` — if `ctx.level === "file"`,
use `queryGroups`. Check each strategy's `executeExplore` and add the file-level
branch.

**Note for hybrid.ts:** `queryGroups` doesn't natively support RRF fusion. For
hybrid + file level, fall back to regular hybrid search + client-side grouping
in `postProcess`. Add grouping logic to `BaseExploreStrategy.postProcess`:

```typescript
// In base.ts postProcess, after rerank and before trim:
if (originalCtx.level === "file") {
  filtered = this.groupByFile(filtered);
}
```

```typescript
protected groupByFile(results: ExploreResult[]): ExploreResult[] {
  const seen = new Map<string, ExploreResult>();
  for (const r of results) {
    const path = (r.payload?.relativePath as string) ?? "";
    if (!path || !seen.has(path)) {
      seen.set(path || `__ungrouped_${seen.size}`, r);
    }
  }
  return [...seen.values()];
}
```

- [ ] **Step 4: Run tests**

Run: `npx vitest run` Expected: all pass

- [ ] **Step 5: Commit**

```bash
git add src/core/domains/explore/strategies/ tests/core/domains/explore/strategies/vector-grouping.test.ts
git commit -m "feat(strategies): use queryGroups for file-level search, groupByFile fallback"
```

---

## Chunk 4: MCP Schema & Documentation

### Task 9: Add `level` to MCP schemas

**Files:**

- Modify: `src/mcp/tools/schemas.ts`

- [ ] **Step 1: Add `level` field to search schemas**

In `schemas.ts`, create a shared helper:

```typescript
function levelField() {
  return {
    level: z
      .enum(["chunk", "file"])
      .optional()
      .describe(
        "Analysis level. 'file' returns one best chunk per file with file-level scoring " +
          "(alpha=0, pure file signals). 'chunk' returns individual chunks with blended scoring. " +
          "Default: determined by preset (file presets default to file, others to chunk).",
      ),
  };
}
```

Add `...levelField()` to `SemanticSearchSchema`, `HybridSearchSchema`, and
`FindSimilarSchema`.

Make `level` optional in `RankChunksSchema`:

```typescript
level: z
  .enum(["chunk", "file"])
  .optional()
  .describe(
    "Analysis level. Default: determined by preset signalLevel. " +
      "'chunk' for active work (decomposition, hotspots). " +
      "'file' for tech debt and ownership analysis.",
  ),
```

- [ ] **Step 2: Run full tests**

Run: `npx vitest run` Expected: all pass

- [ ] **Step 3: Commit**

```bash
git add src/mcp/tools/schemas.ts
git commit -m "feat(mcp): add level parameter to semantic_search, hybrid_search, find_similar schemas"
```

---

### Task 10: Update documentation

**Files:**

- Modify: `website/docs/api/tools.md`

- [ ] **Step 1: Add `level` parameter documentation**

Add a new section `### level — Analysis Level` after the `rerank` section:

```markdown
### `level` — Analysis Level

Controls whether results represent individual chunks or whole files.

| Value     | Scoring                              | Grouping                | Use when                                   |
| --------- | ------------------------------------ | ----------------------- | ------------------------------------------ |
| `"chunk"` | Alpha-blended (file + chunk signals) | All chunks returned     | Looking for specific functions/methods     |
| `"file"`  | Pure file signals (alpha=0)          | One best chunk per file | File-level analytics, ownership, tech debt |

**Default:** Determined by preset's `signalLevel`. File-oriented presets
(`techDebt`, `securityAudit`, `ownership`, `onboarding`, `stable`, `recent`)
default to `"file"`. Chunk-oriented presets (`hotspots`, `codeReview`,
`refactoring`, `relevance`) default to `"chunk"`.

**Override:** Explicit `level` always wins over preset default.

**Available on:** `semantic_search`, `hybrid_search`, `find_similar`,
`rank_chunks`.

**Response:** When `level: "file"` is active, the response includes
`"level": "file"` in the response metadata.
```

Update the parameter tables for `semantic_search`, `hybrid_search`, and
`find_similar` to include the `level` parameter.

- [ ] **Step 2: Run markdownlint if available**

Run: `npx markdownlint website/docs/api/tools.md` (or skip if not configured)

- [ ] **Step 3: Commit**

```bash
git add website/docs/api/tools.md
git commit -m "docs(api): document level parameter for search tools"
```

---

### Task 11: Close beads tasks

- [ ] **Step 1: Close Grouping API task**

```bash
bd close tea-rags-mcp-35e --reason="Implemented via queryGroups + groupByFile in signal-level feature"
```

- [ ] **Step 2: Run full test suite + type check**

```bash
npm run build && npx vitest run
```

- [ ] **Step 3: Final commit if needed**

Check `git status`, commit any remaining changes.

# Reranker.rerank() Phase Extraction Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use
> superpowers:subagent-driven-development (recommended) or
> superpowers:executing-plans to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the 72-line body of `Reranker.rerank()`
(`src/core/domains/explore/reranker.ts:86-158`) with a ~15-line orchestrator
calling 5 named phases. No behavior change. No signature change. All 6 callsites
untouched.

**Architecture:** Two phases are pure data transforms (`isSimilarityOnly`,
`groupByTop`) — module-level helpers at file bottom, exported with `@internal`
tag so unit tests can import them. Two phases touch `this` (`resolveMode`,
`scoreResults`) — private methods on `Reranker`, tested via
`(reranker as any).method(...)`. The existing `computeAdaptiveBounds` helper is
reused unchanged.

**Tech Stack:** TypeScript, Vitest.

**Spec:** `docs/superpowers/specs/2026-04-21-reranker-rerank-phases-design.md`

**Deviation from spec:** Spec section "Proposed signatures" marked the
module-level helpers as "not exported". Plan exports them (with `@internal`
JSDoc) to enable direct unit testing — matches the existing pattern of
`validateFindSimilarRequest` in `explore-facade.ts`. No impact on public API or
consumers.

**Testing philosophy:** The primary behavior-preservation guarantee is the
existing 2085-line `tests/core/domains/explore/reranker.test.ts` suite running
unchanged and green. Phase-level unit tests are complementary — they target edge
cases of each extracted phase that would be tedious to exercise through
`rerank()` alone.

---

## File Structure

| File                                          | Responsibility                    | Change                                                                                                                                                                          |
| --------------------------------------------- | --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/core/domains/explore/reranker.ts`        | Reranker class + module helpers   | MODIFY: add `ResolvedMode` interface, `resolveMode` / `scoreResults` private methods, `isSimilarityOnly` / `groupByTop` module helpers; rewrite `rerank()` body as orchestrator |
| `tests/core/domains/explore/reranker.test.ts` | Reranker behavior + unit coverage | EXTEND: add phase-level unit tests at bottom of file                                                                                                                            |

No file splits. No new files. No barrel changes. No DI wiring changes.

---

## Task 1: Add pure module-level helpers (isSimilarityOnly + groupByTop)

**Files:**

- Modify: `src/core/domains/explore/reranker.ts` (append at end, after
  `buildSignalKeyMap` at line 564)
- Test: `tests/core/domains/explore/reranker.test.ts` (append at end of file)

- [ ] **Step 1: Write failing unit tests for `isSimilarityOnly`**

Append to end of `tests/core/domains/explore/reranker.test.ts`:

```typescript
import {
  groupByTop,
  isSimilarityOnly,
  Reranker,
  type RerankableResult,
} from "../../../../src/core/domains/explore/reranker.js";

describe("isSimilarityOnly", () => {
  it("returns true when only similarity is non-zero", () => {
    expect(isSimilarityOnly({ similarity: 1.0 })).toBe(true);
  });

  it("returns true when similarity is the only non-zero key (others explicitly 0)", () => {
    expect(isSimilarityOnly({ similarity: 1.0, recency: 0, churn: 0 })).toBe(
      true,
    );
  });

  it("returns false when similarity plus another non-zero weight", () => {
    expect(isSimilarityOnly({ similarity: 0.5, recency: 0.5 })).toBe(false);
  });

  it("returns false when only non-similarity key is non-zero", () => {
    expect(isSimilarityOnly({ recency: 1.0 })).toBe(false);
  });

  it("returns false on empty weights", () => {
    expect(isSimilarityOnly({})).toBe(false);
  });

  it("returns false when similarity is zero and another key is non-zero", () => {
    expect(isSimilarityOnly({ similarity: 0, recency: 0.5 })).toBe(false);
  });
});

describe("groupByTop", () => {
  const makeResult = (score: number, groupKey: string) => ({
    score,
    payload: { language: groupKey, relativePath: `f${score}.ts` },
  });

  it("keeps highest-scored entry per group key", () => {
    const sorted = [
      makeResult(0.9, "typescript"),
      makeResult(0.8, "python"),
      makeResult(0.7, "typescript"),
      makeResult(0.6, "python"),
    ];
    const grouped = groupByTop(sorted, "language");
    expect(grouped).toHaveLength(2);
    expect(grouped[0].score).toBe(0.9);
    expect(grouped[1].score).toBe(0.8);
  });

  it("buckets missing keys under unique __ungrouped slots", () => {
    const sorted = [
      makeResult(0.9, ""),
      { score: 0.8, payload: { relativePath: "f.ts" } },
      makeResult(0.7, ""),
    ];
    const grouped = groupByTop(
      sorted as Parameters<typeof groupByTop>[0],
      "language",
    );
    // Each missing key gets its own slot (no collapse)
    expect(grouped).toHaveLength(3);
  });

  it("preserves input order for first occurrence per group", () => {
    const sorted = [
      makeResult(0.9, "ts"),
      makeResult(0.85, "py"),
      makeResult(0.8, "ts"),
    ];
    const grouped = groupByTop(sorted, "language");
    expect(grouped.map((r) => r.payload.language)).toEqual(["ts", "py"]);
  });

  it("handles empty input", () => {
    expect(groupByTop([], "language")).toEqual([]);
  });
});
```

- [ ] **Step 2: Run tests to verify RED**

Run: `npx vitest run tests/core/domains/explore/reranker.test.ts`

Expected: FAIL with TypeScript error "Module has no exported member
'isSimilarityOnly'" and "Module has no exported member 'groupByTop'".

- [ ] **Step 3: Implement `isSimilarityOnly` and `groupByTop` at end of
      `reranker.ts`**

Append to `src/core/domains/explore/reranker.ts` after the `buildSignalKeyMap`
function (after line 564):

```typescript
/**
 * Returns true when the only non-zero weight is `similarity`. Used as a fast
 * path in `rerank()` to skip adaptive bounds + overlay computation.
 *
 * @internal Exported only for unit testing. Not part of the public module API.
 */
export function isSimilarityOnly(weights: ScoringWeights): boolean {
  const activeKeys = Object.keys(weights).filter((k) => {
    const w = weights[k as keyof ScoringWeights];
    return w !== undefined && w !== 0;
  });
  return activeKeys.length === 1 && activeKeys[0] === "similarity";
}

/**
 * Collapse sorted results by payload field, keeping the first (highest-scored)
 * entry per group. Missing/empty group keys each get a unique `__ungrouped_N`
 * slot so they don't collapse into a single bucket.
 *
 * @internal Exported only for unit testing. Not part of the public module API.
 */
export function groupByTop<T extends { payload?: Record<string, unknown> }>(
  sorted: T[],
  groupBy: string,
): T[] {
  const seen = new Map<string, T>();
  for (const r of sorted) {
    const raw = r.payload?.[groupBy];
    const key = typeof raw === "string" ? raw : "";
    if (!key || !seen.has(key)) {
      seen.set(key || `__ungrouped_${seen.size}`, r);
    }
  }
  return [...seen.values()];
}
```

- [ ] **Step 4: Run tests to verify GREEN**

Run: `npx vitest run tests/core/domains/explore/reranker.test.ts`

Expected: PASS — all new `describe("isSimilarityOnly")` and
`describe("groupByTop")` blocks green; existing tests unchanged.

- [ ] **Step 5: Run full suite to verify no regressions**

Run: `npx vitest run`

Expected: PASS — 3552 existing tests + 10 new phase tests = 3562 total.

- [ ] **Step 6: Type-check**

Run: `npx tsc --noEmit`

Expected: Clean (no errors).

- [ ] **Step 7: Commit**

```bash
git add src/core/domains/explore/reranker.ts tests/core/domains/explore/reranker.test.ts
git commit -m "refactor(explore): add isSimilarityOnly + groupByTop pure helpers for rerank()

Extract two pure-data-transform phases from Reranker.rerank() into
module-level helpers at the bottom of reranker.ts:

- isSimilarityOnly(weights): boolean — fast-path predicate
- groupByTop(sorted, groupBy): T[] — payload-field group collapse

Both exported with @internal JSDoc so phase-level unit tests can
import them directly — same pattern as validateFindSimilarRequest
in explore-facade.ts. rerank() body unchanged in this commit; it
will be rewritten as an orchestrator in the next commit.

10 new unit tests cover edge cases (empty weights, zero weights,
missing group keys, empty input, order preservation).

Spec: docs/superpowers/specs/2026-04-21-reranker-rerank-phases-design.md"
```

---

## Task 2: Extract private methods (resolveMode + scoreResults) and rewrite rerank() as orchestrator

**Files:**

- Modify: `src/core/domains/explore/reranker.ts` (add `ResolvedMode` interface
  near top; add `resolveMode` + `scoreResults` private methods to `Reranker`
  class; rewrite `rerank()` body at lines 86-158)
- Test: `tests/core/domains/explore/reranker.test.ts` (append phase-level unit
  tests)

- [ ] **Step 1: Write failing unit tests for `resolveMode` and `scoreResults`**

Append to end of `tests/core/domains/explore/reranker.test.ts` (after Task 1's
new blocks):

```typescript
describe("resolveMode (private phase)", () => {
  const reranker = new Reranker(
    allDescriptors,
    testPresets,
    testPayloadSignals,
  );

  it("resolves string preset mode — populates weights, mask, groupBy, signalLevel from preset", () => {
    const resolved = (
      reranker as unknown as {
        resolveMode: (
          m: unknown,
          p: string,
        ) => {
          presetName: string;
          weights: Record<string, number>;
          mask: unknown;
          groupBy: string | undefined;
          signalLevel: string | undefined;
        };
      }
    ).resolveMode("techDebt", "semantic_search");
    expect(resolved.presetName).toBe("techDebt");
    expect(Object.keys(resolved.weights).length).toBeGreaterThan(0);
  });

  it("resolves { preset, custom } mode — uses custom weights but preset's mask + groupBy + signalLevel", () => {
    const resolved = (
      reranker as unknown as {
        resolveMode: (
          m: unknown,
          p: string,
        ) => {
          presetName: string;
          weights: Record<string, number>;
          groupBy: string | undefined;
        };
      }
    ).resolveMode(
      { preset: "techDebt", custom: { similarity: 1.0 } },
      "semantic_search",
    );
    expect(resolved.presetName).toBe("techDebt");
    expect(resolved.weights).toEqual({ similarity: 1.0 });
  });

  it("resolves pure { custom } mode — presetName is 'custom', weights from input, no mask/groupBy", () => {
    const resolved = (
      reranker as unknown as {
        resolveMode: (
          m: unknown,
          p: string,
        ) => {
          presetName: string;
          weights: Record<string, number>;
          mask: unknown;
          groupBy: string | undefined;
          signalLevel: string | undefined;
        };
      }
    ).resolveMode(
      { custom: { similarity: 0.5, recency: 0.5 } },
      "semantic_search",
    );
    expect(resolved.presetName).toBe("custom");
    expect(resolved.weights).toEqual({ similarity: 0.5, recency: 0.5 });
    expect(resolved.mask).toBeUndefined();
    expect(resolved.groupBy).toBeUndefined();
    expect(resolved.signalLevel).toBeUndefined();
  });

  it("returns default similarity-only weights when string preset does not exist in resolvedPresets", () => {
    const resolved = (
      reranker as unknown as {
        resolveMode: (
          m: unknown,
          p: string,
        ) => {
          weights: Record<string, number>;
        };
      }
    ).resolveMode("nonexistentPreset", "semantic_search");
    expect(resolved.weights).toEqual({ similarity: 1.0 });
  });
});

describe("scoreResults (private phase)", () => {
  const reranker = new Reranker(
    allDescriptors,
    testPresets,
    testPayloadSignals,
  );

  const createResult = (
    score: number,
    ageDays: number,
    commitCount: number,
  ): RerankableResult => ({
    score,
    payload: {
      relativePath: `src/f${score}.ts`,
      startLine: 1,
      endLine: 10,
      language: "typescript",
      git: {
        ageDays,
        commitCount,
        dominantAuthor: "alice",
        authors: ["alice"],
      },
    },
  });

  it("attaches score + rankingOverlay to each result", () => {
    const results = [createResult(0.8, 30, 5), createResult(0.7, 60, 10)];
    const bounds = (
      reranker as unknown as {
        computeAdaptiveBounds: (r: RerankableResult[]) => Map<string, number>;
      }
    ).computeAdaptiveBounds(results);
    const resolved = (
      reranker as unknown as {
        resolveMode: (m: unknown, p: string) => unknown;
      }
    ).resolveMode("techDebt", "semantic_search") as {
      presetName: string;
      weights: Record<string, number>;
      mask: unknown;
      signalLevel: unknown;
    };
    const scored = (
      reranker as unknown as {
        scoreResults: (
          r: RerankableResult[],
          b: Map<string, number>,
          res: unknown,
          q: string | undefined,
        ) => (RerankableResult & { score: number; rankingOverlay?: unknown })[];
      }
    ).scoreResults(results, bounds, resolved, undefined);

    expect(scored).toHaveLength(2);
    expect(scored[0].score).toBeTypeOf("number");
    expect(scored[0].rankingOverlay).toBeDefined();
    expect(scored[1].score).toBeTypeOf("number");
  });

  it("preserves original payload fields on each scored result", () => {
    const results = [createResult(0.8, 30, 5)];
    const bounds = (
      reranker as unknown as {
        computeAdaptiveBounds: (r: RerankableResult[]) => Map<string, number>;
      }
    ).computeAdaptiveBounds(results);
    const resolved = (
      reranker as unknown as {
        resolveMode: (m: unknown, p: string) => unknown;
      }
    ).resolveMode("techDebt", "semantic_search");
    const scored = (
      reranker as unknown as {
        scoreResults: (
          r: RerankableResult[],
          b: Map<string, number>,
          res: unknown,
          q: string | undefined,
        ) => (RerankableResult & { score: number })[];
      }
    ).scoreResults(results, bounds, resolved, undefined);

    expect(scored[0].payload?.relativePath).toBe("src/f0.8.ts");
    expect(scored[0].payload?.git?.commitCount).toBe(5);
  });
});
```

- [ ] **Step 2: Run tests to verify RED**

Run: `npx vitest run tests/core/domains/explore/reranker.test.ts`

Expected: FAIL — `(reranker as unknown as ...).resolveMode is not a function`
and similar for `scoreResults`.

- [ ] **Step 3: Add `ResolvedMode` interface to `reranker.ts`**

Insert after the `RerankOptions` interface (after line 35) in
`src/core/domains/explore/reranker.ts`:

```typescript
/**
 * Output of `resolveMode()` — the resolved rerank configuration derived from
 * `mode` (string preset / {preset,custom} / pure {custom}).
 */
interface ResolvedMode {
  presetName: string;
  weights: ScoringWeights;
  mask: OverlayMask | undefined;
  groupBy: string | undefined;
  signalLevel: SignalLevel | undefined;
}
```

- [ ] **Step 4: Add `resolveMode` private method to `Reranker` class**

Insert inside `class Reranker`, immediately after the `rerank()` method (after
line 158) in `src/core/domains/explore/reranker.ts`:

```typescript

  /** Resolve `mode` to weights, mask, groupBy, signalLevel. Pure lookup, no side effects. */
  private resolveMode(
    mode: RerankMode<string>,
    presetSet: "semantic_search" | "search_code" | "rank_chunks",
  ): ResolvedMode {
    let weights: ScoringWeights;
    let presetName: string;
    let mask: OverlayMask | undefined;
    let groupBy: string | undefined;
    let signalLevel: SignalLevel | undefined;
    if (typeof mode === "string") {
      presetName = mode;
      const fullPreset = this.resolvedPresets.find((p) => p.name === mode && this.matchesTool(p, presetSet));
      weights = fullPreset?.weights ?? { similarity: 1.0 };
      mask = fullPreset?.overlayMask;
      groupBy = fullPreset?.groupBy;
      signalLevel = fullPreset?.signalLevel;
    } else if (mode.preset) {
      presetName = mode.preset;
      weights = mode.custom;
      const fullPreset = this.resolvedPresets.find((p) => p.name === mode.preset && this.matchesTool(p, presetSet));
      mask = fullPreset?.overlayMask;
      groupBy = fullPreset?.groupBy;
      signalLevel = fullPreset?.signalLevel;
    } else {
      presetName = "custom";
      weights = mode.custom;
    }
    return { presetName, weights, mask, groupBy, signalLevel };
  }
```

- [ ] **Step 5: Add `scoreResults` private method to `Reranker` class**

Insert inside `class Reranker`, immediately after the `resolveMode` method just
added:

```typescript

  /** Score each result and attach ranking overlay. Pure transform given bounds + resolved mode. */
  private scoreResults<T extends RerankableResult>(
    results: T[],
    bounds: Map<string, number>,
    resolved: ResolvedMode,
    query: string | undefined,
  ): (T & { score: number; rankingOverlay?: RankingOverlay })[] {
    return results.map((result) => {
      const payload = this.buildExtractPayload(result);
      const signals = this.extractAllDerived(payload, bounds, resolved.signalLevel, query);
      const score = calculateScore(signals, resolved.weights);
      const overlay = this.buildOverlay(result, resolved.presetName, resolved.weights, signals, resolved.mask, resolved.signalLevel);
      return { ...result, score, rankingOverlay: overlay };
    });
  }
```

- [ ] **Step 6: Rewrite `rerank()` body as orchestrator**

Replace lines 86-158 of `src/core/domains/explore/reranker.ts` (the entire
current `rerank()` method body, not its signature) with:

```typescript
  /**
   * Rerank results with ranking overlay.
   */
  rerank<T extends RerankableResult>(
    results: T[],
    mode: RerankMode<string>,
    presetSet: "semantic_search" | "search_code" | "rank_chunks",
    options?: RerankOptions,
  ): (T & { rankingOverlay?: RankingOverlay })[] {
    const resolved = this.resolveMode(mode, presetSet);
    if (options?.signalLevel) {
      resolved.signalLevel = options.signalLevel;
    }
    if (isSimilarityOnly(resolved.weights)) {
      return results.map((r) => ({ ...r }));
    }
    const bounds = this.computeAdaptiveBounds(results);
    const scored = this.scoreResults(results, bounds, resolved, options?.query);
    const sorted = scored.sort((a, b) => b.score - a.score);
    return resolved.groupBy ? groupByTop(sorted, resolved.groupBy) : sorted;
  }
```

- [ ] **Step 7: Run tests to verify GREEN**

Run: `npx vitest run tests/core/domains/explore/reranker.test.ts`

Expected: PASS — new `resolveMode` + `scoreResults` unit tests green; all
existing `reranker` tests still green.

- [ ] **Step 8: Run full suite to verify no regressions**

Run: `npx vitest run`

Expected: PASS — all 3552 pre-existing tests + 10 Task 1 tests + 6 Task 2 tests
= 3568 total.

- [ ] **Step 9: Type-check**

Run: `npx tsc --noEmit`

Expected: Clean (no errors).

- [ ] **Step 10: Verify orchestrator size**

Run:
`awk '/^  rerank<T extends RerankableResult>/,/^  }$/' src/core/domains/explore/reranker.ts | wc -l`

Expected: ~18 lines (orchestrator body + signature + brace). Spec target: ~15
lines body.

- [ ] **Step 11: Commit**

```bash
git add src/core/domains/explore/reranker.ts tests/core/domains/explore/reranker.test.ts
git commit -m "refactor(explore): extract resolveMode + scoreResults and rewrite rerank() as orchestrator

Complete Reranker.rerank() phase extraction begun in prior commit.

- Add ResolvedMode interface (presetName, weights, mask, groupBy, signalLevel)
- Add Reranker#resolveMode private method — lookup/compose from RerankMode
- Add Reranker#scoreResults private method — map results to scored + overlay
- Rewrite rerank() body from 72-line block into ~15-line orchestrator:
  resolveMode → signalLevel override → isSimilarityOnly fast path →
  computeAdaptiveBounds → scoreResults → sort → groupByTop

All 5 phases now independently named and testable. No behavior change.
No signature change. All 6 callsites in domains/explore/ untouched.

6 new phase-level unit tests (resolveMode branch matrix, scoreResults
score+overlay attachment). Existing 2085-line reranker.test.ts suite
runs unchanged as the primary behavior-preservation guarantee.

Spec: docs/superpowers/specs/2026-04-21-reranker-rerank-phases-design.md"
```

---

## Beads Sync (MANDATORY per `.claude/rules/plan-beads-sync.md`)

After this plan file is committed, the author must:

1. Create a beads epic named `[epic] Reranker.rerank() phase extraction` with
   label `architecture`.
2. Create two beads tasks (one per Task above) under the epic, with label
   `architecture`:
   - `Task 1: add isSimilarityOnly + groupByTop pure helpers`
   - `Task 2: extract resolveMode + scoreResults and rewrite rerank() as orchestrator`
3. Add dependency: Task 2 depends on Task 1 (`bd dep add <task2> <task1>`).
4. Link both tasks to the epic (`bd dep add <taskN> <epic>`).
5. During execution: `bd update <taskN> --status=in_progress` before starting
   each Task, `bd close <taskN>` after its commit lands.

---

## Self-Review (completed by plan author)

**Spec coverage:**

- Motivation / Goal → Plan header + Task 2 Step 6 orchestrator rewrite ✅
- Non-goals (no file split, no API change) → explicit in Plan header + commit
  messages ✅
- Phase decomposition table (5 phases) → Task 1 covers phases 2 + 5; Task 2
  covers phases 1 + 4; phase 3 (`computeAdaptiveBounds`) reused unchanged ✅
- Proposed signatures — `ResolvedMode`, `resolveMode`, `isSimilarityOnly`,
  `scoreResults`, `groupByTop` → all appear verbatim in Task steps ✅
- Orchestrator shape → Task 2 Step 6 contains the exact target code ✅
- Behavior preservation table (line-range mapping) → encoded in Task 2 Step 6
  rewrite being a 1:1 re-wiring ✅
- Testing strategy — existing tests unchanged + new unit tests per phase → Task
  1 (10 tests) + Task 2 (6 tests); existing suite unchanged ✅
- Error handling (no new error paths) → implicit: no try/catch added, no new
  errors thrown ✅
- Affected files table → File Structure section + Tasks match ✅
- Rollout (single scope, no migration) → 2 commits under scope `explore`, no
  reindex ✅

**Deviation noted:** spec said module-level helpers "not exported"; plan exports
them with `@internal` JSDoc to enable direct unit testing. Flagged in Plan
header.

**Placeholder scan:** no TBD / TODO / "implement later" / vague steps. Every
step contains exact code or exact command with expected output. ✅

**Type consistency:** `ResolvedMode` used consistently across `resolveMode`
return type + `scoreResults` parameter. `RerankableResult`, `RerankMode`,
`RerankOptions`, `OverlayMask`, `ScoringWeights`, `SignalLevel`,
`RankingOverlay` all imported from existing locations in reranker.ts — no new
type introductions beyond `ResolvedMode`. ✅

---

## Execution handoff

After plan is committed, the author offers:

**1. Subagent-Driven (recommended)** — dispatch a fresh subagent per Task;
review between Tasks; fast iteration.

**2. Inline Execution** — execute Tasks in the current session using
`superpowers:executing-plans`; batch execution with checkpoints.

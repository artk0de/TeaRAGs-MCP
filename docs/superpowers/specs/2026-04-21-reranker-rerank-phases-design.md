# Reranker.rerank() Phase Extraction — Design

## Motivation

`Reranker.rerank()` at `src/core/domains/explore/reranker.ts:86-158` is a
72-line god method in the hot path of every search. It contains five distinct
phases compressed into one body:

1. Resolve preset / weights / overlay mask / groupBy / signalLevel from `mode`
2. Short-circuit on similarity-only weights
3. Compute adaptive bounds (already a separate helper — just called)
4. Score each result + attach ranking overlay
5. Group by payload field, keeping top score per group

Churn signals: `churnVolatility=3.33`, 10 file commits, 2 extreme-commitCount
chunks. Method is the entry point reused by all search strategies (6 call sites
in `domains/explore/`). Changes to scoring logic currently require reading and
editing a large block where phases are interleaved with control flow.

The risk is cosmetic drift: short methods that each do one thing are easier to
test, profile, and modify than one long method with five purposes.

## Goal

Replace the 72-line `rerank()` body with a ~15-line orchestrator that names each
phase. Each phase becomes independently readable and testable. No behavior
change. No signature change. All existing tests pass.

## Non-goals

- **No file split.** `reranker.ts` at 564 lines is a coordinator class with
  cohesive responsibilities. Splitting it without a structural signal is
  premature.
- **No public API change.** `rerank(results, mode, presetSet, options)` keeps
  its exact signature and behavior. All 6 call sites remain untouched.
- **No changes to `computeAdaptiveBounds`, `extractAllDerived`,
  `buildExtractPayload`, `buildOverlay`.** These helpers already exist and are
  already extracted; the orchestrator just calls them.
- **No performance work.** Pure refactor. Micro-benchmarks are not part of this
  change.

## Phase decomposition

The five phases split by how they touch `this`:

| Phase                             | Shape                                                                              | Where                              |
| --------------------------------- | ---------------------------------------------------------------------------------- | ---------------------------------- |
| 1. Resolve mode → resolved state  | method (`this.resolvedPresets`)                                                    | private method on `Reranker`       |
| 2. Similarity-only short-circuit  | pure predicate (`weights` → `boolean`)                                             | module-level helper at file bottom |
| 3. Adaptive bounds                | already a method — just called                                                     | (unchanged)                        |
| 4. Score results + attach overlay | method (`this.extractAllDerived`, `this.buildExtractPayload`, `this.buildOverlay`) | private method on `Reranker`       |
| 5. Group-by-top                   | pure transform (`sorted[]`, `groupByKey` → filtered `[]`)                          | module-level helper at file bottom |

Rationale: phases 1 and 4 read from `this` (preset lookup and signal
extraction). Keeping them as private methods avoids threading 3-5 fields through
function parameters. Phases 2 and 5 are stateless data transforms — pure
functions are simpler and don't need class binding.

This mirrors the existing project pattern: pure validators at the bottom of the
facade file (`validateFindSimilarRequest` in `explore-facade.ts`), class members
for work that touches instance state.

## Proposed signatures

Internal types (defined once, used by orchestrator + phases):

```typescript
interface ResolvedMode {
  presetName: string;
  weights: ScoringWeights;
  mask: OverlayMask | undefined;
  groupBy: string | undefined;
  signalLevel: SignalLevel | undefined;
}
```

Private method on `Reranker`:

```typescript
private resolveMode(
  mode: RerankMode<string>,
  presetSet: "semantic_search" | "search_code" | "rank_chunks",
): ResolvedMode;
```

Module-level helper (pure, not exported — internal to file):

```typescript
function isSimilarityOnly(weights: ScoringWeights): boolean;
```

Private method on `Reranker`:

```typescript
private scoreResults<T extends RerankableResult>(
  results: T[],
  bounds: Map<string, number>,
  resolved: ResolvedMode,
  query: string | undefined,
): (T & { score: number; rankingOverlay?: RankingOverlay })[];
```

Module-level helper (pure):

```typescript
function groupByTop<T extends { payload?: Record<string, unknown> }>(
  sorted: T[],
  groupBy: string,
): T[];
```

## Orchestrator shape

```typescript
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

Target: ~15 lines. Every phase visibly named. No inline control flow beyond
orchestration.

## Behavior preservation

The orchestrator is an exact re-wiring of the current body:

| Current line range | Current behavior                                                                  | New mapping                            |
| ------------------ | --------------------------------------------------------------------------------- | -------------------------------------- |
| 92-116             | Resolve `weights` / `presetName` / `mask` / `groupBy` / `signalLevel` from `mode` | `resolveMode(mode, presetSet)`         |
| 118-119            | Override `signalLevel` from `options`                                             | Same — inline on `resolved`            |
| 121-128            | Similarity-only fast path                                                         | `isSimilarityOnly(weights)`            |
| 131                | `computeAdaptiveBounds`                                                           | Unchanged call                         |
| 134-140            | `results.map(result => ...)` score + overlay                                      | `scoreResults(...)`                    |
| 142                | `sort by score desc`                                                              | Unchanged                              |
| 144-155            | `groupBy` collapse                                                                | `groupByTop(sorted, resolved.groupBy)` |
| 157                | return sorted                                                                     | Ternary on `resolved.groupBy`          |

No conditionals reshuffled. No early returns removed or added. No allocation
pattern changes (still per-result `{ ...r, score, rankingOverlay }`).

## Testing strategy

**Existing tests** (`tests/core/domains/explore/reranker.test.ts` and related)
verify `rerank()` behavior end-to-end — they continue to run unchanged and must
all pass. This is the primary guarantee of behavior preservation.

**New unit tests** per extracted phase:

- `resolveMode` — branch matrix: string preset / `{ preset, custom }` / pure
  `{ custom }` / preset not found in `resolvedPresets`
- `isSimilarityOnly` — edge cases: only `similarity=1` → true;
  `similarity=1, recency=0` → true (zero weights ignored);
  `similarity=0.5, recency=0.5` → false; empty weights → false
- `scoreResults` — given a mock `extractAllDerived` returning fixed signals,
  verify score sum and overlay attachment for single/multi-result batches
- `groupByTop` — groups collapse on `payload[key]`, first (highest-scored) wins;
  missing key → ungrouped bucket

Reuse existing test fixtures where possible. Do not re-test what the end-to-end
`rerank()` tests already cover.

## Error handling

No new error paths. The private methods fail exactly where the inline code fails
today (e.g., `resolveMode` throws nothing; `scoreResults` inherits
descriptor-extraction error behavior from `extractAllDerived`). Typed-errors
rule (`typed-errors.md`) is already satisfied upstream.

## Affected files

| File                                                 | Change                                                                                                                                                         |
| ---------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/core/domains/explore/reranker.ts`               | Rewrite `rerank()` body as orchestrator; add `resolveMode`, `scoreResults` private methods; add `isSimilarityOnly`, `groupByTop` module helpers at file bottom |
| `tests/core/domains/explore/reranker.test.ts`        | Add unit tests for new phases (do NOT modify existing end-to-end tests)                                                                                        |
| `tests/core/domains/explore/reranker-phases.test.ts` | (optional new file for phase-level unit tests, if the existing file would grow unwieldy)                                                                       |

No other files change. No public exports added. No DI wiring change.

## Rollout

Single commit under scope `refactor(explore)`. Pre-commit hook runs tests +
type-check. No migration. No schema drift. No reindex needed.

## Open questions

None. Scope is narrow; all five phases map 1:1 to existing code ranges;
signatures and tests are straightforward.

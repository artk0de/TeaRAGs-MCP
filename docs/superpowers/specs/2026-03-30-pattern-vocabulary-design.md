# Pattern Vocabulary & batchProcess Utility

**Date**: 2026-03-30 **Status**: Approved **Scope**: Extract `batchProcess<T>()`
utility + document three architectural patterns

## Problem

The codebase evolved three recurring structural patterns across domains without
naming or formalizing them. This causes:

1. **Batching duplication** — the same `for (i = 0; i += BATCH_SIZE)` loop is
   copy-pasted in 4+ locations with minor variations
2. **Pattern invisibility** — new code doesn't follow established patterns
   because they have no names or documented canonical implementations

## Solution

### Part 1: `batchProcess<T>()` utility

**Location**: `src/core/infra/batch-utils.ts`

```typescript
/**
 * Process items in sequential batches of a given size.
 * Error handling is the caller's responsibility — handler may throw or swallow.
 *
 * @returns Number of items whose handler completed (items in batches where handler didn't throw).
 */
export async function batchProcess<T>(
  items: T[],
  batchSize: number,
  handler: (batch: T[], isLast: boolean) => Promise<void>,
): Promise<number>;
```

Semantics:

- Iterates `items` in slices of `batchSize`
- Calls `handler(batch, isLast)` for each slice
- `isLast` is true for the final batch (enables `wait: true` pattern in Qdrant)
- Returns count of items in successfully processed batches
- If handler throws, exception propagates — caller decides error policy

#### Replacement targets

| File                                    | Current code                                                             | After                                      |
| --------------------------------------- | ------------------------------------------------------------------------ | ------------------------------------------ |
| `EnrichmentApplier.applyChunkSignals()` | Two inline BATCH_SIZE loops (main + missed stamp) with try/catch swallow | `batchProcess()` with try/catch in handler |
| `EnrichmentApplier.applyFileSignals()`  | Inline BATCH_SIZE loop with try/catch swallow                            | `batchProcess()` with try/catch in handler |
| `QdrantManager.batchSetPayload()`       | Inline slice loop with `isLast` wait logic                               | `batchProcess()` with `isLast` parameter   |
| `SchemaV9EnrichedAtBackfill.apply()`    | Inline batch loop over chunks                                            | `batchProcess()` with throw-on-error       |

#### NOT in scope

- `PointsAccumulator` — streaming accumulate + timer + retry-on-error (different
  abstraction)
- `BatchAccumulator` — streaming + worker pool + backpressure (different
  abstraction)

### Part 2: `.claude/rules/pattern-vocabulary.md`

Document three named patterns with canonical implementations:

#### StatefulProcessor

- **Shape**: `Map<key, State>` → iterate → status transitions → persist marker
- **Canonical**: `EnrichmentCoordinator` (`Map<string, ProviderState>` +
  `updateEnrichmentMarker()`)
- **Also seen in**: `Migrator` (`Map<PipelineName, MigrationRunner>`),
  `StatusModule.getStatusFromCollection()` (implicit FSM)
- **When to use**: orchestrating N providers/runners with independent lifecycle
  and persistent completion status
- **Anti-pattern**: using this for simple sequential steps without persistence —
  just use a loop

#### BatchedFlush

- **Shape**: accumulate → slice(BATCH_SIZE) → process → handle errors
- **Two variants**:
  - **Streaming**: `PointsAccumulator` / `BatchAccumulator` — timer-triggered,
    backpressure, retry-on-error
  - **One-shot**: `batchProcess()` utility — process a known array in batches
- **When to use**: any Qdrant bulk operation (upsert, setPayload, delete)
- **Anti-pattern**: writing inline `for (i += BATCH_SIZE)` loops — use
  `batchProcess()` instead

#### RegistryMerge

- **Shape**: `sources.flatMap(s => s.items)` → deduplicate → return merged
- **Canonical**: `TrajectoryRegistry.getAllPresets()`,
  `TrajectoryRegistry.getAllFilters()`
- **Also seen in**: `resolvePresets()` (explore),
  `RankModule.mergeAndDeduplicate()`
- **When to use**: assembling cross-provider collections (presets, signals,
  filters)
- **Anti-pattern**: extracting a generic `RegistryMerge<T>` class — the dedup
  key varies (name, id, score), keep it as documented convention

## Testing

- Unit tests for `batchProcess()`:
  - Normal flow: items split correctly, handler called with right batches
  - `isLast` flag: true only for final batch
  - Empty input: returns 0, handler never called
  - Handler throws: propagates, returns partial count
  - Exact batch boundary: 10 items / batchSize=5 → 2 batches, both with
    isLast=false except last
- Existing tests for refactored files must still pass (no behavior change)

## Non-goals

- Generic StatefulProcessor base class (each FSM has unique transitions)
- Generic RegistryMerge utility (dedup key varies per use case)
- Refactoring `PointsAccumulator` or `BatchAccumulator` (different abstraction)

# Scoped Signal Statistics Design

**Date:** 2026-03-26 **Status:** Approved

## Problem

Test chunks pollute global signal statistics. For example, test files with
`methodLines: 200` inflate p50/p95, making production chunks with
`methodLines: 50` appear "small" when they're normal for production code. This
distorts label resolution in overlay — `commitCount`, `methodLines`,
`bugFixRate` thresholds become meaningless when test and source code are mixed.

High churn in tests is a valid signal of domain instability, but it needs
separate thresholds to be actionable.

## Design

### Scope Detection

Each chunk gets a scope: `"source"` or `"test"`. Detection priority:

1. `chunkType === "test"` → `test`
2. `chunkType === "test_setup"` → **excluded** from both scopes (noise, like
   config languages)
3. All other chunkTypes → check path fallback for languages without AST test
   detection
4. Path fallback: if the chunk's language has 0 chunks with `chunkType: "test"`
   in the collection → match against test path patterns
5. Chunks matching default test paths → always excluded from `source` even
   without chunkType detection
6. If no criteria matched → `source`

**Source scope exclusion rule:** a chunk is excluded from `source` stats if ANY
of these is true:

- `chunkType === "test"` or `chunkType === "test_setup"`
- `relativePath` matches configured or default test path patterns

This ensures source stats are clean even for languages without AST test
detection.

### Test Path Configuration

**Env var:** `CODE_TEST_PATHS` — comma-separated glob patterns. Overrides
per-language defaults when set.

```
CODE_TEST_PATHS=spec/**,test/**,custom_tests/**
```

**Per-language defaults** (used when `CODE_TEST_PATHS` is not set):

| Language              | Default test paths                                                                              |
| --------------------- | ----------------------------------------------------------------------------------------------- |
| ruby                  | `spec/**`, `test/**`                                                                            |
| typescript/javascript | `tests/**`, `test/**`, `__tests__/**`, `**/*.test.{ts,js,tsx,jsx}`, `**/*.spec.{ts,js,tsx,jsx}` |
| python                | `tests/**`, `test/**`, `**/test_*.py`, `**/*_test.py`                                           |
| go                    | `**/*_test.go`                                                                                  |
| java                  | `src/test/**`, `**/test/**`                                                                     |
| kotlin                | `src/test/**`, `**/test/**`                                                                     |
| c#                    | `**/*.Tests/**`, `**/Tests/**`, `**/*Test.cs`, `**/*Tests.cs`                                   |
| rust                  | — (tests inline via `#[cfg(test)]`, relies on chunkType)                                        |
| swift                 | `**/Tests/**`, `**/*Tests.swift`                                                                |
| php                   | `tests/**`, `test/**`, `**/*Test.php`                                                           |
| elixir                | `test/**`, `**/*_test.exs`                                                                      |
| scala                 | `src/test/**`, `**/test/**`                                                                     |
| fallback              | `test/**`, `tests/**`, `spec/**`, `__tests__/**`                                                |

### Storage: `CollectionSignalStats`

Current per-language stats type changes from `SignalStats` to
`ScopedSignalStats`:

```typescript
interface ScopedSignalStats {
  source: SignalStats;
  test?: SignalStats; // undefined when 0 test chunks for this lang+signal
}

// perLanguage changes:
// BEFORE: Map<lang, Map<signal, SignalStats>>
// AFTER:  Map<lang, Map<signal, ScopedSignalStats>>
```

`perSignal` (global aggregate) remains — computed from source scope only across
all code languages. Tests excluded from global stats.

### Cache

`StatsCache` version bump: 4 → 5. Serialization handles `ScopedSignalStats`:

```typescript
// Serialized format in JSON:
{
  "version": 5,
  "perLanguage": {
    "ruby": {
      "git.file.commitCount": {
        "source": { "count": 320, "percentiles": { ... } },
        "test": { "count": 180, "percentiles": { ... } }
      }
    }
  }
}
```

Old v4 cache files gracefully migrate: treat existing `SignalStats` as
`{ source: existingStats, test: undefined }`.

### Computation: `collection-stats.ts`

In `extractSignalValues()`, for each point:

1. Determine scope via `detectScope(chunkType, relativePath, language, config)`
2. If scope is `null` (test_setup) → skip point entirely
3. Accumulate values into per-language-scope arrays:
   `Map<lang, Map<signal, { source: number[], test: number[] }>>`
4. Compute percentiles separately for each scope

`detectScope()` is a standalone exported function — reused by reranker.

### Reranker: Label Resolution

In `applyLabelResolution()`:

1. Get `language` and `relativePath` from chunk payload
2. Call `detectScope(chunkType, relativePath, language, config)` → `"source"` or
   `"test"`
3. Get `ScopedSignalStats` for language + signal key
4. Use `stats[scope]` thresholds for label resolution
5. Fallback: if scope stats undefined (e.g. test stats missing) → use `source`
   thresholds

### `get_index_metrics` Output

Signals nested by language → signal → scope:

```json
{
  "signals": {
    "ruby": {
      "git.file.commitCount": {
        "source": {
          "min": 1, "max": 45, "count": 320, "mean": 8.2,
          "labelMap": { "low": 2, "typical": 5, "high": 12, "extreme": 30 }
        },
        "test": {
          "min": 1, "max": 89, "count": 180, "mean": 14.3,
          "labelMap": { "low": 3, "typical": 12, "high": 25, "extreme": 60 }
        }
      }
    },
    "global": { ... }
  }
}
```

### Shared Utility: `detectScope()`

Extracted to a shared location (e.g. `src/core/infra/scope-detection.ts`):

```typescript
type ChunkScope = "source" | "test" | null; // null = excluded (test_setup)

function detectScope(
  chunkType: string | undefined,
  relativePath: string,
  language: string,
  config: {
    testPaths?: string[];
    languageTestChunkCounts: Map<string, number>;
  },
): ChunkScope;
```

- Returns `null` for `test_setup` → caller skips point
- Returns `"test"` for chunkType test or path-matched test files
- Returns `"source"` otherwise (after excluding test paths)

## Files to Modify

| File                                              | Change                                                  |
| ------------------------------------------------- | ------------------------------------------------------- |
| `src/core/infra/scope-detection.ts`               | NEW: `detectScope()`, default test paths, config loader |
| `src/core/domains/ingest/collection-stats.ts`     | Scope-aware value extraction + ScopedSignalStats output |
| `src/core/contracts/types/trajectory.ts`          | `ScopedSignalStats` type                                |
| `src/core/infra/stats-cache.ts`                   | Version 5, serialize/deserialize ScopedSignalStats      |
| `src/core/domains/explore/reranker.ts`            | Scope-aware label resolution                            |
| `src/core/api/internal/facades/explore-facade.ts` | Updated `getIndexMetrics()` output format               |
| `src/core/api/public/dto/metrics.ts`              | Updated `SignalMetrics` type with scope nesting         |
| `src/bootstrap/config.ts`                         | `CODE_TEST_PATHS` env var parsing                       |
| Tests for each file above                         |                                                         |

## Testing

- Unit: `detectScope()` with all chunkType/path/language combinations
- Unit: `computeCollectionStats()` produces separate source/test percentiles
- Unit: `StatsCache` v5 serialization + v4→v5 migration
- Unit: reranker label resolution uses correct scope thresholds
- Unit: `getIndexMetrics()` output matches expected format
- Integration: reindex codebase, verify `get_index_metrics` shows scoped stats

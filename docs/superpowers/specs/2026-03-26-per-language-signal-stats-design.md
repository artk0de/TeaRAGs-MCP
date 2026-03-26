# Per-Language Signal Statistics

**Date:** 2026-03-26 **Status:** Approved

## Problem

Signal statistics (percentiles, label thresholds) are computed globally across
all chunks regardless of language. In polyglot projects, dominant languages skew
thresholds — a `commitCount.high = 4` computed across TypeScript + markdown +
JSON is meaningless for TypeScript-only analysis.

Additionally, `Reranker.applyLabelResolution()` resolves chunk-level labels
using file-level percentiles due to short-name collision in `signalKeyMap`
(`"commitCount"` maps to `git.file.commitCount` for both file and chunk
overlays).

## Solution

### 1. Per-language statistics in `computeCollectionStats()`

**File:** `src/core/domains/ingest/collection-stats.ts`

Group signal values by chunk language before computing percentiles. Each
language gets its own `Map<string, SignalStats>`.

**Language classification:**

- **Code languages** (always compute stats): typescript, javascript, ruby,
  python, go, rust, java, bash, powershell, c, cpp, csharp, swift, kotlin, php,
  scala, elixir, haskell, lua, r, perl, dart, zig, etc.
- **Config languages** (json, yaml, markdown, text, gitignore, toml, xml, ini,
  env, csv, dockerfile): compute stats only if the language occupies >= 10% of
  total chunks.

**Minimum sample size:** Per-language stats are only stored if the language has

> = 10 chunks with valid signal values. Below that threshold, percentiles are
> statistically meaningless — fallback to global stats at resolution time.

**Chunks with no `language` field:** Contribute to global `perSignal` stats
only. They are excluded from all per-language buckets. This is intentional —
global stats serve as the universal fallback.

Implementation: `extractSignalValues()` returns
`perLanguageValues: Map<string, Map<string, number[]>>` alongside the existing
`valueArrays`. A new `computePerLanguageStats()` iterates each language's value
arrays and calls the existing `computePerSignalStats()`. Languages below the
minimum sample size threshold are filtered out before storage.

`computeCollectionStats()` returns the updated `CollectionSignalStats` with
`perLanguage` populated:

```typescript
return {
  perSignal,
  perLanguage, // NEW
  distributions,
  computedAt: Date.now(),
};
```

### 2. Cache format: `CollectionSignalStats.perLanguage`

**File:** `src/core/contracts/types/trajectory.ts`

```typescript
interface CollectionSignalStats {
  perSignal: Map<string, SignalStats>;           // global (kept for backward compat)
  perLanguage: Map<string, Map<string, SignalStats>>; // NEW
  distributions: { ... };
  computedAt: number;
}
```

**File:** `src/core/infra/stats-cache.ts`

Cache version bump v3 -> v4. Old v3 caches are discarded on load
(auto-recomputed).

Serialization: `perLanguage` stored as
`Record<string, Record<string, SignalStats>>` (JSON-compatible).

Deserialization: nested reconstruction —
`new Map(Object.entries(raw).map(([lang, signals]) => [lang, new Map(Object.entries(signals))]))`
mirroring the existing `perSignal` pattern but with an additional nesting level.

### 3. Fix `applyLabelResolution()` level context

**File:** `src/core/domains/explore/reranker.ts`

Current bug: `applyLabelResolution(rawChunk)` resolves `"commitCount"` via
`signalKeyMap` to `git.file.commitCount` instead of `git.chunk.commitCount`.

Fix: `applyLabelResolution()` signature changes to:

```typescript
private applyLabelResolution(
  overlay: Record<string, unknown>,
  level: "file" | "chunk",
  language?: string,
): void
```

Key reconstruction algorithm for each short field name in the overlay (e.g.,
`"commitCount"`):

1. Try `signalKeyMap.get(level + "." + field)` — e.g.,
   `signalKeyMap.get("chunk.commitCount")` → `"git.chunk.commitCount"`
2. Fallback: `signalKeyMap.get(field)` — for signals that exist at one level
   only (e.g., `"dominantAuthorPct"` exists only as
   `git.file.dominantAuthorPct`)
3. If neither resolves → skip (no label for this field)

`buildOverlay()` passes `"file"` when calling for `rawFile` and `"chunk"` for
`rawChunk`. It also passes the chunk's `language` from
`result.payload.language`.

### 4. Per-language label resolution in Reranker

**File:** `src/core/domains/explore/reranker.ts`

`applyLabelResolution()` receives the `language` string from `buildOverlay()`,
which reads it from `result.payload.language`.

Resolution order for percentile lookup:

1. `collectionStats.perLanguage.get(language)?.get(fullKey)` — per-language
   stats
2. `collectionStats.perSignal.get(fullKey)` — global fallback (used when:
   language is undefined, language has < 10 chunks, or language is a config
   language below 10% threshold)

This ensures labels reflect the chunk's own language distribution.

### 5. `get_index_metrics` API response

**File:** `src/core/api/internal/facades/explore-facade.ts`

`signals` changes from `Record<string, SignalMetrics>` to
`Record<string, Record<string, SignalMetrics>>`:

```json
{
  "signals": {
    "global": {
      "git.file.commitCount": { "min": 1, "max": 31, "count": 1900, "labelMap": { ... } }
    },
    "typescript": {
      "git.file.commitCount": { "min": 1, "max": 31, "count": 1214, "labelMap": { ... } }
    },
    "bash": {
      "git.file.commitCount": { "min": 1, "max": 8, "count": 97, "labelMap": { ... } }
    }
  }
}
```

**File:** `src/core/api/public/dto/metrics.ts`

`IndexMetrics.signals` type changes to
`Record<string, Record<string, SignalMetrics>>`.

### 6. Config language threshold

**File:** `src/core/domains/ingest/collection-stats.ts`

Hardcoded set of config languages:

```typescript
const CONFIG_LANGUAGES = new Set([
  "json",
  "yaml",
  "markdown",
  "text",
  "gitignore",
  "toml",
  "xml",
  "ini",
  "env",
  "csv",
  "dockerfile",
]);
```

During `computeCollectionStats()`, after extracting language counts:

1. Compute total chunk count.
2. For each language in `CONFIG_LANGUAGES`: include in per-language stats only
   if `languageCounts[lang] / totalChunks >= 0.10`.
3. Code languages always included.

### 7. Skill updates

Search Cascade and other skills that parse `get_index_metrics` output need to
read `signals.global` (or language-specific) instead of `signals` directly.

## Files changed

| File                                                 | Change                                                                                              |
| ---------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| `src/core/domains/ingest/collection-stats.ts`        | Per-language grouping, config language filter, min sample size                                      |
| `src/core/contracts/types/trajectory.ts`             | `CollectionSignalStats.perLanguage` field                                                           |
| `src/core/infra/stats-cache.ts`                      | v4 format, nested `perLanguage` serialization/deserialization                                       |
| `src/core/domains/explore/reranker.ts`               | `applyLabelResolution()` signature: +level +language, key reconstruction, per-language stats lookup |
| `src/core/api/internal/facades/explore-facade.ts`    | Build per-language signals in `getIndexMetrics()`                                                   |
| `src/core/api/public/dto/metrics.ts`                 | `IndexMetrics.signals` type change                                                                  |
| `plugin/skills/*/SKILL.md`                           | Update `signals` parsing references                                                                 |
| `tests/core/api/get-index-metrics.test.ts`           | Update `signals` shape assertions                                                                   |
| `tests/core/api/dto/metrics.test.ts`                 | Update DTO shape validation                                                                         |
| `tests/core/domains/explore/reranker.test.ts`        | Add per-language + level label resolution tests                                                     |
| `tests/core/domains/ingest/collection-stats.test.ts` | Add per-language stats computation tests                                                            |

## Not in scope

- Per-language adaptive bounds in Reranker scoring (uses batch p95, not cached
  stats — already language-scoped by query filter)
- Per-language distributions (author, chunkType) — future enhancement
- UI/dashboard changes

# Lazy Percentile Recompute — Design Spec

## Goal

When a descriptor's `confidence` block references a percentile of a support
signal at query time AND that percentile is declared on the support
(`stats.labels` key or `stats.percentilesToCompute`) BUT is missing from the
loaded `CollectionSignalStats` (stale index — descriptor was added/changed after
the last full index), recompute that one percentile from current Qdrant payloads
and persist it back to the stats-cache **WITHOUT touching any other field** of
the support's `SignalStats` record.

Forward path: a descriptor change requiring a new percentile won't force a full
re-index. The next query that needs it triggers a one-percentile recompute.
Subsequent queries see the cached value.

## Problem

Index-time invariants today:

- `computePerSignalStats` computes percentiles from union of `stats.labels`
  keys + `stats.percentilesToCompute`. After re-index, all declared percentiles
  are present.
- After descriptor change that adds a percentile reference, the existing
  collection stats DON'T have the new percentile. Adaptive resolution silently
  falls back to the static `rule.fallback`.

A force re-index is heavy: scrolling all points, re-extracting every signal,
recomputing every percentile, regenerating all distributions and accumulators.
To backfill ONE percentile after one descriptor edit is wildly disproportionate.

## Design Decisions

### D1: Trigger condition

Lazy recompute triggers when ALL of:

1. A descriptor declares `confidence.score.adaptivePercentile` OR
   `confidence.label.rules[].whenSupportBelow: "pN"` referencing percentile `p`.
2. The support signal's `stats.labels` keys OR `stats.percentilesToCompute`
   declares `p` (so `validateSignalDependencies` passed at composition).
3. At query time, the loaded `CollectionSignalStats.perSignal[supportKey]`
   exists but `perSignal[supportKey].percentiles[p]` is undefined. (Same check
   for `perLanguage[lang][supportKey].{source|test}.percentiles[p]` when
   scope-aware lookup needs that value.)

If (1) or (2) fails — that's a configuration error caught by validation, not a
lazy-compute case. If (3) fails because the support signal has no `perSignal`
entry at all (empty index?) — fall through to static fallback without recompute.

### D2: Recompute scope — single percentile, single signal, single scope

Recompute targets exactly the missing `(signalKey, scope, percentile)` triple.
NOT the whole `SignalStats` record. NOT all percentiles. NOT all signals. NOT
all scopes.

**Critical invariant — partial update preserves all other fields:**

```ts
// BEFORE recompute
perSignal["git.file.commitCount"] = {
  count: 50523,
  min: 1,
  max: 959,
  percentiles: { 25: 1, 50: 2, 75: 5, 95: 18 },
  mean: 4.7,
  stddev: 12.3,
};

// AFTER recomputing p10 for the same signal
perSignal["git.file.commitCount"] = {
  count: 50523, // ← UNCHANGED
  min: 1,
  max: 959, // ← UNCHANGED
  percentiles: {
    // ← single key added
    10: 0.4, //   ↑ NEW
    25: 1,
    50: 2,
    75: 5,
    95: 18, // ← UNCHANGED
  },
  mean: 4.7,
  stddev: 12.3, // ← UNCHANGED
};
```

The implementation MUST NOT replace the whole `SignalStats` record. Spread,
shallow-clone, or in-place mutate the `percentiles` sub-object only.

**Why this matters:** other consumers (overlay label resolver, adaptive-bounds
in reranker, `get_index_metrics` exposure) rely on the existing fields. A
whole-record overwrite that recomputes only the missing percentile would zero
`mean`, `stddev`, `min`, `max` — every dashboard, agent-side metric reader, and
label resolver fed by the cache would silently break.

### D3: Where the recompute lives

`StatsRecomputeService` (new) — a lightweight service injected into
ExploreFacade with access to:

- `QdrantManager` (for scroll)
- `CollectionSignalStats` (in-memory, mutable for partial update)
- `StatsCache` (persistence)

API:

```ts
class StatsRecomputeService {
  /**
   * Recompute one percentile of one signal at one scope. Updates in-memory
   * stats AND persists to stats-cache. Idempotent: if the percentile is
   * already present, returns it without rescanning.
   */
  async recomputePercentile(
    signalKey: string,
    percentile: number,
    options?: {
      language?: string;
      scope?: "source" | "test";
    },
  ): Promise<number | undefined>;
}
```

`Reranker.preResolveConfidenceClamp` and `Reranker.resolveDampeningThreshold`
detect missing percentiles and call the service synchronously (await). Lazy:
only triggered when needed.

### D4: Concurrency

Two concurrent queries asking for the same missing percentile must not
double-compute. Use per-key promise memoization on the service:

```ts
private inFlight: Map<string, Promise<number | undefined>> = new Map();

async recomputePercentile(key, p, opts) {
  const cacheKey = `${key}:${p}:${opts.language ?? ""}:${opts.scope ?? ""}`;
  const existing = this.inFlight.get(cacheKey);
  if (existing) return existing;
  const promise = this.doRecompute(key, p, opts).finally(() => {
    this.inFlight.delete(cacheKey);
  });
  this.inFlight.set(cacheKey, promise);
  return promise;
}
```

### D5: Qdrant scroll scope

`doRecompute` scrolls all chunks matching:

- Project's full collection
- Filter on `language` if scope-aware (skip points of wrong language)
- Filter on `chunkType` per scope mapping (test vs source) when scope set

Reads only the support signal's payload field. Sorts, computes percentile,
returns. Average scroll size = total chunks (could be 80k+ for large projects);
operation is read-only and bounded.

### D6: Stats-cache persist

After in-memory mutation, `StatsCache.update(collection, partial)` writes the
modified `CollectionSignalStats` back to disk. Implementation MUST:

- Serialize the FULL `CollectionSignalStats` (not a delta) — atomic replace via
  tmp+rename, same pattern as existing snapshot writes.
- Preserve the `computedAt` of the original full compute. Add a separate
  `percentilesBackfilledAt` map: `{ "git.file.commitCount.10": <timestamp> }` to
  track which entries are lazy-computed for observability.

### D7: Lifecycle

Recompute is **opportunistic only**: triggered by an actual query need. Never
proactively. Never on startup (would defeat the lazy purpose). When the next
full reindex runs, all percentiles get recomputed from scratch and
`percentilesBackfilledAt` is cleared.

### D8: Failure modes

If `doRecompute` fails (Qdrant error, no points match, sort overflow):

- Log warning at WARN level (visible without DEBUG).
- Fall back to `rule.fallback` (label path) or `confidence.score.threshold`
  (score path) — same as current "missing percentile" behavior.
- Do NOT crash the query. Do NOT mutate in-memory or persisted stats.
- Mark the cache key as "compute-failed" with a short TTL backoff (e.g. 60s) to
  avoid retry storms.

### D9: Validation gate

`validateSignalDependencies` (already in collection-stats.ts) prevents unwired
references at composition time. Lazy recompute only handles the case where the
wiring is correct but the index is stale. A misconfigured descriptor that
references an undeclared percentile fails at boot, NOT at query time — same
loud-failure principle as score-side floor missing support.

## Out of Scope

- Recomputing `mean`, `stddev`, `min`, `max`, `count`, or other percentiles of
  the same signal. Those are full-index concerns; if stale, run a full reindex.
- Recomputing percentiles for non-confidence reasons (e.g. agent ad-hoc
  request). The trigger is exclusively confidence-block lookup failure.
- Per-language scope-aware recompute when the labeled signal's scope doesn't
  match support's scope. The scope passed to `doRecompute` is the scope the
  LABEL resolution is running in.
- Distributed lock for multi-process scenarios. Single-process MCP server uses
  the in-process promise memoization; multi-process needs separate spec.

## Acceptance Criteria

1. Adding a descriptor that references "pN" of a support signal — after
   composition rebuild but BEFORE re-indexing — does not crash on next query.
   Adaptive resolution lazily computes the percentile.
2. After lazy recompute: `CollectionSignalStats.perSignal[supportKey]` has only
   the missing percentile added; all other fields unchanged.
3. Stats-cache persists the partial update; reloading the collection reads back
   the lazily-computed percentile (no recompute needed second time).
4. Concurrent first-time requests for the same percentile produce ONE qdrant
   scroll, not N.
5. Validation (`validateSignalDependencies`) still catches descriptors
   referencing percentiles that are NOT declared anywhere on the support. Lazy
   compute does NOT bypass the contract.
6. Failed recompute (qdrant unavailable, no points) falls back gracefully to
   `rule.fallback` / `score.threshold` and logs warning.

## Plugin Version Bump

None on `.claude-plugin/` — this spec is `src/` only. Package: `tea-rags` patch
bump (infrastructural addition, no behavior change for correctly-indexed
collections).

## Effort

~1.5 days:

- StatsRecomputeService class + plumbing (~3h)
- Per-key in-flight memoization + integration tests (~2h)
- Stats-cache partial update + atomic write (~3h)
- Reranker integration (preResolveConfidenceClamp + resolveDampeningThreshold)
  (~2h)
- Tests: in-memory partial update invariant, concurrent recompute, persist
  - reload, failure paths (~3h)

## Cross-references

- Parent epic: `tea-rags-mcp-vpn6`
- Trigger context: `tea-rags-mcp-39zg` (scope-aware lookup + missing percentile
  discovery)
- Validation contract: see `validateSignalDependencies` in
  `src/core/domains/ingest/collection-stats.ts`
- Stats-cache: `src/core/infra/stats-cache.ts`
- Spec on confidence mechanism:
  `2026-05-14-bugfixrate-label-confidence-design.md`

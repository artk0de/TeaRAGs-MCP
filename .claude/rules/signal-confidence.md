---
paths:
  - "src/core/domains/trajectory/**/rerank/derived-signals/**"
  - "src/core/domains/trajectory/**/rerank/presets/**"
  - "src/core/contracts/types/trajectory.ts"
  - "src/core/domains/ingest/infra/collection-stats.ts"
  - "src/core/domains/ingest/infra/stats-recompute.ts"
  - "src/core/api/internal/composition.ts"
---

# Signal Confidence (MANDATORY for new ratio/aggregate signals)

> **Status:** Operative. All 7 derived signals (`BugFixSignal`,
> `VolatilitySignal`, `RecentActivityConcentrationSignal`, `DensitySignal`,
> `RelativeChurnNormSignal`, `KnowledgeSiloSignal`, `OwnershipSignal`) migrated
> to unified `stats.confidence` mechanism. Legacy `dampeningSource` /
> `FALLBACK_THRESHOLD` / `DampeningConfig` / `GIT_FILE_DAMPENING` types +
> constants removed. New signals MUST use unified block.

## What it is

`SignalConfidence` (in `src/core/contracts/types/trajectory.ts`) = per-signal
declaration on `PayloadSignalDescriptor.stats.confidence`. ONE source of truth
read by BOTH reranker score path AND label overlay path.

```ts
{
  key: "git.file.bugFixRate",
  stats: {
    labels: { p50: "healthy", p75: "concerning", p95: "critical" },
    confidence: {
      support: "commitCount",                                  // bare sibling, same-scope
      score: { threshold: 10, adaptivePercentile: 25 },        // floor (10) + adaptive percentile of support
      label: {
        rules: [
          { whenSupportBelow: "p10", fallback: 5,  ceiling: "healthy"    },
          { whenSupportBelow: "p25", fallback: 10, ceiling: "concerning" },
        ],
      },
    },
  },
}
```

Two consumers, one declaration:

- **Score path** — `confidenceDampening(supportValue, k)` attenuates
  derived-signal ranking contribution. **Scope-aware (tea-rags-mcp-eab6):**
  blended signals dampen each scope's component by its OWN support before the
  alpha-blend —
  `value = alpha·(chunkVal·damp_chunk) + (1-alpha)·(fileVal·damp_file)` — so
  low-N chunk in high-commit file no longer gets file's confidence (and high-N
  chunk in low-commit file no longer over-dampened). Reranker resolves per-scope
  `k` (`k_f` from `file.{support}`, `k_c` from `chunk.{support}`, passed as
  `ctx.dampeningThreshold` / `ctx.dampeningThresholdChunk`), priority order:
  1. **Adaptive** — support signal's `adaptivePercentile` value at that scope,
     read from collection stats.
  2. **Floor** — `confidence.score.threshold` (descriptor-static).
  3. **FALLBACK_K** — defensive constant on derived signal class.

  File-only signals (`ownership`, `recentActivityConcentration`) read only
  `dampeningThreshold`, unchanged. Pure-file payloads (alpha=0) numerically
  identical to pre-eab6 single-dampening path.

- **Label path** — walks `label.rules` ascending by resolved `whenSupportBelow`;
  first match caps overlay label at `ceiling`. Raw `value` in overlay preserved.

## Adaptive thresholds

Both `confidence.score.adaptivePercentile` AND
`confidence.label.rules[].whenSupportBelow: "pN"` resolve dynamically from
collection stats at query time:

- `score.adaptivePercentile: 25` → reranker reads
  `git.file.{support}.percentiles[25]`, uses as dampening k. Defaults to 25 when
  omitted (backwards compat with legacy `GIT_FILE_DAMPENING.percentile=25`).
- `whenSupportBelow: "p10"` → label resolver reads
  `git.{scope}.{support}.percentiles[10]`. Resolved BEFORE rules walked
  (`Reranker.preResolveConfidenceClamp`).
- `fallback: <number>` on rule — REQUIRED with `pN` strings. Used when stats
  lack percentile (stale index — descriptor added `pN` ref after last full
  reindex). Without fallback, unresolvable rule silenced (`whenSupportBelow: 0`,
  never fires).

### Validation contract (`validateSignalDependencies`)

For every `pN` referenced by any descriptor's
`confidence.score.adaptivePercentile` or
`confidence.label.rules[].whenSupportBelow`, the **support signal MUST declare
N** — either `pN` key in `stats.labels` OR number in
`stats.percentilesToCompute`.

`validateSignalDependencies` (in
`src/core/domains/ingest/infra/collection-stats.ts`) walks all descriptors at
composition time, throws if any reference unwired. Loud failure at startup —
never silent fallback in production.

`percentilesToCompute` declares percentiles to compute at index time beyond
signal's own `labels` keys imply. Example:

```ts
{
  key: "git.file.commitCount",
  stats: {
    labels: { p25: "low", p50: "typical", p75: "high", p95: "extreme" },
    // bugFixRate.confidence references "p10" of commitCount — declare here
    // so collection-stats computes p10 at index time too.
    percentilesToCompute: [10],
  },
}
```

### Lazy recompute (operative — at rerank time)

**Status:** Live. `StatsRecomputeService`
(`src/core/domains/ingest/infra/stats-recompute.ts`) runs at **rerank time**,
not stats-load. Lives in `ingest/` because it does ingest work (scroll → compute
percentiles → write stats cache); consumed by `Reranker` via DI
(`setRecomputeService`) from `explore/` domain. `Reranker.rerank()` async;
pre-pass calls
`recomputeService.ensureCoverage(collection, stats, payloadSignals, payloadFieldKeys)`
_before_ scoring. Only specific `(supportKey, percentile)` refs missing from
in-memory stats trigger work; else Map-lookup no-op.

**Trigger ladder.** Per query:

1. Caller hits `Reranker.rerank()` (semantic_search, hybrid_search, rank_chunks,
   find_similar, find_symbol, search_code — anywhere confidence-aware preset
   renders labels).
2. Preset similarity-only (`relevance` / similarity weight only) →
   `isSimilarityOnly` early-return; **no recompute, no scroll**.
3. Else `ensureNeededPercentiles` → `ensureCoverage` walks every
   `PayloadSignalDescriptor.stats.confidence`, collects missing
   `(supportSignalKey, percentile)` pairs.
4. Empty set → early-return; **no scroll**. Common case: warm stats.
5. Non-empty: group by signalKey, parallel `backfillSignal` per group. Each
   backfill = **one scroll of one signal across collection**, batch-computes
   every missing percentile of that signal in one sort. One save at end of
   `ensureCoverage` (full snapshot via `StatsCache.save`, all other fields
   preserved exactly).

**What's `lazy` exactly.**

- Lazy at **point of label rendering** — scroll fires first time rerank consults
  missing reference, not eagerly at process start.
- Lazy at **granularity of percentile** — only the specific missing `pN`
  computed (not whole `SignalStats`, not whole signal's percentile set if only
  one missing).
- Lazy at **scope of signal** — one scroll per missing signal, not per missing
  percentile of that signal.

**Invariants the implementation enforces.**

- Partial update preserves every other `SignalStats` field exactly: `count`,
  `min`/`max`, `mean`, `stddev`, every pre-existing percentile.
- Per-(collection, signal) **in-flight memo** so concurrent reranks don't
  duplicate-scroll same signal.
- One `statsCache.save` per `ensureCoverage` call (single atomic snapshot
  rewrite), even when multiple signals backfilled.
- 60s **failure backoff** per (collection, signal): scroll errors or
  empty-after-scroll don't retry storm; other signals proceed independently.
- Idempotent across reranks — once percentile in stats, next rerank's check
  finds it, skips scroll.

**Wiring (`ExploreOps`).** When stats loaded for a collection:

```ts
this.reranker.setRecomputeService(this.recomputeService);
this.reranker.setCollectionStats(stats, {
  collectionName,
  payloadFieldKeys: stats.payloadFieldKeys,
});
```

No `ensureCoverage` call here — load is fast + side-effect-free. Service wired
so next `rerank()` drives own lazy backfill.

**Stale-index escape hatch.** Recompute service not wired (test fixtures,
missing qdrant/statsCache) or scroll fails → label path falls back to
`rule.fallback`, score path to `confidence.score.threshold` — both on
descriptor. Force-reindex restores all percentiles from scratch via normal
ingest path.

Spec: `docs/superpowers/specs/2026-05-15-lazy-percentile-recompute-design.md`.

## When to declare `confidence`

Decide per raw signal at descriptor-declaration time. Signal needs `confidence`
block when **any** holds:

| Trigger                                                                                      | Why                                                        |
| -------------------------------------------------------------------------------------------- | ---------------------------------------------------------- |
| Signal is a **ratio** (`X / Y` where Y is stored as a separate signal)                       | Small denominator makes the ratio statistically unreliable |
| Signal is an **aggregate over a small count** (timing variance, weighted decay over commits) | <3 data points → noise dominates structure                 |
| Derived signal class currently calls `confidenceDampening(supportValue, k)` in `extract`     | Pre-existing pattern; migrate to declarative block         |
| Overlay label is misread by agents on small-N cases                                          | Empirical: agent over-weights `"critical"` label for N=2   |

**None** apply → omit `confidence`. Most signals don't need it (e.g.
`commitCount` itself, `ageDays`, raw `imports`).

## Choosing `support`

`support` = **bare sibling name** — same-scope payload field acting as
statistical denominator. Examples:

| Signal                    | Support         | Reason                                                                  |
| ------------------------- | --------------- | ----------------------------------------------------------------------- |
| `bugFixRate`              | `commitCount`   | `bugFixRate = bugFixCommits / commitCount`                              |
| `churnVolatility`         | `commitCount`   | timing variance over commits                                            |
| `recencyWeightedFreq`     | `commitCount`   | weighted sum needs ≥3 commits                                           |
| `relativeChurn`           | `commitCount`   | churn count normalized by file size                                     |
| `blameDominantAuthorPct`  | `commitCount`\* | legacy migration — semantically `blameContributorCount` may fit better  |
| `recentDominantAuthorPct` | `commitCount`\* | analogous; migrated from `GIT_FILE_DAMPENING` for numerical equivalence |

\* Some signals' support choice = migration artifact: legacy
`GIT_FILE_DAMPENING` used `commitCount` for ALL signals regardless of semantic
fit. Ownership-flavor signals arguably want `blameContributorCount` support —
proposed in follow-up. Don't change support without numerical-equivalence
regression.

Resolution is **same-scope only**, on BOTH label AND score path
(tea-rags-mcp-eab6 closed gap — score path was previously file-scope only). A
`git.chunk.bugFixRate` descriptor with `support: "commitCount"` resolves to
`git.chunk.commitCount` (not file); blended derived signal damps chunk component
by `git.chunk.commitCount`, file component by `git.file.commitCount`.
Cross-scope reads (chunk signal reading file support) remain explicitly **out of
scope**.

## `score` vs `label` — when to use each

Two sub-blocks independent. Mix + match per signal need:

| Pattern                           | Score | Label | Example                                                                           |
| --------------------------------- | ----- | ----- | --------------------------------------------------------------------------------- |
| **Both** (most common for ratios) | yes   | yes   | `bugFixRate` — dampen rank contribution AND clamp overlay label                   |
| **Score only**                    | yes   | no    | All 6 migrated signals — score dampening preserved, no label clamp declared       |
| **Label only**                    | no    | yes   | Signal isn't fed into derived ranking but overlay label needs sample-size honesty |
| **Neither**                       | no    | no    | Then don't declare `confidence` at all — empty block has no semantic              |

## Picking threshold values

### `score.threshold` (static floor)

Used as `k` in `confidenceDampening(n, k) = min((n/k)^2, 1)` ONLY WHEN adaptive
unavailable (no collection stats). Smaller `k` = less dampening; larger `k` =
more aggressive small-N suppression.

- **`k = 5`** — light dampening; pattern-following for signals where ≥3 data
  points meaningful (ownership signals).
- **`k = 8`** — medium dampening (`VolatilitySignal` uses this).
- **`k = 10`** — standard for ratio signals like `bugFixRate` where N≥10
  stabilizes the ratio.
- **`k = 20+`** — heavy dampening; reserved for very noisy aggregates.

Adaptive (`adaptivePercentile`) usually wins over `threshold`; static value =
floor only.

### `score.adaptivePercentile` (which percentile to use as adaptive k)

Percentile of support signal (file-scope) used as adaptive `k`. Default: 25
(matches legacy `GIT_FILE_DAMPENING.percentile=25`).

### `label.rules[].whenSupportBelow` (clamp thresholds)

Two forms:

- **Static**: `number`. Used as-is.
- **Adaptive**: `"pN"` string. Resolves to
  `git.{scope}.{support}.percentiles[N]` via collection stats at query time.
  **Requires `fallback: number`** — used when stats unavailable.

Rules walked ascending by RESOLVED numeric threshold. First match wins.
Convention: at most 2-3 rules per signal. Example `bugFixRate`:

```ts
rules: [
  { whenSupportBelow: "p10", fallback: 5, ceiling: "healthy" }, // tightest clamp
  { whenSupportBelow: "p25", fallback: 10, ceiling: "concerning" }, // moderate clamp
];
// commitCount >= resolved-p25 → no clamp, full label severity
```

`ceiling` MUST be a value present in same descriptor's `labels` map. Resolver
throws if not — caught at first use, not descriptor load (no Zod in
`contracts/`).

## What NOT to do

- **Don't declare `confidence` without a real consumer.** Empty `score`+`label`
  blocks pollute descriptor introspection. Omit entirely.
- **Don't duplicate parameters across raw and derived layers.** Block lives ONLY
  on raw descriptor. Derived signals consume via `ExtractContext`, never
  re-declare `support` or `threshold`.
- **Don't cross-scope.** `git.chunk.*` signal's `confidence.support` resolves to
  `git.chunk.*` only. Need file-level support for chunk-level signal → write
  follow-up spec.
- **Don't use `pN` string without `fallback`.** Unresolvable rules silence to
  `whenSupportBelow: 0` (never fire) — equivalent to "no clamp" for that bin.
  Always provide static floor.
- **Don't add `pN` reference without ensuring support declares N.** Either add
  `pN` to support's `stats.labels` keys (changes labelMap UX) OR add `N` to
  `stats.percentilesToCompute` (compute-only). `validateSignalDependencies`
  fails loud at composition if not.
- **Don't add Zod just for descriptor shape.** `contracts/` has no Zod (see
  `.claude/rules/domain-boundaries.md`). Runtime invariants live in consumer
  (resolver, reranker), not at descriptor load.
- **Don't bypass the resolver invariant.** `ceiling` references label not in
  descriptor's `labels` map → fail loud — never silently fall back to next label
  or no-op.

## Cross-references

- Spec (score/label clamp design):
  `docs/superpowers/specs/2026-05-14-bugfixrate-label-confidence-design.md`
- Spec (lazy recompute):
  `docs/superpowers/specs/2026-05-15-lazy-percentile-recompute-design.md`
- Plan:
  `docs/superpowers/plans/2026-05-14-hotspot-signal-interpretation-impl.md`
- Anti-pattern for agents reading confidence-aware overlays:
  `.claude-plugin/tea-rags/rules/references/signal-interpretation.md` →
  "Interpretation anti-patterns" #8
- Pattern entry triggered by confidence-clamped labels:
  `.claude-plugin/tea-rags/rules/references/signal-interpretation.md` →
  "Architectural patterns catalog" → "Fragile silo"
- Custom rerank recipe inheriting unified dampening:
  `.claude-plugin/tea-rags/rules/references/use-cases.md` → "Fragile Silo
  discovery"
- Domain layer rule (why no Zod in contracts/):
  `.claude/rules/domain-boundaries.md`
- Validation entry point: `validateSignalDependencies` in
  `src/core/domains/ingest/infra/collection-stats.ts` — wired in
  `src/core/api/internal/composition.ts`

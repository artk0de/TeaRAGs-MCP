# Signal Confidence (MANDATORY for new ratio/aggregate signals)

> **Status:** Operative. All 7 derived signals (`BugFixSignal`,
> `VolatilitySignal`, `RecentActivityConcentrationSignal`, `DensitySignal`,
> `RelativeChurnNormSignal`, `KnowledgeSiloSignal`, `OwnershipSignal`) are
> migrated to the unified `stats.confidence` mechanism. The legacy
> `dampeningSource` / `FALLBACK_THRESHOLD` / `DampeningConfig` /
> `GIT_FILE_DAMPENING` types and constants have been removed. New signals MUST
> use the unified block.

## What it is

`SignalConfidence` (defined in `src/core/contracts/types/trajectory.ts`) is a
per-signal declaration that lives on `PayloadSignalDescriptor.stats.confidence`.
It carries ONE source of truth that both the reranker score path AND the label
overlay path read.

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
  derived-signal contribution to ranking. The reranker resolves `k` in this
  priority order:
  1. **Adaptive** — `ctx.dampeningThreshold` (the support signal's
     `adaptivePercentile` value, read from collection stats).
  2. **Floor** — `confidence.score.threshold` (descriptor-static).
  3. **FALLBACK_K** — defensive constant on the derived signal class.
- **Label path** — walks `label.rules` ascending by resolved `whenSupportBelow`;
  first matching rule caps the overlay label at `ceiling`. Raw `value` in
  overlay is preserved.

## Adaptive thresholds

Both `confidence.score.adaptivePercentile` AND
`confidence.label.rules[].whenSupportBelow: "pN"` resolve dynamically from
collection stats at query time:

- `score.adaptivePercentile: 25` → reranker reads
  `git.file.{support}.percentiles[25]` from collection stats and uses it as the
  dampening k. Defaults to 25 when omitted (backwards compat with legacy
  `GIT_FILE_DAMPENING.percentile=25`).
- `whenSupportBelow: "p10"` → label resolver reads
  `git.{scope}.{support}.percentiles[10]` from collection stats. Resolved BEFORE
  the rules are walked (`Reranker.preResolveConfidenceClamp`).
- `fallback: <number>` on the rule — REQUIRED with `pN` strings. Used when
  collection stats lack the percentile (stale index — descriptor added a `pN`
  ref after last full reindex). Without fallback, an unresolvable rule is
  silenced (`whenSupportBelow: 0`, never fires).

### Validation contract (`validateSignalDependencies`)

For every `pN` referenced by any descriptor's
`confidence.score.adaptivePercentile` or
`confidence.label.rules[].whenSupportBelow`, the **support signal MUST declare
N** — either as a `pN` key in `stats.labels` OR as a number in
`stats.percentilesToCompute`.

`validateSignalDependencies` (in `src/core/domains/ingest/collection-stats.ts`)
walks all descriptors at composition time and throws if any reference is
unwired. Loud failure at startup — never silent fallback in production.

`percentilesToCompute` declares percentiles to compute at index time beyond what
the signal's own `labels` keys imply. Example:

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

### Lazy recompute (future, per spec)

If a descriptor's `pN` reference passes validation (it's declared on the
support) BUT collection stats don't yet contain that percentile (stale index —
`percentilesToCompute` was added after the last full reindex), the system can
lazily recompute the missing percentile via Qdrant scroll and PERSIST it back to
stats-cache without re-running the whole index.

Spec: `docs/superpowers/specs/2026-05-15-lazy-percentile-recompute-design.md`.
**Critical invariant** for the lazy recompute: partial update preserves ALL
other `SignalStats` fields (`count`, `min`/`max`, `mean`, `stddev`, other
percentiles). Only the missing `percentiles[N]` is added.

Until the lazy-recompute service ships, stale-index cases fall back to
`rule.fallback` (label path) or `confidence.score.threshold` (score path).
Force-reindex restores full adaptive behavior.

## When to declare `confidence`

Decide per raw signal at descriptor-declaration time. A signal needs a
`confidence` block when **any** of the following holds:

| Trigger                                                                                      | Why                                                        |
| -------------------------------------------------------------------------------------------- | ---------------------------------------------------------- |
| Signal is a **ratio** (`X / Y` where Y is stored as a separate signal)                       | Small denominator makes the ratio statistically unreliable |
| Signal is an **aggregate over a small count** (timing variance, weighted decay over commits) | <3 data points → noise dominates structure                 |
| Derived signal class currently calls `confidenceDampening(supportValue, k)` in `extract`     | Pre-existing pattern; migrate to declarative block         |
| Overlay label is misread by agents on small-N cases                                          | Empirical: agent over-weights `"critical"` label for N=2   |

If **none** apply, omit `confidence`. Most signals don't need it (e.g.
`commitCount` itself, `ageDays`, raw `imports`).

## Choosing `support`

`support` is a **bare sibling name** — the same-scope payload field that acts as
the statistical denominator. Examples:

| Signal                    | Support         | Reason                                                                  |
| ------------------------- | --------------- | ----------------------------------------------------------------------- |
| `bugFixRate`              | `commitCount`   | `bugFixRate = bugFixCommits / commitCount`                              |
| `churnVolatility`         | `commitCount`   | timing variance over commits                                            |
| `recencyWeightedFreq`     | `commitCount`   | weighted sum needs ≥3 commits                                           |
| `relativeChurn`           | `commitCount`   | churn count normalized by file size                                     |
| `blameDominantAuthorPct`  | `commitCount`\* | legacy migration — semantically `blameContributorCount` may fit better  |
| `recentDominantAuthorPct` | `commitCount`\* | analogous; migrated from `GIT_FILE_DAMPENING` for numerical equivalence |

\* Some signals' support choice is a migration artifact: legacy
`GIT_FILE_DAMPENING` used `commitCount` for ALL signals regardless of semantic
fit. Ownership-flavor signals arguably want `blameContributorCount` support —
proposed in follow-up. Don't change support without numerical-equivalence
regression.

Resolution is **same-scope only**. A `git.chunk.bugFixRate` descriptor with
`support: "commitCount"` resolves to `git.chunk.commitCount` (not file).
Cross-scope reads are explicitly **out of scope** for the current mechanism.

## `score` vs `label` — when to use each

The two sub-blocks are independent. Mix and match per signal need:

| Pattern                           | Score | Label | Example                                                                           |
| --------------------------------- | ----- | ----- | --------------------------------------------------------------------------------- |
| **Both** (most common for ratios) | yes   | yes   | `bugFixRate` — dampen rank contribution AND clamp overlay label                   |
| **Score only**                    | yes   | no    | All 6 migrated signals — score dampening preserved, no label clamp declared       |
| **Label only**                    | no    | yes   | Signal isn't fed into derived ranking but overlay label needs sample-size honesty |
| **Neither**                       | no    | no    | Then don't declare `confidence` at all — empty block has no semantic              |

## Picking threshold values

### `score.threshold` (static floor)

Used as `k` in `confidenceDampening(n, k) = min((n/k)^2, 1)` ONLY WHEN adaptive
isn't available (no collection stats). Smaller `k` = less dampening; larger `k`
= more aggressive suppression of small-N.

- **`k = 5`** — light dampening; pattern-following for signals where ≥3 data
  points is meaningful (ownership signals).
- **`k = 8`** — medium dampening (`VolatilitySignal` uses this).
- **`k = 10`** — standard for ratio signals like `bugFixRate` where N≥10
  stabilizes the ratio.
- **`k = 20+`** — heavy dampening; reserved for very noisy aggregates.

Adaptive (`adaptivePercentile`) usually wins over `threshold`; the static value
is the floor only.

### `score.adaptivePercentile` (which percentile to use as adaptive k)

Percentile of the support signal (file-scope) used as adaptive `k`. Default: 25
(matches legacy `GIT_FILE_DAMPENING.percentile=25`).

### `label.rules[].whenSupportBelow` (clamp thresholds)

Two forms:

- **Static**: `number`. Used as-is.
- **Adaptive**: `"pN"` string. Resolves to
  `git.{scope}.{support}.percentiles[N]` via collection stats at query time.
  **Requires `fallback: number`** — used when collection stats unavailable.

Rules are walked ascending by RESOLVED numeric threshold. First match wins.
Convention: at most 2-3 rules per signal. Example for `bugFixRate`:

```ts
rules: [
  { whenSupportBelow: "p10", fallback: 5, ceiling: "healthy" }, // tightest clamp
  { whenSupportBelow: "p25", fallback: 10, ceiling: "concerning" }, // moderate clamp
];
// commitCount >= resolved-p25 → no clamp, full label severity
```

`ceiling` MUST be a value present in the same descriptor's `labels` map.
Resolver throws if not — caught at first use, not at descriptor load (no Zod in
`contracts/`).

## What NOT to do

- **Don't declare `confidence` without a real consumer.** Empty `score`+`label`
  blocks pollute descriptor introspection. Omit entirely.
- **Don't duplicate parameters across raw and derived layers.** The block lives
  ONLY on the raw descriptor. Derived signals consume via `ExtractContext`,
  never re-declare `support` or `threshold`.
- **Don't cross-scope.** A `git.chunk.*` signal's `confidence.support` resolves
  to `git.chunk.*` only. If you need file-level support for a chunk-level
  signal, write a follow-up spec.
- **Don't use a `pN` string without `fallback`.** Unresolvable rules silence to
  `whenSupportBelow: 0` (never fire) — equivalent to "no clamp" for that bin.
  Always provide a static floor.
- **Don't add a `pN` reference without ensuring the support declares N.** Either
  add `pN` to the support's `stats.labels` keys (changes labelMap UX) OR add `N`
  to `stats.percentilesToCompute` (compute-only). `validateSignalDependencies`
  fails loud at composition if not.
- **Don't add Zod just for descriptor shape.** `contracts/` has no Zod (see
  `.claude/rules/domain-boundaries.md`). Runtime invariants live in the consumer
  (resolver, reranker), not at descriptor load.
- **Don't bypass the resolver invariant.** When `ceiling` references a label not
  in the descriptor's `labels` map, fail loud — never silently fall back to the
  next label or no-op.

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
  `src/core/domains/ingest/collection-stats.ts` — wired in
  `src/core/api/internal/composition.ts`

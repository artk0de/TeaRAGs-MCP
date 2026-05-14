# Signal Confidence (MANDATORY for new ratio/aggregate signals)

> **Status:** This rule becomes operative after the unified `confidence` block
> ships (epic `tea-rags-mcp-vpn6`, plan
> `docs/superpowers/plans/2026-05-14-hotspot-signal-interpretation-impl.md`).
> Until Task 5 of that plan closes, the legacy
> `dampeningSource`/`FALLBACK_THRESHOLD` pattern remains exported with a
> `@deprecated` notice. New signals MUST use the unified block; legacy
> signals follow the deprecation path.

## What it is

`SignalConfidence` (defined in `src/core/contracts/types/trajectory.ts`)
is a per-signal declaration that lives on
`PayloadSignalDescriptor.stats.confidence`. It carries ONE source of
truth that both the reranker score path AND the label overlay path read.

```ts
{
  key: "git.file.bugFixRate",
  stats: {
    labels: { p50: "healthy", p75: "concerning", p95: "critical" },
    confidence: {
      support: "commitCount",            // bare sibling name, same-scope
      score: { threshold: 10 },          // continuous dampening (k)
      label: {
        rules: [
          { whenSupportBelow: 5,  ceiling: "healthy"    },
          { whenSupportBelow: 10, ceiling: "concerning" },
        ],
      },
    },
  },
}
```

Two consumers, one declaration:

- **Score path** — `confidenceDampening(supportValue, score.threshold)`
  attenuates derived-signal contribution to ranking when support is
  small. Replaces per-signal-class `dampeningSource` +
  `FALLBACK_THRESHOLD` constants.
- **Label path** — walks `label.rules` ascending by `whenSupportBelow`;
  first matching rule caps the overlay label at `ceiling`. Raw `value`
  in overlay is preserved.

## When to declare `confidence`

Decide per raw signal at descriptor-declaration time. A signal needs a
`confidence` block when **any** of the following holds:

| Trigger | Why |
|---------|-----|
| Signal is a **ratio** (`X / Y` where Y is stored as a separate signal) | Small denominator makes the ratio statistically unreliable |
| Signal is an **aggregate over a small count** (timing variance, weighted decay over commits) | <3 data points → noise dominates structure |
| Existing code uses `confidenceDampening(supportValue, k)` in the derived signal's `extract` | Pre-existing pattern; migrate to declarative block |
| Overlay label is misread by agents on small-N cases | Empirical: agent over-weights `"critical"` label for N=2 |

If **none** apply, omit `confidence`. Most signals don't need it (e.g.
`commitCount` itself, `ageDays`, raw `imports`).

## Choosing `support`

`support` is a **bare sibling name** — the same-scope payload field
that acts as the statistical denominator. Examples:

| Signal | Support | Reason |
|--------|---------|--------|
| `bugFixRate` | `commitCount` | `bugFixRate = bugFixCommits / commitCount` |
| `churnVolatility` | `commitCount` | timing variance over commits |
| `recencyWeightedFreq` | `commitCount` | weighted sum needs ≥3 commits |
| `relativeChurn` | `commitCount` | churn count normalized by file size |
| `blameDominantAuthorPct` | `blameContributorCount` | 100% over 1 author ≠ "silo" |
| `recentDominantAuthorPct` | `recentContributorCount` | analogous for recent activity |

Resolution is **same-scope only**. A `git.chunk.bugFixRate` descriptor
with `support: "commitCount"` resolves to `git.chunk.commitCount` (not
file). Cross-scope reads are explicitly **out of scope** for the
current mechanism — propose a follow-up if needed.

## `score` vs `label` — when to use each

The two sub-blocks are independent. Mix and match per signal need:

| Pattern | Score | Label | Example |
|---------|-------|-------|---------|
| **Both** (most common for ratios) | yes | yes | `bugFixRate` — dampen rank contribution AND clamp overlay label |
| **Score only** | yes | no | Signal contributes to ranking but isn't surfaced as a labeled overlay row |
| **Label only** | no | yes | Signal isn't fed into derived ranking but its overlay label needs sample-size honesty |
| **Neither** | no | no | Then don't declare `confidence` at all — empty block has no semantic |

## Picking threshold values

### `score.threshold` (continuous k)

Used in `confidenceDampening(n, k) = min((n/k)^2, 1)`. Smaller `k` =
less dampening; larger `k` = more aggressive suppression of small-N.

- **`k = 5`** — light dampening; pattern-following for signals where
  ≥3 data points is meaningful (ownership signals, derivations from
  blame).
- **`k = 8-10`** — medium dampening; standard for ratio signals like
  `bugFixRate` where N≥10 stabilizes the ratio.
- **`k = 20+`** — heavy dampening; reserved for very noisy aggregates
  where small samples are systematically misleading.

Match the value to the signal's small-N profile. If a signal already
uses `FALLBACK_THRESHOLD = N` in its derived class, copy that N here.

### `label.rules[].whenSupportBelow` (categorical thresholds)

Rules are walked ascending. First match wins. Convention: at most
2-3 rules per signal. Example for `bugFixRate`:

```ts
rules: [
  { whenSupportBelow: 5,  ceiling: "healthy"    },  // demote noise to harmless (lowest label in bugFixRate map)
  { whenSupportBelow: 10, ceiling: "concerning" },  // moderate-N: cap at concerning
]
// commitCount >= 10 → no clamp, full label severity
```

`ceiling` MUST be a value present in the same descriptor's `labels`
map. Resolver throws `LabelClampInvariantError` if not — caught at
first use, not at descriptor load (no Zod in `contracts/` per
`.claude/rules/domain-boundaries.md`).

## Migration from `dampeningSource` / `FALLBACK_THRESHOLD`

Legacy signals (`BugFixSignal`, `VolatilitySignal`,
`RecentActivityConcentrationSignal`, `DensitySignal`,
`RelativeChurnNormSignal`, `KnowledgeSiloSignal`, `OwnershipSignal`)
declare these per-class constants. The migration is mechanical:

1. **Add `confidence.score`** to the raw signal's descriptor in
   `payload-signals.ts`. Pull `threshold` from the class's
   `FALLBACK_THRESHOLD`.
2. **Remove `dampeningSource` field** from the derived signal class.
3. **Remove `FALLBACK_THRESHOLD`** static.
4. **Update `extract`** to read `support` + `threshold` from
   `ExtractContext.confidence` (populated by reranker from the raw
   descriptor).
5. Verify numerical equivalence via regression test on a representative
   payload before/after refactor.

Migrate one signal per commit; don't bundle. Each migration is a tiny
commit that's easy to revert if a regression surfaces.

## What NOT to do

- **Don't declare `confidence` without a real consumer.** Empty
  `score`+`label` blocks pollute descriptor introspection. Omit
  entirely.
- **Don't duplicate parameters across raw and derived layers.** The
  block lives ONLY on the raw descriptor. Derived signals consume via
  `ExtractContext`, never re-declare `support` or `threshold`.
- **Don't cross-scope.** A `git.chunk.*` signal's `confidence.support`
  resolves to `git.chunk.*` only. If you need file-level support for
  a chunk-level signal, write a follow-up spec — don't hack around
  the convention.
- **Don't add Zod just for descriptor shape.** `contracts/` has no
  Zod (see `.claude/rules/domain-boundaries.md`). Runtime invariants
  live in the consumer (resolver, reranker), not at descriptor load.
- **Don't bypass the resolver invariant.** When `ceiling` references
  a label not in the descriptor's `labels` map, fail loud — never
  silently fall back to the next label or no-op.

## Cross-references

- Spec: `docs/superpowers/specs/2026-05-14-bugfixrate-label-confidence-design.md`
- Plan: `docs/superpowers/plans/2026-05-14-hotspot-signal-interpretation-impl.md`
- Anti-pattern for agents reading confidence-aware overlays:
  `.claude-plugin/tea-rags/rules/references/signal-interpretation.md`
  → "Interpretation anti-patterns" #8 (class-level small-N rule)
- Pattern entry triggered by confidence-clamped labels:
  `.claude-plugin/tea-rags/rules/references/signal-interpretation.md`
  → "Architectural patterns catalog" → "Fragile silo"
- Custom rerank recipe inheriting unified dampening:
  `.claude-plugin/tea-rags/rules/references/use-cases.md`
  → "Fragile Silo discovery"
- Domain layer rule (why no Zod in contracts/):
  `.claude/rules/domain-boundaries.md`
- Typed-errors convention (`LabelClampInvariantError`):
  `.claude/rules/typed-errors.md`

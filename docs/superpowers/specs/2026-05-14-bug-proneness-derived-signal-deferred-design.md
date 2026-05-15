# bugProneness Derived Signal — Design Spec (Deferred)

## Status

**Deferred.** This spec records the design for a packaged `bugProneness` derived
signal that combines `bugFix × confidenceDampening × knowledgeSilo` into a
single reusable signal. It is **not** scheduled for implementation. Trigger
condition for revisit: see Reactivation Criteria below.

The lightweight equivalent — the Fragile Silo custom rerank recipe — is the
shipping solution today (see `fragile-silo-rerank-recipe-design.md`).

## Goal

If and when Fragile Silo discovery becomes a frequent enough query that users
repeatedly copy-paste the recipe, package the same arithmetic as a named derived
signal under the git trajectory. The signal exposes a single weight key
(`bugProneness`) in `ScoringWeights`, plugs into `signal-interpretation.md`'s
catalog of derived signals, and can become the basis of a named preset later.

## Problem (when reactivated)

The Fragile Silo recipe
`{bugFix: 0.45, knowledgeSilo: 0.30, similarity: 0.15, churn: -0.10}` requires
four weight terms to express what is conceptually a single notion: _"buggy code
under a single owner that is not actively churning"_. Repetition across users
implies the composition deserves first-class naming.

## Design Decisions (preview)

### D1: Signal location

**Would-be file:**
`src/core/domains/trajectory/git/rerank/derived-signals/bug-proneness.ts`

Follows the existing pattern of `KnowledgeSiloSignal`, `OwnershipSignal`,
`BugFixSignal`. Class implements `DerivedSignalDescriptor`.

### D2: Arithmetic

```
bugProneness =
  blendNormalized(bugFixRate)             // dampened by commitCount via the
                                          // unified confidence block on the
                                          // bugFixRate raw descriptor
                                          // (declared in spec 3, D5+D8)
  * knowledgeSiloFactor(blameContributorCount)
```

Where `knowledgeSiloFactor` mirrors `KnowledgeSiloSignal`: `1.0` for solo, `0.5`
for pair, `0.0` for 3+ owners. Multiplication (not weighted sum) is deliberate —
Fragile Silo requires **both** factors to be present. Weighted sum would let
high `bugFix` alone score high, defeating the point.

**No standalone `confidenceDampening` call.** After spec 3 lands, the dampening
of `bugFixRate` by `commitCount` is declared once on the raw `bugFixRate`
descriptor (`stats.confidence.score.threshold = 10`) and applied uniformly by
the reranker's derived-signal extraction path. `bugProneness` inherits the
dampened value through `blendNormalized` and does NOT duplicate the
`support: "commitCount"` / `threshold: 10` parameters. If `bugProneness` ever
needs an additional confidence axis (e.g. dampen by `blameContributorCount`
reliability), it would declare its own `confidence` block on a NEW raw signal it
consumes — never re-declare parameters already owned by `bugFixRate`.

### D3: Registration

Add to `gitSignals[]` in `src/core/domains/trajectory/git/signals.ts`. Export
from `src/core/domains/trajectory/git/rerank/derived-signals/index.ts`. Extend
`ScoringWeights` type in `src/core/contracts/types/provider.ts` with
`bugProneness?: number`.

### D4: Optional named preset

Once the signal exists, an optional `FragileSiloPreset` becomes trivial:

```ts
weights: { similarity: 0.25, bugProneness: 0.55, churn: -0.10, blockPenalty: -0.10 }
```

Adds `rerank: "fragileSilo"` to the public API and replaces the custom recipe in
user-facing docs.

### D5: Migration

None on payload — `bugProneness` is derived at rank time from existing raw
signals (`bugFixRate`, `commitCount`, `blameContributorCount`).

## Reactivation Criteria

This spec moves to active when **any one** of:

1. **Recipe usage volume.** Three or more distinct user reports / bug issues /
   community questions reference the Fragile Silo recipe within a quarter.
   Tracking signal: GitHub Discussions, beads issues tagged `fragile-silo`,
   support channel mentions.
2. **Risk-assessment integration request.** If risk-assessment skill roadmap
   calls for Fragile Silo as a standing risk lens (parallel to
   `hotspots`/`ownership`/`techDebt`), a named preset is required. Custom
   recipes do not compose into the risk-assessment converge step.
3. **External preset proliferation.** If two or more downstream plugins define
   their own Fragile-Silo-equivalent presets, consolidate by shipping the signal
   in core.

When any criterion fires, this spec graduates from "Deferred" to active, plan is
written, and implementation proceeds.

## Out of Scope (now and at reactivation)

- Replacing the Fragile Silo custom recipe automatically — the recipe remains
  documented as the fallback for users who want the composition unbundled.
- Cross-trajectory signal — `bugProneness` is git-only; no static trajectory
  equivalent.
- File-only or chunk-only scoping — the signal works at both, like
  `BugFixSignal`.

## Acceptance Criteria (at reactivation)

1. `BugPronenessSignal` class registered in git trajectory.
2. `ScoringWeights.bugProneness` field added.
3. Unit tests cover: small-N suppression, solo vs pair vs crowd reduction,
   monotonicity in bugFixRate.
4. `signal-interpretation.md` "Custom rerank weights" section gains a
   `bugProneness` row.
5. `use-cases.md` Fragile Silo recipe is updated to use `bugProneness` alone,
   with the explicit four-term recipe kept as "manual equivalent" footnote for
   transparency.

## Plugin Version Bump (at reactivation)

`tea-rags` plugin — **minor** bump if the named preset ships too, **patch** if
only the signal and the recipe doc update.

## Effort (at reactivation)

~1 day. Most of it is the test matrix (small-N, ownership-tier, and
ratio-extremity combinations).

## Why Defer, Not Reject

The arithmetic in D2 is **already correct** — `BugFixSignal` already applies
`confidenceDampening`, `KnowledgeSiloSignal` already encodes ownership tiers.
Packaging them as one signal is mechanical, not novel. Premature packaging
without evidence of demand violates YAGNI; rejection would lose the documented
design once demand materializes.

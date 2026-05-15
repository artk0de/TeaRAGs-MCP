# Confidence-Aware Signal Reading — Anti-Pattern Rule — Design Spec

> **Note on filename.** The file slug `small-n-bugfixrate-anti-pattern` is
> retained for git-history continuity from the initial commit. The actual scope
> of this spec is **broader**: the rule applies to any signal whose raw
> descriptor declares `stats.confidence` (the unified mechanism from
> `bugfixrate-label-confidence-design.md`). `bugFixRate` is the documented first
> example.

## Goal

Add an interpretation anti-pattern to `signal-interpretation.md` that
generalizes the small-N caution across **all signals declared as
confidence-aware** under the unified `stats.confidence` mechanism (see spec 3).
The rule tells the agent: any signal whose descriptor names a `support` sibling
has reduced reliability when that sibling is low — treat the label as
suggestive, not diagnostic, regardless of whether the structural clamp from spec
3 has fired.

Doc-only spec; complements but does not depend on the unified confidence code
fix.

## Problem

`signal-interpretation.md` has seven existing anti-patterns covering high-churn,
mono-ownership, high-age, high-fan-in, bugFixRate × imports combinations, hybrid
patterns, and single-signal classifications. The catalog has **no** rule about
sample-size reliability of ratio-derived or count-derived signals as a class.

User's trigger case demonstrates the gap: an agent saw `bugFixRate=63 critical`
for a file with `commitCount=3`, treated the label as diagnostic, and classified
the file as a hotspot. The structural fix lives in
`bugfixrate-label-confidence-design.md` (unified `confidence` block with
`support` + `label.rules`). But three gaps remain that doc-only rule closes:

1. **Until spec 3 ships**, agents continue to over-read raw labels with no clamp
   at all.
2. **After spec 3 ships**, the raw `value: 63` is visible in overlay alongside
   the clamped label. An agent reading the value (not the label) reproduces the
   same misclassification.
3. **Catalog should state the principle as a class.** Spec 3 makes the mechanism
   generic — any signal can opt in with one descriptor block. The interpretation
   rule must match that generality, so future confidence-aware signals
   (`churnVolatility`, `relativeChurn`, `recencyWeightedFreq`,
   `blameDominantAuthorPct`, `recentDominantAuthorPct`, chunk-scope equivalents)
   are covered by the same documented anti-pattern without per-signal
   duplication.

## Design Decisions

### D1: Add anti-pattern #8 to `signal-interpretation.md`

**File:** `.claude-plugin/tea-rags/rules/references/signal-interpretation.md`,
section "Interpretation anti-patterns" (currently 7 entries).

Add as item 8 — class-level rule with `bugFixRate` as worked example:

```markdown
8. **"label severity = signal severity"** — incomplete when the signal declares
   a `stats.confidence` block. Any signal whose descriptor names a `support`
   sibling (`bugFixRate → commitCount`,
   `blameDominantAuthorPct → blameContributorCount`, etc.) is a ratio or
   aggregate whose reliability depends on that sibling. When `support` is low,
   the label and the raw value mean **less** than identical values with high
   support — small-sample noise looks like structural signal.

   Concrete: with `commitCount=3` and 2 fix commits, `bugFixRate = 67%` looks
   identical to `200/300 = 67%`. The first is noise; the second is structural.
   The overlay's label is auto-clamped to a less-severe bin when `support` is
   below the descriptor's threshold (see
   `bugfixrate-label-confidence-design.md`), but if you read the raw `value`
   directly, you must apply this rule yourself.

   **How to read confidence-aware signals:**
   - **Always pair the signal's label with its `support` sibling's label.** If
     `support` is `low` or below the signal's stated thresholds → treat the
     signal's value/label as suggestive only. Use it to _ask_ "is this worth a
     closer look?", not to conclude.
   - **`support` typical+ → trust the label.** The structural fix has left the
     label as-is because the sample is large enough.
   - **Discoverability:** the per-signal `confidence` block is published via the
     index-metrics resource — `support` field name and threshold rules are
     introspectable. Don't guess; look up.

   Examples of confidence-aware signals (current set will grow): `bugFixRate`
   (support `commitCount`), `blameDominantAuthorPct` (support
   `blameContributorCount`), `recentDominantAuthorPct` (support
   `recentContributorCount`). The full set is the union of raw signal
   descriptors carrying `stats.confidence`.
```

### D2: Keep the worked example concrete

The rule is class-level, but the worked example uses `bugFixRate` +
`commitCount` because that is the only signal initially opting in (per spec 3)
and the documented failure mode. Examples are illustrative, not exhaustive —
adding new confidence-aware signals does NOT require amending this rule, only
updating the example list at the end of the bullet when it grows substantively.

### D3: Cross-link to design specs

Inline links inside the bullet:

- to `bugfixrate-label-confidence-design.md` for the structural unified
  `confidence` mechanism (label clamp + score dampening)
- to `fragile-silo-pattern-design.md` (Disambiguators section) where the same
  rule appears scoped to one pattern

### D4: No reordering of existing anti-patterns

Items 1-7 are preserved. The new item is #8 at the end. Reordering would break
any external doc that cites these by number.

### D5: Eventual auto-generation (deferred)

Once `confidence` blocks are widely declared and the published index-metrics
resource exposes them, the worked-example list in this anti-pattern can be
regenerated from descriptors instead of being hand-maintained. Out of scope for
this spec — flagged so future contributors don't accidentally drift the example
list from reality.

## Out of Scope

- Code changes — fully captured in `bugfixrate-label-confidence-design.md`.
- Visual marker on clamped labels — UX decision, not interpretation.
- Auto-generation of the example list from descriptors — D5 deferred.
- Per-signal anti-pattern entries — the rule is class-level; signal-specific
  guidance lives in pattern entries (e.g. Fragile silo Disambiguators) or in the
  descriptor's own `confidence` block, not here.

## Acceptance Criteria

1. `signal-interpretation.md` has 8 anti-patterns; #8 is class-level ("any
   signal with `stats.confidence` declared has reduced reliability when support
   is low") with `bugFixRate` as the worked example.
2. Cross-links resolve: to `bugfixrate-label-confidence-design.md` and to
   `fragile-silo-pattern-design.md`.
3. Items 1-7 are untouched (no renumbering).
4. The bullet does NOT enumerate every confidence-aware signal as a permanent
   list — it cites `bugFixRate` as worked example plus a "current set" pointer
   to the index-metrics resource for the authoritative enumeration.

## Plugin Version Bump

`tea-rags` plugin — **patch** bump. Text-only change to an existing rule file,
no new skill or rule file.

## Effort

20 minutes. Slightly more than the original (15 min) due to the class-level
framing requiring careful phrasing — the worked example must stay concrete
enough that an agent reading the rule cold can apply it immediately, while the
class-level wording must cover future confidence-aware signals without future
amendment.

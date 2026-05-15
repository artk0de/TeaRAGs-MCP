# Fragile Silo Pattern — Design Spec

## Goal

Give a name and a remediation to the architectural pattern that catches
"stable-looking code with high bug-fix history owned by a single author" —
currently a gap in tea-rags's `signal-interpretation.md` catalog and
`classification-tiers.md` tier list. Adds one pattern to the catalog (file
`signal-interpretation.md`) and one tier to the 13-tier risk table (file
`classification-tiers.md`).

## Problem

User-reported case from external project:

| Signal                   | Value | Label               |
| ------------------------ | ----- | ------------------- |
| `commitCount`            | 3     | typical             |
| `ageDays`                | 21    | recent              |
| `changeDensity`          | 0.31  | calm                |
| `recencyWeightedFreq`    | 0.11  | normal              |
| `bugFixRate`             | 63    | **critical**        |
| `blameDominantAuthorPct` | 99    | **deep-silo**       |
| `taskIds`                | 3     | all bug-fix tickets |

The file falls through every existing tier in `classification-tiers.md`:

- **Bug attractor** requires `churn high+` — fails (low commitCount).
- **Fragile legacy** requires `ageDays legacy` — fails (21 days, "recent"
  label).
- **Toxic silo** requires `(churn high OR ageDays legacy)` — fails (both low).
- **Healthy owner** requires `bugFixRate=healthy` — fails (critical).

The risk is **real** but **uncatalogued**: regression risk on stable-looking
code with bad bug-history, single point of knowledge. Different remediation from
any existing tier — pair review and regression-suite hardening, **not** merge
coordination, **not** strangler rewrite, **not** decoupling.

## Design Decisions

### D1: Pattern name — "Fragile Silo"

Working name: **Fragile Silo**. Alternatives considered:

- _Buggy lurker_ — too informal for a catalog
- _Bug-prone silo_ — accurate but verbose; "fragile" carries the same meaning
  more concisely
- _Quiet hotspot_ — confuses the recently-tightened definition of "hotspot"

"Fragile" is already in the catalog vocabulary (`Fragile legacy`); "Silo" is the
established term for single-author ownership. Composition is unambiguous.

### D2: Pattern entry in `signal-interpretation.md`

**File:** `.claude-plugin/tea-rags/rules/references/signal-interpretation.md`

Add to the "Architectural patterns catalog" section (after `Toxic silo`, before
`Healthy owner` — sibling to ownership-driven patterns):

```markdown
### Fragile silo

**Signature:**
`blameDominantAuthorPct silo+ + bugFixRate concerning+ + churn typical/low + ageDays typical/recent`

**What it is:** Stable-looking, low-churn module owned by a single author whose
commit history is dominated by bug fixes. Distinct from Toxic silo (requires
high churn or legacy age) and Fragile legacy (requires high age). The file does
not look like a hotspot — it has not been touched recently — but every
historical commit to it has been a regression fix. Often a domain-edge component
(calculation, invariant enforcement, data conversion) where each defect is
subtle and the silo owner is the only person who knows the invariants.

**Remediation:**

- Regression-suite hardening on the silo owner's invariants before any change.
- Pair review on touch — the silo owner co-reviews any external change.
- NOT merge coordination (no merge contention — file is calm).
- NOT strangler rewrite (no legacy debt — file is recent).

**Disambiguators:**

- **Confidence-clamped label suppresses small-N matches automatically.** Once
  the unified `stats.confidence` mechanism ships (see
  `bugfixrate-label-confidence-design.md`), `bugFixRate.label` for files with
  `commitCount < 5` is clamped to `typical` and `< 10` to `concerning`.
  Consequence: a noise-only file (e.g. 2 fix commits out of 3) does NOT satisfy
  the `bugFixRate concerning+` floor of this signature — it gets `typical` and
  falls out of Fragile Silo. This is correct behavior; classification into a
  real risk tier should require structural evidence, not small-N noise.
- **Edge band `commitCount` 5..9.** Raw `bugFixRate` ≥ critical threshold gets
  clamped to `concerning`, which DOES match the signature. Mark such
  classifications as "moderate confidence" in risk reports — the evidence is
  structural enough to fire the tier, but support is at the low end of the
  confident range.
- **If reading raw values rather than labels:** apply anti-pattern #8 from
  `signal-interpretation.md` (class-level small-N rule for any confidence-aware
  signal). Don't conclude "Fragile Silo" from raw `value: 63%` alone if
  `commitCount < 5`.
- **Upgrade paths:** if `bugFixRate concerning+` AND `commitCount high+` →
  upgrade to **Bug attractor** when `imports ↓`, or **Toxic silo** when churn
  rises with it.
```

### D3: Tier entry in `classification-tiers.md`

**File:**
`.claude-plugin/tea-rags/skills/risk-assessment/references/classification-tiers.md`

Add row to the 13-tier table (becomes 14 tiers):

```markdown
| **Fragile silo** | `blameDominantAuthorPct.label ∈ {silo, deep-silo}` AND
bugFixRate concerning+ AND churn typical/low AND ageDays typical/recent |
```

Position: between `Toxic silo` and `Healthy owner` (groups all silo-derived
tiers together).

### D4: Risk classification — High, not Critical

In risk-assessment Phase 4 ENRICH classification:

- **High** by default (real risk, requires action before touching).
- **Critical** only when combined with one of: `Untested hotspot` (no test
  file), `imports ↑` (changes propagate downstream), or `commitCount high+`
  (upgrade to Bug attractor).

This prevents Critical-flood on every silo file in mature codebases.

### D5: Cross-references

Add bidirectional links:

- In `signal-interpretation.md` "Architectural patterns catalog" → at the top of
  `Toxic silo`, add: _"For low-churn silo with bug-history, see Fragile silo
  below."_
- In `Fragile legacy` → add at end: _"For recent code with similar bug-history
  signature, see Fragile silo."_

## Out of Scope

- Confidence on `bugFixRate.label` itself →
  `bugfixrate-label-confidence-design.md`.
- Anti-pattern rule about reading small-N bugFixRate →
  `small-n-bugfixrate-anti-pattern-design.md`.
- Custom rerank weights to _find_ Fragile Silo files →
  `fragile-silo-rerank-recipe-design.md`.
- New derived signal `bugProneness` →
  `bug-proneness-derived-signal-deferred-design.md`.

## Acceptance Criteria

1. `signal-interpretation.md` catalog contains a `Fragile silo` section with
   Signature, What it is, Remediation, Disambiguators.
2. `classification-tiers.md` 13-tier table is now 14-tier with Fragile silo row
   in correct position.
3. Cross-references from Toxic silo and Fragile legacy point to the new entry.
4. The user's trigger file (`update_package_invoice.rb` signals from the
   brainstorm) maps unambiguously to Fragile silo and to no other tier.

## Plugin Version Bump

`tea-rags` plugin — **minor** bump (new rule content, behavior-affecting from
agent perspective).

## Effort

~30 minutes of careful prose. Hardest part: making sure the disambiguator rule
covers the small-N case without preempting the labelMap confidence fix (spec 3)
which is the proper structural solution.

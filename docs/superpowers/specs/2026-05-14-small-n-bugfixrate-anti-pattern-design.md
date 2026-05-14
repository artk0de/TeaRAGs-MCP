# Small-N bugFixRate Anti-Pattern Rule — Design Spec

## Goal

Add an explicit interpretation anti-pattern to `signal-interpretation.md` that
warns the agent: a `concerning+` or `critical` `bugFixRate` label with low
`commitCount` is statistically unreliable — treat as suggestive, not diagnostic.
Doc-only spec; complements but does not depend on the label-confidence code fix.

## Problem

`signal-interpretation.md` has seven existing anti-patterns covering high-churn,
mono-ownership, high-age, high-fan-in, bugFixRate × imports combinations, hybrid
patterns, and single-signal classifications. The catalog has **no** rule about
sample-size reliability of `bugFixRate` itself.

User's trigger case demonstrates the gap: an agent saw `bugFixRate=63 critical`
for a file with `commitCount=3`, treated the label as diagnostic, and classified
the file as a hotspot. The structural fix lives in
`bugfixrate-label-confidence-design.md` (label clamp by N). But:

- Until the clamp ships, agents continue to over-read raw labels.
- Even after the clamp ships, the raw `value: 63` is visible in overlay
  alongside the clamped label. An agent reading the value (not the label)
  reproduces the same misclassification.
- The catalog should explicitly state the principle, not just rely on the
  binning logic. Other small-N-sensitive signals (`recencyWeightedFreq`,
  `churnVolatility`) follow the same rule, and the catalog reader is the one who
  applies it.

## Design Decisions

### D1: Add anti-pattern #8 to `signal-interpretation.md`

**File:** `.claude-plugin/tea-rags/rules/references/signal-interpretation.md`,
section "Interpretation anti-patterns" (currently 7 entries).

Add as item 8:

```markdown
8. **"bugFixRate critical/concerning = bug-prone code"** — incomplete when
   `commitCount` is small. `bugFixRate` is a ratio; with `commitCount=3` and 2
   fix commits, ratio = 67% looks identical to 200/300 commits at 67%. The first
   is small-N noise; the second is structural. Always pair `bugFixRate.label`
   with `commitCount.label`:
   - `commitCount` low (≤ ~5) → `bugFixRate` is suggestive, not diagnostic. Use
     it to _ask_ "should I read this file?", not to conclude "this file is
     buggy".
   - `commitCount` typical+ → `bugFixRate` is structural; trust the label. The
     overlay label is clamped to `typical`/`concerning` automatically when
     `commitCount` is below threshold (see label-confidence design), but if you
     read raw `value` directly, apply this rule yourself.
```

### D2: Generalize the principle, scope the example

The rule is written specifically about `bugFixRate` because that is the
documented failure mode. A parenthetical at the end of the bullet generalizes:

```markdown
The same caution applies to any ratio-derived signal where the denominator is
also stored (`bugFixRate / commitCount`, `churnVolatility / commitCount`). Bins
assume the denominator is large enough for the ratio to be stable.
```

### D3: Cross-link to design specs

Inline links inside the bullet:

- to `bugfixrate-label-confidence-design.md` for the structural fix
- to `fragile-silo-pattern-design.md` (Disambiguators section) where the same
  rule appears scoped to one pattern

### D4: No reordering of existing anti-patterns

Items 1-7 are preserved. The new item is #8 at the end. Reordering would break
any external doc that cites these by number.

## Out of Scope

- Code changes — fully captured in `bugfixrate-label-confidence-design.md`.
- Visual marker on clamped labels — UX decision, not interpretation.
- Generalization to other signals' clamps — recorded in D2 as a parenthetical
  principle; explicit per-signal rules deferred until evidence.

## Acceptance Criteria

1. `signal-interpretation.md` has 8 anti-patterns, the new one cites sample-size
   and references the clamp design.
2. Cross-links to the two related specs render correctly in the rendered plugin
   docs.
3. Items 1-7 are untouched.

## Plugin Version Bump

`tea-rags` plugin — **patch** bump. Text-only change to an existing rule file,
no new skill or rule file.

## Effort

15 minutes.

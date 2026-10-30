# Private-corpus navigation A/B — pre-registration

Date: 2026-10-09. Committed before the first scored run. Design:
`docs/superpowers/specs/2026-10-09-private-nav-benchmark-design.md`.

## Setup

- Corpus: TaxDome monolith (private). Tasks mined from merges into `master` in
  the 6 months before the mining date, per the design's mining rules. Two strata
  axes: size (small / medium / large) × pointing (not-named: `named_frac` ≤ 0.34
  and `doc_frac` ≤ 0.34; named: the rest).
- Protocol: phase 1, localization-only (edits disallowed, final JSON answer).
- Cells: TeaRAGs {off, on} × navigators {stripped, present} = A, B, C, D.
- Agent: Claude Code headless, `claude-sonnet-5-5`, isolated
  `CLAUDE_CONFIG_DIR`, `--strict-mcp-config`. Cell order randomised per task,
  seed 20261009.
- Pilot: 3 tasks per size × pointing cell = 18 tasks, 1 run per cell = 72 runs.
  Operator veto on a seeded shortlist of ~5 per size × pointing cell; the veto
  log is part of the record.
- Plugin / prompt tuning: none on the scored tasks. Any tuning uses 3 extra
  mined tasks outside the scored set.

## Confirmatory hypotheses

Contrast C−A (TeaRAGs alone, navigators stripped), all 18 pairs:

- **H1 (tokens).** Arm 1 spends fewer total input tokens (input + cache write +
  cache read) per task. Prior from the operator's transcript study: up to −80%.
- **H2 (tool calls and time).** Arm 1 makes fewer tool calls and has shorter
  solve time. Prior: ~−75% tool calls.

Contrast D−B (TeaRAGs on top of navigators):

- **H3.** Same direction as H1 and H2, smaller magnitude than C−A.

## Descriptive (pilot n is too small to confirm)

- **H4 (replacement).** C vs B: TeaRAGs without navigators is not more expensive
  than navigators without TeaRAGs.
- **H5 (where).** The C−A token delta grows with stratum (small < medium <
  large); break-even task size against arm 1's fixed overhead.
- **H6 (pointing).** On not-named tasks the C−A saving comes mostly from search
  (fewer search/read calls before the first gold read); on named tasks it comes
  mostly from read economy (M2: lines returned per gold file). The C−A token
  delta is reported per pointing stratum.
- Covariate table: delta vs lexical overlap, layers crossed, gold file count.

## Analysis plan

- Tokens, cost, peak context, turns, tool calls, solve time: Wilcoxon
  signed-rank on paired per-task values, two-sided, plus bootstrap 95% CI (10
  000 resamples, seed 0) of the median paired ratio arm1/arm0.
- Fixed overhead (first-turn input) reported per arm; the variable part (total −
  overhead) gets the same tests.
- Recall / precision (files, symbols): paired differences with bootstrap CI;
  reported next to every cost delta. Pairs where arm 1 is cheaper and its file
  recall is lower are counted and listed.
- Adoption gate: arm-1 runs with TeaRAGs share < 0.3 are flagged; C−A and D−B
  are reported with and without flagged pairs.
- Memorisation probe on every task; hit rate reported. A file-level hit on a
  task marks it; it stays in the analysis.

## Exclusion rule

No task is dropped after its run. A run ending in `is_error`, timeout, or with
no parseable JSON answer counts as recall 0 and stays in the cost analysis with
the usage its transcript records.

## Amendment 2026-10-26 — cells A and C only

Recorded after the 3-task pilot (TD-91114, TD-93238, TD-72544; 12 runs) and
before any further scored run.

- Every later run uses cells A (TeaRAGs off) and C (TeaRAGs on), both with
  navigators stripped. Cells B and D are not run.
- H3 (D−B) and H4 (C vs B) are dropped. H1, H2, H5 and H6 stay on C−A. The
  adoption gate applies to C only.
- Reason: navigators are not a free baseline. Writing them costs research
  tokens, and they decay: 8–18% of the path references in `CLAUDE.md` at the
  pilot bases were dead (9.8% on master).
- Pilot runs in cells B and D stay in the record and are reported as pilot
  data only.

## Amendment 2026-10-26 — cell names

From here on: **A = TeaRAGs on, B = TeaRAGs off**, both with navigators
stripped. Nothing runs with navigators.

The pilot's C is stored as A and its A as B. The pilot's B and D runs
(navigators present) are archived separately and stay out of the analysis.

Hypotheses keep their meaning under the new letters. H1, H2, H5 and H6 test the
A−B contrast (formerly C−A), and the adoption gate applies to A.

## Later steps (each re-registered here before it runs)

1. +2 runs per cell on the same 18 tasks; per-cell median of 3 replaces the
   single value.
2. Expansion to 6 tasks per size × pointing cell.
3. Phase 2 (full solve) on the same manifests.

# tea-rags:data-driven-generation Optimization Benchmark

**Date:** 2026-04-21 **Eval cases:** 15

## Metrics

| Metric     | Value        |
| ---------- | ------------ |
| With-rule  | 100% (15/15) |
| Baseline   | 20% (3/15)   |
| Delta      | +80pp        |
| Iterations | 1            |

## Why this skill matters

`data-driven-generation` owns **the impact-analysis idiom**
`{imports:0.5, churn:0.3, ownership:0.2}` that propagates to 5 dinopowers
wrappers (writing-plans, executing-plans, verification-before-completion,
receiving-code-review, requesting-code-review). Eval-12 explicitly tests the
exact weights — if they drift here, downstream wrappers silently lose their
calibration.

Similarly, Step 2's proven-template weights
`{similarity:0.2, stability:0.3, age:0.3, bugFix:-0.15, ownership:-0.05}` are
the template-discovery idiom referenced by `dinopowers:test-driven-development`
(+80pp delta) and future skills.

## Failure Analysis (baseline, 12/15 FAIL)

Baseline agent handles 3 cases correctly (eval-5 autonomous judgment, eval-7
reject bad template, eval-10 shared-style). Fails on everything requiring:

1. **Named strategies** (eval-2, 3, 4) — general "be careful" vs protocol-named
   DEFENSIVE/STABILIZATION/CONSERVATIVE mapping from overlay labels
2. **Exact custom-rerank weights** (eval-6, 12) — baseline picks closest named
   preset (`proven`, `hotspots`) instead of constructing
   `{similarity:0.2, stability:0.3, age:0.3, bugFix:-0.15, ownership:-0.05}`
   with negative coefficients
3. **Non-intuitive quality gates** (eval-8) — baseline bias `new=good` defeats
   the `recent+low-commits=unproven` rule
4. **Mandatory Step 5 hallucination protocol** (eval-11, 13, 14) — baseline
   trusts tests+tsc, skips find_symbol-per-identifier verification as overkill
5. **Project-aware custom-strategy discovery** (eval-15) — baseline applies hard
   rules directly, misses `.claude/skills/strategy-*` scan
6. **Prerequisites/explore-first** (eval-1) — baseline starts with
   semantic_search instead of invoking the explore skill as formal
   area-gathering step
7. **Silo-style protocol** (eval-9) — baseline understands silo but doesn't
   invoke exact-match convention

## Delta Interpretation

+80pp is strong. The skill adds value specifically on:

- **Formalized protocol** (named strategies + numbered steps) — not derivable
  from general competence
- **Exact weights** — project idiom cannot be guessed
- **Mandatory Step 5** — overcomes the "tests pass = done" default
- **Custom-strategy discovery** — project-aware extension point

## Iteration Log

**Iteration 0:** 15/15 with-rule, 3/15 baseline (20%), delta +80pp. No fix
needed.

## Risks and follow-ups

- **Idiom weights drift**: evals 6 and 12 are regression tests for the two idiom
  weight sets. Any SKILL.md edit that touches Step 2 or Step 6 weights must
  re-run these eval cases.
- **Strategy files coverage**: 4 strategies (DEFENSIVE, STABILIZATION,
  CONSERVATIVE, STANDARD) live in `strategies/*.md` — each could have its own
  eval for signal-mapping behavior inside the strategy. Out of scope for
  Phase 2.
- **Step 5 MANDATORY under pressure**: eval-13 passes with-rule but real-world
  pressure ("hotfix, be fast") may erode. Consider adding a hotfix-pressure eval
  case.

## 2026-09-25 — naming lexicon + symbol-risk VERIFY (cases only, not run)

SKILL.md change (tea-rags 0.36.0, beads tea-rags-mcp-4p3sb.13 / .15): Step 5
STYLE gains one `get_naming_lexicon` call, Step 6 names from its vocabulary
(`NEW_TERM` justified), Step 7 VERIFY drops the identifier-existence sweep for
symbol risks via `find_symbol(rerank: "criticalPath")`.

Superseded (kept in `evals.json`, not scored):

| Case    | Superseded by                         | Reason                                            |
| ------- | ------------------------------------- | ------------------------------------------------- |
| eval-6  | `extract-project-patterns/evals.json` | Step 2 delegates template search and quality gate |
| eval-11 | `verify-symbol-risk`                  | Step 7 identifier check removed                   |
| eval-12 | `codegraph-impact/benchmark.md`       | IMPACT = blastRadius when codegraph is on (TR4)   |
| eval-13 | `naming-modify-scope`                 | Step 7 identifier check removed                   |
| eval-14 | `verify-symbol-risk`                  | Step 7 identifier check removed                   |

New cases (13): `naming-type-misfit`, `naming-second-binding-qualifier`,
`naming-callee-derived-untyped`, `naming-concept-new-term`,
`naming-concept-backedge`, `naming-new-term-justified`, `naming-conforms`,
`naming-free-dominant-role`, `naming-camelcase-language`,
`naming-codegraph-off`, `naming-modify-scope`, `verify-symbol-risk`,
`verify-central-modified`. New cases carry a `context` field — the environment
the harness sets up (prime enrichment, lexicon answer) — so the `prompt` stays
neutral user framing.

Run deferred: the with-rule vs baseline measurement waits until
`get_naming_lexicon` ships (heavy-measurement phase at the end of the epic). No
`runs[]` entry yet.

## Run 2026-10-13 — Step 7 fix-at-write loop + session-context reuse (bd 89k7k.1.19.8)

18 cases: 17 new (`step7-fix-*`, `session-reuse-*`) + rewritten
`naming-review-before-commit`. Subject model opus; with-skill arm read
SKILL.md + only the repair files its scenario loads; baseline arm saw the tool
list only. Neither arm saw `expected`.

| Metric                  | Value       |
| ----------------------- | ----------- |
| With-skill (first pass) | 89% (16/18) |
| Baseline                | 67% (12/18) |
| Delta                   | +22pp       |

Baseline (opus) already reverts regressing rounds, escalates after two rounds,
accepts a `compositionRoot` flag and refuses "by design" without evidence. The
skill's delta sits in: cheap-fixing `preExisting` + `remedy` (baseline only
reports), loading exactly the matching repair file (baseline loads none), one
four-section `review_changes` call, and applying the server `remedy` instead of
moving code (seeded SDP case).

With-skill failures and fixes:

- `naming-review-before-commit` — renamed `MAX_ROWS` to the `alternatives` word
  unconditionally. Step 7 naming bullet now says the alternative is soft (same
  meaning only, else keep + justify).
- `session-reuse-unedited` — planned a conditional label lookup on `Reranker`;
  the case context did not say whether the earlier fetch carried labels. Context
  now states both answers carried `rankingOverlay`.

After the two fixes the with-skill arm re-ran both cases (opus, same blind
protocol): both PASS — NEW_TERM alternative adopted only on same meaning, no
re-fetch of the unedited file. Final: with-skill 100% (18/18), baseline 67%
(12/18), delta +33pp.

## Run 2026-10-14 — test-first RED phase + verify-first triage (bd tea-rags-mcp-mrlb9)

SKILL.md change (tea-rags 0.43.0): Step 6 split into 6a RED (new agent-only
skill `tea-rags:test-first`), 6b GREEN (tests never edited to pass) and 6c
REFACTOR under green. Step 7 gains **Confirm first**: a finding is presumed
real, a false positive needs counter-evidence (edge absent, role misread, or a
known-noise CONDITION shown to hold), detector flags count only when quoted from
the finding, and every accepted false positive files a detector issue.
`repair/README.md` carries the same rule for the other consumers.

13 new cases, none superseded (the old `step7-fix-false-positive-flag` still
holds: its `compositionRoot` flag is quoted from the finding):

- `step7-verify-first` (5): `step7-confirm-noise-class-unchecked`,
  `step7-confirm-looks-false-but-real`, `step7-confirm-genuine-false-positive`,
  `step7-confirm-touched-active`, `step7-confirm-flag-inferred`
- `step6-tdd` (8): `tdd-red-before-code`, `tdd-spec-test-verbatim`,
  `tdd-import-error-not-red`, `tdd-test-edited-to-pass`,
  `tdd-refactor-baseline`, `tdd-bugfix-repro-first`,
  `tdd-modify-baseline-then-red`, `tdd-hotfix-no-exception`

Method: four sonnet subagents, one per arm per category, each answering all
scenarios of its category from `context` + `prompt` only. The with-skill arm
read DDG SKILL.md, test-first SKILL.md (TDD) and only the repair files its
findings load (triage). The baseline arm read the scenario packet only. Neither
arm saw `expected`. Strict grading by the orchestrator: every `mustDo` met, no
`mustNotDo` hit. Subject model differs from the 2026-10-13 run (opus), so the
baselines are not comparable across runs.

| Metric    | Value        |
| --------- | ------------ |
| With-rule | 100% (13/13) |
| Baseline  | 69% (9/13)   |
| Delta     | +31pp        |

Baseline failures:

- `step7-confirm-flag-inferred` — inferred `compositionRoot` from the
  `src/bootstrap` path, would commit if the file "is pure wiring".
- `tdd-red-before-code` — real red reached, but no test-first protocol and no
  `fixture-lookup` (behaviour pass, protocol fail).
- `tdd-refactor-baseline` — planned a new characterization test for the moved
  helper.
- `tdd-bugfix-repro-first` — ran the existing tests only after the fix; no green
  baseline before the edit.

Baseline sonnet already refuses to edit a test to pass, rejects an import error
as red, keeps spec tests verbatim, and checks a noise-class condition when the
environment hands it the facts. The triage cases mostly pin the protocol against
regression. The delta is in flag quoting, the no-new-test rule for moves, and
baseline-before-edit.

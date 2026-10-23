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

## Run 2026-10-14 — Step 7 gate + pre-write simulation (ddg-gate)

SKILL.md change (tea-rags 0.43.6): Step 7 `review_changes` becomes a GATE —
before every commit, pass = introduced findings repaired or accepted with quoted
evidence + filed detector bead, PARTIAL (`scopeSkippedFiles` / `truncated`) is
never a pass, and the hand-back quotes
`GATE review_changes: introduced=<n>, partial=<bool>`. Step 6b gains a pre-write
simulation: a new production file, a cross-component edge or a move / merge /
split is simulated as one `get_architecture_report` `restructure` hypothesis
before writing; an in-file edit makes zero calls. The own-build source for
`review_changes` is a project rule (`.claude/rules/code-generation-ddg.md`), not
skill text.

5 new cases: `step7-gate` (`gate-partial-not-pass`, `gate-line-missing`,
`gate-preexisting-split`) and `step6-prewrite-sim`
(`prewrite-sim-new-file-new-component`, `prewrite-sim-in-file-edit`).

Method: two sonnet subagents, blind. Arm A read the SKILL.md before the change
(main), arm B the changed SKILL.md; both could read only the repair file of a
family present in a scenario, neither saw `expected`. Strict grading: every
`mustDo` met, no `mustNotDo` hit.

| Metric               | Value      |
| -------------------- | ---------- |
| With change          | 100% (5/5) |
| Before change (main) | 20% (1/5)  |
| Delta                | +80pp      |

Before-change failures:

- `gate-partial-not-pass` — reported "partial" honestly but committed anyway.
- `gate-line-missing` — rewrote the report in per-class prose, no gate line.
- `gate-preexisting-split` — behaviour right (repair the introduced leak, cycle
  report-only) but no gate line; fails the strict `mustDo`.
- `prewrite-sim-new-file-new-component` — ran `plannedEdges` only, no
  `restructure` `addFile` simulation.

`prewrite-sim-in-file-edit` passed both arms: neither arm calls
`get_architecture_report` for an in-file edit, so it pins the trigger's cost
boundary against regression rather than measuring a delta.

## 2026-10-23 — harness-context-economy re-run (Task 12)

- Subject model: sonnet (plan-only simulation, blind; graded by sonnet grader)
- Result: 62/67 PASS (93%)
- Last recorded with-skill rate: 100%
- Delta: -7pp
- FAIL:
  - `eval-6` — delegates to extract-project-patterns, never states the exact custom weights {similarity:0.2, stability:0.3, age:0.3, bugFix:-0.15, ownership:-0.05} | STALE
  - `eval-11` — no identifier verification (find_symbol per identifier + ripgrep imports, 0 results = hallucination); uses Step 7 VERIFY/gate instead | STALE
  - `eval-12` — primary path is rerank=blastRadius preset; exact custom {imports:0.5,churn:0.3,ownership:0.2} only as codegraph-off fallback | STALE
  - `eval-14` — does not skip TEMPLATE/STYLE for greenfield; runs extract-project-patterns on the nonexistent dir (cascading to L2/L3) | STALE
  - `naming-review-before-commit` — plan never says to report review.findings grouped by verdict with relPath:line plus review.conforming/novel counts (only the gate line and ad-hoc per-name notes); everything else met | STALE
- Context: new SessionStart core+digest / SubagentStart block; old plugin hook text present in subject context but declared void (limitation).

## 2026-10-23 — Codex run (Task 14)

- Subject: Codex CLI 0.162.1, default model, plan-only, plugins via repo-root marketplace, real hooks (SessionStart digest + dinopowers routing, SubagentStart block), AGENTS.md = core
- Result: 42/67 PASS (63%) over 67 graded cases (N/A: 0)
- Claude T12 for comparison: 62/67 (93%)
- Both-fail: 5 (eval-6, eval-11, eval-12, eval-14, naming-review-before-commit)
- CODEX-ONLY (20):
  - `eval-4` — CONSERVATIVE hard rule (legacy+low) not applied; reasons labels insufficient, no strategy selected
  - `eval-5` — no autonomous-judgment decision, no justification by axes, no user question; defers strategy
  - `eval-15` — no scan of project strategy-* skills / ## When sections; lists only built-in strategies
  - `naming-type-misfit` — get_naming_lexicon call omits types[TaxAutomationDocument] and finder rename (find_tax_automation_document!); only local rename
  - `naming-camelcase-language` — picks graphDbClient instead of dominant TAIL param name `client`
  - `naming-modify-scope` — no Step 7 VERIFY, no strategy/blame skip stated, lexicon call without types/anchors; adds a clarifying question
  - `verify-symbol-risk` — no find_symbol rerank=criticalPath on called symbols, no defensive-call/test-pin check, no N-th-way find_similar; uses get_callers
  - `verify-central-modified` — get_callers present but no tests-at-risk for the MODIFY
  - `naming-type-draft` — class draft never passed as {name,kind:type,path,extends}; names the class from neighbours, no MISFIT suggestion
  - `step7-fix-remedy-applied` — routes to verification wrapper; no repair/leakingAbstraction.md load, no sections list, no targeted tests step
  - `step7-fix-preexisting-remedy` — skips the cheap pre-existing fix although a remedy is present (explicit mustNotDo)
  - `step7-fix-preexisting-report` — no bead suggestion for the pre-existing finding
  - `step7-fix-round-reverted` — stacks a cycle repair on the regressed round instead of reverting round 1
  - `step7-fix-cohesion-own-vs-preexisting` — no repair/splitCandidates.md, does not move own cluster A, no bead for cluster B
  - `step7-fix-stacked-base-unevidenced-acceptance` — reviews against "the supplied base" instead of re-basing on git merge-base HEAD main
  - `tdd-red-before-code` — test-first not invoked; does not state running tests to record red for the right reason
  - `tdd-refactor-baseline` — moves helper first; no GREEN baseline of tests-at-risk before the move
  - `tdd-bugfix-repro-first` — no green baseline run of existing formatDuration tests before the repro
  - `prewrite-sim-new-file-new-component` — plans a pre-write structure/dependency simulation for a new file (should skip, rely on Step 7 gate)
  - `prewrite-sim-move-files` — moves files blind, no get_architecture_report move hypothesis beforehand

## 2026-10-23 — evals-to-100 re-run (Task 22)

- Subject model: sonnet (plan-only simulation, blind)
- Result: 62/62 PASS (100%) over 62 scored cases (5 superseded excluded: eval-6, eval-11, eval-12, eval-13, eval-14; subject run as 2 halves)
- Task 12 rate: 62/67 (93%)
- Delta: +7pp
- FAIL list: none
- Context: new SessionStart core+digest / SubagentStart block; old plugin hook text present in subject context but declared void (limitation).

## 2026-10-23 — Codex re-run (Task 22)

- Subject: Codex CLI 0.162.1, default model, plugins via repo-root marketplace (tea-rags 0.46.10 + dinopowers 0.24.3 + superpowers 7.0.1), real hooks (plan-only)
- Result: 56/62 PASS (90%) over 62 graded cases (5 superseded excluded, N/A 0); parts p1 22/25, p2 24/25, p3 10/12
- Codex T14 for comparison: 42/67 (63%)
- Claude T22 for comparison: 62/62 (100%)
- FAIL list:
  - ` naming-type-misfit ` — FAIL ( still; Claude T22 PASS ) get_naming_lexicon with types/anchors/drafts planned, but never names the local tax_automation_document nor the finder find_tax_automation_document!; says "model vocabulary / name that describes the lookup" 
  - ` naming-camelcase-language ` — FAIL ( still; Claude T22 PASS ) picks graphDb instead of dominant TAIL param name `client` 
  - ` verify-central-modified ` — FAIL ( still; Claude T22 PASS ) get_callers yes, but tests-at-risk for the MODIFY not run (only "baseline pins") 
  - ` step7-fix-round-reverted ` — FAIL ( still; Claude T22 PASS ) keeps round 1 and stacks a cycles repair on top ("prior SDP fix successful") instead of reverting the whole round 
  - ` tdd-refactor-baseline ` — FAIL ( still; Claude T22 PASS ) no GREEN baseline (tests-at-risk pins + helper tests) before the move; only architecture simulation, tests re-checked after 
  - ` tdd-bugfix-repro-first ` — FAIL ( still; Claude T22 PASS ) no green baseline run and no reproduction test failing on formatDuration(0)==="0s" before patching; goes bug-hunt -> minimal fix 

## 2026-10-23 — evals-to-100 re-run round 2 (Task 22)

- Subject model: sonnet (plan-only simulation, blind; graded strict-literal); run as 3 sequential subjects (21/21/20 cases)
- Result: 58/62 PASS (94%) over 62 scored cases (5 superseded excluded: eval-6, eval-11, eval-12, eval-13, eval-14)
- Baseline (round 1, Task 22): 62/62 (100%)
- Delta: -6pp
- FAIL list:
  - `eval-9` — answer follows references/step-5-style.md (`silo` → "match dominant patterns closely, owner should review"; "match exactly" is the `deep-silo` row); expected demands "match EXACTLY" for silo — eval is stale vs the STYLE table
  - `step7-fix-seeded-sdp-barrel` — Step 7 finding + remedy/repair stated, but no explicit re-run of review_changes ("finding gone, no new finding"); only "regress -> revert" implies it
  - `step7-fix-seeded-layering-back-edge` — same: remedy/repair per repair/layeringBackEdge.md stated, re-run of review_changes not stated
  - `step7-fix-seeded-hub-cut` — same: remedy/repair per repair/hubLike.md stated, re-run of review_changes not stated
- Note: the three seeded FAILs are compression in the answers (references/step-7-verify.md §fix-at-write round loop states "Re-run the same review_changes + targeted tests"); the subject prompt capped answers at 3-10 lines per case.
- Context: new SessionStart core+digest / SubagentStart block; old plugin hook text present in subject context but declared void (limitation).

## 2026-10-23 — Codex re-run round 2 (Task 22)

- Subject: Codex CLI 0.162.1, default model, plan-only; plugins tea-rags 0.46.11 / dinopowers 0.24.4.
- Result: 41/62 PASS (66.1%) (N/A excluded: 0). Parts: p1 21/25, p2 11/25, p3 9/12.
- Round-1 Codex: 56/62 (90.3%). Delta: -24.2 pp.
- FAIL list:
  - `eval-2` — DEFENSIVE picked, strategies/defensive.md never loaded.
  - `eval-9` — silo → "match closely" (follows current step-5-style.md; expectation "match exactly" is stale).
  - `naming-codegraph-off` — no split of holders' symbolIds/paths into recurring words.
  - `naming-type-draft` — MISFIT → take suggestion never stated; hedges toward keeping the draft.
  - `session-reuse-edited` — reuse of other unedited in-context files not stated.
  - `step7-fix-remedy-applied` — re-run with only incompleteChange+architecture sections.
  - `step7-fix-preexisting-remedy` — refuses to apply the remedy of a preExisting+remedy finding.
  - `step7-fix-preexisting-report` — no bead suggestion, commit-allowed not stated.
  - `step7-fix-escalate-after-two` — stops but does not ask the user with fix / accept / bead options.
  - `step7-fix-flap` — no before/after metric + threshold + edge report for the user to decide.
  - `step7-fix-cohesion-own-vs-preexisting` — own cluster A move not committed; cluster B no bead.
  - `step7-fix-cochange-verdict` — plugin.json not accepted as version manifest.
  - `step7-fix-seeded-sdp-barrel` — no post-repair review_changes re-run.
  - `step7-fix-seeded-layering-back-edge` — no post-repair review_changes re-run.
  - `step7-fix-seeded-hub-cut` — no hubLike repair, no re-run, no before/after escalation.
  - `step7-fix-stacked-base-unevidenced-acceptance` — base not `git merge-base HEAD main`; stack-below findings not dropped.
  - `step7-confirm-looks-false-but-real` — edge-in-diff confirmation skipped.
  - `tdd-red-before-code` — RED via dino-TDD; tea-rags:test-first never invoked.
  - `tdd-modify-baseline-then-red` — new red test + pin edited after the change; no PIN-UPDATED with spec line.
  - `gate-partial-not-pass` — no `files` batch re-runs until every file judged.
  - `prewrite-sim-move-files` — re-simulation not driven by the repair file `## Ops recipe`.

## 2026-10-23 — evals-to-100 re-run round 3 (Task 22)

- Subject model: sonnet (plan-only simulation, blind; no per-case length cap; graded strict-literal against the current evals.json); run as 3 sequential subjects (21/21/20 cases)
- Result: 62/62 PASS (100%) over 62 scored cases (5 superseded excluded: eval-6, eval-11, eval-12, eval-13, eval-14)
- Baseline (round 2, Task 22): 94% (58/62)
- Delta: +6pp
- FAIL list: none
- Note: eval-9 passes against the re-aligned expectation (silo → match closely); the three step7-fix-seeded-* cases now state the re-run of the same review_changes + targeted tests each round ("target gone, no new finding"; regression → revert the whole round).
- Context: new SessionStart core+digest / SubagentStart block (rebuilt from live hook output); plugins tea-rags 0.46.12 / dinopowers 0.24.5; old plugin hook text present in subject context but declared void (limitation).

## 2026-10-23 — Codex re-run round 3 (Task 22)

- Subject: Codex CLI 0.162.1, default model, plan-only; plugins tea-rags 0.46.12 / dinopowers 0.24.5.
- Result: 40/62 PASS (64.5%) (N/A excluded: 0).
- Round-2 Codex: 41/62 (66.1%). Delta: -1.6 pp.
- FAIL list:
  - `eval-5` — Autonomous Judgment invoked but no strategy actually chosen ("choose the closest strategy") — no STANDARD/STABILIZATION decision
  - `eval-9` — silo -> "seek another example ... rather than copying the dominant author's style" (opposite of match closely); no owner review flag
  - `eval-10` — shared -> "no reason to avoid adopting the pattern"; never says follow project conventions / do not copy one author
  - `eval-15` — scans strategy-* + ## When, but never states custom conditions run before hard rules
  - `naming-type-misfit` — one call w/ drafts + types and tax_automation_document OK, but language ruby not stated and finder find_tax_automation_document! not named
  - `naming-concept-new-term` — lexicon call by draft type name only — no concept description, no language ruby
  - `naming-concept-backedge` — hits failure mode: refuses Reminder#deliver reuse, writes a new organizer-named sibling service
  - `naming-new-term-justified` — keeps token-bucket term but no "NEW_TERM <term> — why" output line
  - `naming-free-dominant-role` — FREE read as role naming, but picks "best of db/conn/store" — db from byType kinds.param not chosen
  - `naming-codegraph-off` — concept semantic_search but no language/L2 pathPattern/production/limit 30/metaOnly; no split of holders into words, no template-type naming
  - `verify-symbol-risk` — criticalPath metaOnly + defensive pin check + find_similar OK, but no "≤ 5, most central first" ordering
  - `naming-review-before-commit` — no verbatim GATE line, no explicit meta -> fileSignals rename, no NEW_TERM MAX_ROWS/ROW_CAP decision
  - `naming-type-draft` — type draft w/ path + extends OK, but hedges instead of taking the MISFIT suggestion (RubyConstReceiverStrategy)
  - `session-reuse-unedited` — mustNot hit: re-runs find_symbol(symbol="Reranker") on reranker.ts to "confirm the container"
  - `session-reuse-edited` — re-fetches Reranker#rerank, but reuse of other unedited files not stated; adds conditional reindex
  - `step7-fix-remedy-applied` — assumes "remedy is already applied"; no must-fix classification, no leakingAbstraction.md load, no verbatim retarget
  - `step7-fix-preexisting-report` — report line + bead OK, but "commit is allowed" not stated
  - `step7-fix-cochange-verdict` — inspects both partners but plugin.json not named as version-manifest known noise (no-edit) per silentCoupling.md
  - `step7-fix-seeded-layering-back-edge` — pre-emptively avoids the edge; Step 7 surfacing + post-repair "finding gone, none new" not stated ("re-review if needed")
  - `step7-fix-seeded-hub-cut` — no hubLike remedy/repair commitment, no before/after metric + escalate fallback
  - `gate-partial-not-pass` — treats as partial + files batches, but gate line partial=true until covered not stated
  - `gate-preexisting-split` — repairs (2), cycle report-only, but gate line introduced=1 -> 0 after repair not stated

## 2026-10-23 — Codex re-run round 4 (Task 22)

- Subject: Codex CLI 0.162.1, default model, plan-only; plugins tea-rags 0.46.13 / dinopowers 0.24.6; Codex core adds "read ONE file per command; output past ~10k tokens loses its middle".
- Result: 46/62 PASS (74.2%) (N/A excluded: 0).
- Round-3 Codex: 40/62 (64.5%). Delta: +9.7 pp.
- FAIL list:
  - `eval-1` — no /tea-rags:explore first on src/adapters/qdrant/ — goes straight to find_symbol probe + strategy (regression vs R3)
  - `eval-3` — rejects STABILIZATION claiming hard rule needs "extreme" — SKILL.md:125 says "high"+ + erratic (regression vs R3)
  - `eval-5` — autonomous judgment invoked but no strategy actually chosen
  - `eval-15` — scans strategy-* + ## When, never states custom conditions run before hard rules
  - `naming-concept-new-term` — language "typescript" for a Ruby project (context says Ruby); Organizer adoption only conditional
  - `naming-new-term-justified` — keeps new term but no "NEW_TERM <term> — why" output line
  - `verify-symbol-risk` — uses supplied Gateway#charge risk but never runs find_symbol(criticalPath) on the other called symbol Ledger#post
  - `session-reuse-unedited` — says reuse in-context copy, then still plans find_symbol(symbol="Reranker") re-probe
  - `step7-fix-remedy-applied` — misreads the remedy as already applied; no must-fix class, no leakingAbstraction.md, remedy never applied
  - `step7-fix-cochange-verdict` — plugin.json not identified as version-manifest known noise per repair/silentCoupling.md
  - `step7-fix-seeded-hub-cut` — repair + escalation, but no before/after metric report on the fallback
  - `tdd-red-before-code` — routes via dino-tdd/test-driven-development, never invokes $test-first; red-for-the-right-reason not stated (regression vs R3)
  - `tdd-spec-test-verbatim` — keeps test verbatim but no red run before implementing applyFloor (tests run after implementation) (regression vs R3)
  - `gate-partial-not-pass` — treats as partial + files batches, but gate line partial=true until covered not stated
  - `gate-preexisting-split` — repairs (2), cycle report-only, but no leakingAbstraction.md/facade retarget and no introduced=1 -> 0 gate line
  - `prewrite-sim-move-files` — no get_architecture_report restructure move{files,toComponent} before moving (regression vs R3)

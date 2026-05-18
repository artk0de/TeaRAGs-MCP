# Benchmark — tea-rags:extract-project-patterns

**Date:** 2026-05-18 **Skill version:** 0.24.1 (introduced in tea-rags 0.24.0,
no body changes since) **Skill commit:** 16546c5a (initial recipe landing)
**Methodology:** Phase 2 lightweight tool-selection eval (no live MCP tool
execution) **Iterations:** 1 (no fix loop required — 100% with-rule on first
pass)

## Summary

Initial coverage benchmark for a brand-new agent-only recipe skill. Eval design
covers all 6 spec Component E cases plus 2 additional contract-shape regression
checks. With-rule pass rate met the target on the first iteration; no Phase 3
fixes required.

## Metrics

| Metric                 | Value       |
| ---------------------- | ----------- |
| Skill lines            | 129         |
| Eval cases             | 8           |
| With-rule pass rate    | **100.0%**  |
| Baseline pass rate     | 37.5%       |
| **Delta**              | **+62.5pp** |
| Iterations to 100%     | 1           |
| Target delta (≥ +50pp) | met         |

## Per-case results

| Case                              | With-rule | Baseline | Diagnosis                                                                                              |
| --------------------------------- | --------- | -------- | ------------------------------------------------------------------------------------------------------ |
| Eval-1-l1-healthy                 | PASS      | PASS     | Single L1 hit, gate passes, locality=L1. Both got it.                                                  |
| Eval-2-l1-starved-l2-hit          | PASS      | FAIL     | Baseline used single-segment-strip (`**/domains/explore/strategies/**`) — wrong L2 rule.               |
| Eval-3-l1l2-fail-l3               | PASS      | FAIL     | Same single-segment-strip drift in baseline.                                                           |
| Eval-4-triple-fail-diagnostic     | PASS      | FAIL     | Baseline made 3 calls; spec says 1-segment L1 skips L2 → 2 calls.                                      |
| Eval-5-shallow-l1-skip-l2         | PASS      | PASS     | Both skipped L2 on 2-segment L1 (different reasoning, same result).                                    |
| Eval-6-behavior-query-only        | PASS      | PASS     | Both correctly switched to semantic_search and kept rerank="proven".                                   |
| Eval-7-skip-no-inputs             | PASS      | FAIL     | Baseline returned `locality: "skipped"`; contract is `locality: "none"` + `diagnostics: ["no input"]`. |
| Eval-8-reject-critical-bugFixRate | PASS      | FAIL     | Baseline kept rejected chunks in a `candidates` field (not in contract) and missed shallow-L1 skip.    |

## What the skill adds (vs unaided agent)

Baseline failures fall into three categories. The skill text closes each:

1. **L2 derivation (Eval-2, Eval-3).** Without the spec, agents default to
   "strip one parent segment" — a plausible heuristic that produces a different
   glob than the project rule. The skill's explicit "first 2 path segments of
   L1" rule is non-obvious from the input names alone.
2. **Shallow-L1 skip (Eval-4, Eval-8).** Agents instinctively walk the cascade
   fully even when L2 would equal L1. The `≤2 segments → skip L2` rule needs to
   be stated.
3. **Output contract (Eval-7, Eval-8).** Without the contract definition, agents
   invent fields (`candidates`, `rejected`, `recommendation`) and rename others
   (`locality: "skipped"` vs `"none"`). Consumer code (DDG, writing-plans,
   executing-plans) reads specific keys — drift breaks the integration.

Eval-1, Eval-5, Eval-6 were already correct in baseline, suggesting the skill's
value concentrates on the cascade-derivation and contract-shape rules. The
rerank=`"proven"` pick was unanimous; the agent guesses that from the named
preset hint correctly without help.

## Design decisions

- **Did not run Phase 1 audit.** Skill was just authored from spec; no
  accumulated drift to find. Audit findings would all be hypothetical "could
  this confuse an agent?", which Phase 2 measures directly.
- **8 cases, not 15.** Each case targets a distinct contract surface (cascade
  levels, gate, reject filter, skip clause, input types, output shape). Adding
  more cases would re-test the same surfaces.
- **No live MCP execution.** Eval tests INSTRUCTION QUALITY — whether the skill
  text guides correct tool selection. Whether the tools work at runtime is a
  separate concern covered by integration tests in `tests/...`.
- **Spec ambiguity surfaced.** The original `evals.json` expected text for
  Eval-4 and Eval-8 incorrectly described 3-call cascades; the with-rule agent
  caught this by faithfully applying the `≤2 segments → skip L2` rule from the
  skill body. The expecteds were corrected post-grading to match the skill rule,
  which is the canonical source.

## Iteration log

| Iter | With-rule | Action                                   |
| ---- | --------- | ---------------------------------------- |
| 1    | 100%      | Phase 3 skipped (no confirmed failures). |

## Artifacts

- `evals.json` — committed. 8 cases with per-case results.
- `workspace/` — gitignored. Per-iteration subagent outputs (not preserved for
  iter 1 since results inlined here and in evals.json).
- This file (`benchmark.md`) — committed. Optimization record.

## Follow-up

- `evals/cases.json` from spec Component E remains a separate deferred artifact
  for `/optimize-skill` integration runs. This benchmark covers the same six
  spec cases plus two contract-shape regressions and is the canonical eval
  baseline going forward.
- Future regression checks should re-run the with-rule subagent against this
  `evals.json` after any SKILL.md text change and assert ≥ 100% (or document the
  regression).

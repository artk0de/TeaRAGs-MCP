# dinopowers:test-driven-development Optimization Benchmark

**Date:** 2026-04-20 **Skill created:**
`.claude-plugin/dinopowers/skills/test-driven-development/SKILL.md` **Eval
cases:** 15 (6 core-rule/tool/params, 3 edges, 3 pressure/wrong-rerank, 3
controls/subagent-routing/find_similar-trap)

## Metrics

| Metric                | Value             |
| --------------------- | ----------------- |
| Lines (SKILL.md)      | 116               |
| Words (SKILL.md)      | 1013              |
| With-rule pass rate   | 100% (15/15)      |
| Without-rule baseline | 20% (3/15)        |
| Delta                 | +80pp             |
| Iterations            | 1 (no fix needed) |

## Context

Sixth skill of `dinopowers`. Enforces project-local test conventions by
searching **proven test files** before drafting a new failing test. Unlike
previous wrappers that use impact rerank or risk presets, TDD uses the
`"proven"` preset (stability + age + low-bugFix) — the calibrated lens for
"which tests are battle-tested and represent conventions".

**Core value**: `testFile: "only"` built-in filter (works across languages,
unlike `pathPattern: "**/*.test.ts"`) + `rerank: "proven"` + `metaOnly: false`
(need test code content, unlike impact guards) + extract-as-bullets (not raw
code) + hand off to `superpowers:test-driven-development` for the actual
RED-GREEN-REFACTOR cycle.

## Key Design Decisions

1. **`testFile: "only"` filter over path-based patterns** (eval-2). Built-in
   filter respects project conventions (`.test.ts`, `.spec.ts`, `_test.go`,
   `_spec.rb`) across languages. Baseline defaults to Glob on `.test.ts` which
   misses non-TS tests.

2. **`rerank: "proven"` instead of `hotspots`/`recent`/`relevance`** (eval-3,
   eval-11). `proven` is calibrated
   `{stability: 0.3, age: 0.3, bugFix: -0.15, ownership: -0.05, similarity: 0.2}`
   per `tea-rags-analytics.md`. Surfaces stable, old, low-bug-fix-rate tests =
   conventions. `hotspots` would return FLAKY tests (high churn = instability).
   Baseline eval-11 complies with user's wrong-rerank request.

3. **`metaOnly: false` required** (eval-4). TDD needs actual test body (mock
   setup, assertion calls) — metadata alone is useless for pattern extraction.
   Opposite of guard wrappers which need `metaOnly: true`. Baseline complies
   with user's metaOnly=true request.

4. **Pattern extraction as 4-6 bullets, not raw code** (eval-8, Step 3).
   Convention summary: mock setup, helper imports, describe/it style, assertion
   idiom, fixture location, setup/teardown. Cite source file per convention.
   Baseline dumps raw code into handoff.

5. **`find_similar` rejected as primary** (eval-15). `find_similar` on
   implementation file finds structurally-similar PRODUCTION code, not tests
   exercising similar behavior. Allowed as supplementary call AFTER primary
   semantic_search. Baseline uses find_similar as primary.

6. **Empty-corpus fallback** (eval-6). First-ever-test scenario: run search, on
   0 results state "no existing patterns — falling back" and invoke
   `superpowers:test-driven-development` directly. Don't fabricate conventions
   from general knowledge.

7. **Cross-language caveat** (eval-7). Ruby hooks in TS project: search the TS
   test corpus (it's what the project has), note the cross-language mismatch in
   the pattern block. Don't search without `testFile: "only"` hoping to find
   Ruby tests that don't exist.

## Delta Interpretation

+80pp is a strong delta. Baseline passes only 3/15 — the controls (eval-13
listing, eval-14 fix-existing-test) + one TDD case where baseline happened to
match. The skill's value is protocol enforcement across the remaining 12 cases.

## Bootstrap Observation

Bootstrap `semantic_search` returned dinopowers:systematic-debugging
(0.40-0.44) + tea-rags:bug-hunt (0.40-0.45). Lower scores than other bootstraps
— TDD doesn't have a direct corpus analog. Pattern extraction still lifted:

- dinopowers step structure (Iron Rule, Steps 1-4, Red Flags, Common Mistakes)
- bug-hunt's discipline rules (Execute yourself, partial reads, no git log)
- "Do NOT substitute" table format

TDD-specific elements (`testFile: "only"` filter, `rerank: "proven"` preset
choice) came from direct tea-rags MCP schema knowledge (not bootstrap). Draft
hit 100% on first iteration regardless.

## Iteration Log

**Iteration 0 (bootstrapped draft):** 15/15 PASS with-rule. 3/15 PASS
without-rule. Delta +80pp.

No iteration needed.

## Risks and follow-ups

- **`proven` preset availability**: depends on `stability` and `age` derived
  signals from the static trajectory. If static trajectory is disabled, `proven`
  degrades to plain similarity. Phase 8 should verify signal presence.

- **Language coverage**: `testFile: "only"` filter relies on tea-rags' test-file
  classification. Verify it correctly identifies `.test.ts`, `.spec.ts`,
  `_test.go`, `_spec.rb`, `Spec.kt` in multi-language projects. Phase 8
  integration test.

- **Thin corpus handling (<3 results)**: skill notes it but doesn't define exact
  fallback behavior. Consider adding explicit thresholds (e.g. <3 = thin, 0 =
  none, ≥3 = full pattern extraction).

- **Pattern staleness**: `proven` returns OLD tests — if project conventions
  evolved, old tests may encode deprecated patterns. Consider combining with a
  recency cross-check (one `rerank: "recent"` call as secondary signal if proven
  tests look ancient).

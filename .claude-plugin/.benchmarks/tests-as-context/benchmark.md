# Benchmark — `tea-rags:tests-as-context`

**Date:** 2026-05-17 **Plugin:** tea-rags (bumped 0.22.2 → 0.23.0 minor — new
skill) **Spec:** `docs/superpowers/specs/2026-05-17-tests-as-context-design.md`
**Session type:** Feature creation (per Phase 6 mandate: "Applies to
feature-driven updates too — eval cases and results MUST still be persisted. The
eval may be smaller").

## Summary

New agentic-only skill (`user-invocable: false`) that turns DSL test chunks
(`chunkType: "test"` + `chunkType: "test_setup"`) into review / verify /
refactor / TDD enrichment. Five recipes, all single-shot, all runner-agnostic in
output.

| Recipe                   | Callers                                                                       | Filter shape                                        |
| ------------------------ | ----------------------------------------------------------------------------- | --------------------------------------------------- |
| `tests-at-risk`          | requesting-code-review, verification-before-completion, receiving-code-review | `chunkType: "test"` + `must_not relativePath`       |
| `fixture-lookup`         | test-driven-development (Step 2a)                                             | `chunkType: "test_setup"` + `rerank: "proven"`      |
| `regression-archaeology` | direct caller, `use-cases.md`                                                 | `chunkType: "test"` + heavy age weight              |
| `test-flakiness`         | direct caller, `use-cases.md`                                                 | `chunkType: "test"` or `"test_setup"` + `hotspots`  |
| `spec-extraction`        | direct caller, `use-cases.md`                                                 | `find_symbol(relativePath:)` + raw chunkType filter |

## Phase status

| Phase                        | Status        | Notes                                                                                                     |
| ---------------------------- | ------------- | --------------------------------------------------------------------------------------------------------- |
| 1 — AUDIT                    | DONE          | 6 findings; 4 fixed inline (F1, F2, F3, F4); F5/F6 acceptable                                             |
| 2 — BASELINE EVAL            | DEFERRED      | 12 cases persisted in `evals.json`. With-rule/without-rule subagent runs deferred to next eval session.   |
| 3 — FIX (audit-driven)       | DONE          | See "Audit fixes applied" below                                                                           |
| 4 — VERIFY                   | DEFERRED      | Runs alongside Phase 2 in next session                                                                    |
| 5 — ITERATE                  | n/a yet       | Triggered by Phase 4 failures                                                                             |
| 6 — PERSIST                  | DONE (inline) | This document + `evals.json` are the persistence artifacts                                                |
| 7 — Description Optimization | DEFERRED      | Description is intentionally pushy + enumerates 5 recipes; re-tune after Phase 2 reveals trigger failures |
| 8 — Integration eval         | DEFERRED      | Phase 2 tool-selection eval covers expected failure modes; integration tests only on demand               |

## Audit fixes applied (Phase 3)

| Finding                                                                                                                | Fix                                                                                                                                    |
| ---------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| F1 — brace-expansion pathPattern fails for single-element `affectedFiles` (e.g. `!{src/foo.ts}` is invalid picomatch)  | Replaced with raw filter `{ must_not: [{ key: "relativePath", match: { any: [...] }}] }`. Works for 1 or N paths uniformly.            |
| F2 — preflight assumed prime digest in context; fresh subagents lack it                                                | Added fallback probe call: single `semantic_search` with `filter: chunkType=test, limit=1, metaOnly=true`. Bounded cost, always works. |
| F3 — `tests-at-risk` rerank had `imports: 0.2` but test chunks are rarely imported by other modules (near-zero signal) | Dropped `imports` weight. Final rerank: `{similarity: 0.7, age: -0.1, churn: 0.2}`. Documented rationale in recipe body.               |
| F4 — receiving-code-review needed clarity that `affectedFiles` accepts single-element array                            | Added explicit note in both recipe body and wrapper Step 3a.                                                                           |
| F5 — wrappers must not name runners                                                                                    | Already enforced; cross-language safety contract block in `tests-as-context` SKILL.md + per-wrapper notes.                             |
| F6 — TDD Step 2b is direct `semantic_search`, not a recipe                                                             | Acceptable: TDD's split-query rationale benefits from explicit shape; recipe wrapping would add indirection without gain.              |

## Eval design (Phase 2 deferred — 12 cases ready)

Distribution per category (see `evals.json`):

- 3 × recipe-routing (T1, T6, T9 partial) — agent picks correct recipe from
  intent
- 3 × cross-language-guard (T2, T7) — output is runner-agnostic
- 2 × filter-choice (T4, T8) — `chunkType` over `testFile`, correct `metaOnly`
- 2 × preflight (T3 absence, T11 cold subagent) — F2 fix verification
- 1 × single-symbol-input (T5) — F1 fix verification
- 1 × agentic-only-discipline (T10) — `user-invocable: false` not surfaced as
  slash command
- 1 × consumer-integration (T12) — wrapper Step 3a handles 3 outcomes

Subagent contexts probed: `task-agent`, `explore`, `code-reviewer`,
`user-facing`. Covers mandatory subagent-routing requirement from
`optimize-skill` Phase 2.1.

## Files touched in feature session

```
.claude-plugin/tea-rags/.claude-plugin/plugin.json                              (version bump)
.claude-plugin/tea-rags/rules/search-cascade.md                                 (2 new rows in After-Search Navigation)
.claude-plugin/tea-rags/rules/references/use-cases.md                           (new "Tests as context" section)
.claude-plugin/tea-rags/skills/filter-building/SKILL.md                         (Test filter levels sub-table)
.claude-plugin/tea-rags/skills/tests-as-context/SKILL.md                        (NEW — 220 lines)
.claude-plugin/dinopowers/.claude-plugin/plugin.json                            (version bump)
.claude-plugin/dinopowers/skills/test-driven-development/SKILL.md               (Step 2 split, fallback path)
.claude-plugin/dinopowers/skills/requesting-code-review/SKILL.md                (Step 3a — Tests at risk)
.claude-plugin/dinopowers/skills/verification-before-completion/SKILL.md       (Step 3a — Tests-at-risk lookup)
.claude-plugin/dinopowers/skills/receiving-code-review/SKILL.md                 (Step 3a — Tests bound)
docs/superpowers/specs/2026-05-17-tests-as-context-design.md                    (NEW — spec)
.claude-plugin/.benchmarks/tests-as-context/evals.json                          (NEW — 12 eval cases)
.claude-plugin/.benchmarks/tests-as-context/benchmark.md                        (this file)
```

## Next eval session — what to run

1. Read `evals.json` from this benchmark folder
2. Spawn ONE with-rule subagent: inject `tests-as-context/SKILL.md` content +
   all 12 prompts in a single turn. Agent describes tool-selection plan per case
   (does NOT execute).
3. Spawn ONE without-rule subagent: same 12 prompts, no skill text, only the MCP
   tool list. Agent describes its natural plan.
4. Grade each case. Expected pass rates:
   - With-rule: ≥ 11/12 (92%) — F1-F4 fixes should land
   - Without-rule: ≤ 4/12 (33%) — DSL test chunks are a non-obvious feature;
     baseline agent will pick `testFile: "only"` or grep
   - Target delta: ≥ +50pp per `optimize-skill` Phase 2 success criterion
5. For any FAIL in with-rule: iterate per Phase 5 (max 3 iterations).
6. Re-write this benchmark.md with actual numbers; persist iteration outputs to
   `.benchmarks/tests-as-context/workspace/iteration-N/` (gitignored).

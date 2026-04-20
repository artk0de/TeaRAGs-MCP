# dinopowers:writing-skills Optimization Benchmark

**Date:** 2026-04-20 **Skill created:**
`.claude-plugin/dinopowers/skills/writing-skills/SKILL.md` **Eval cases:** 12 (6
core-rule/ordering, 2 parameters, 2 pressure/wrong-tool, 2 controls)

## Metrics

| Metric                | Value             |
| --------------------- | ----------------- |
| Lines (SKILL.md)      | 87                |
| Words (SKILL.md)      | 633               |
| With-rule pass rate   | 100% (12/12)      |
| Without-rule baseline | 25% (3/12)        |
| Delta                 | +75pp             |
| Iterations            | 1 (no fix needed) |

## Context

First skill of the `dinopowers` plugin. Bootstraps the wrapper-skill authoring
flow — subsequent 9 dinopowers wrappers will trigger this skill to find
structural patterns before invoking `superpowers:writing-skills`.

**Core value**: correct tea-rags tool selection (`semantic_search`, NOT
`hybrid_search` / `find_similar` / `find_symbol` / Grep) with correct parameters
(`pathPattern="**/SKILL.md"`, no git-bias rerank) in correct order (tea-rags
BEFORE `superpowers:writing-skills`).

## Eval Cases

| ID      | Category               | Prompt gist                                      | With-rule | Baseline |
| ------- | ---------------------- | ------------------------------------------------ | --------- | -------- |
| eval-1  | core-rule              | Create dinopowers:brainstorming wrapper          | PASS      | FAIL     |
| eval-2  | core-rule (task-agent) | Plan task: write dinopowers:executing-plans      | PASS      | FAIL     |
| eval-3  | tool-selection         | New skill detecting duplicated logic             | PASS      | FAIL     |
| eval-4  | parameters             | dinopowers:verification-before-completion        | PASS      | PASS     |
| eval-5  | edge (empty index)     | New skill when semantic_search returns empty     | PASS      | FAIL     |
| eval-6  | ordering (plan-exec)   | Plan step: author dinopowers:systematic-debug    | PASS      | FAIL     |
| eval-7  | pressure               | "Быстро, не парься с поиском паттернов"          | PASS      | FAIL     |
| eval-8  | wrong-tool-pressure    | "Используй hybrid_search"                        | PASS      | FAIL     |
| eval-9  | control (listing)      | "Какие скиллы есть в tea-rags/"                  | PASS      | PASS     |
| eval-10 | control (trivial edit) | One-word replace in existing SKILL.md            | PASS      | PASS     |
| eval-11 | subagent (explore)     | Author dinopowers:finishing-a-development-branch | PASS      | FAIL     |
| eval-12 | wrong-rerank           | "Используй rerank='techDebt'"                    | PASS      | FAIL     |

## Key Design Decisions

1. **Iron Rule placed at top** of SKILL.md body before any steps. Baseline eval
   showed agents comply with user pressure to skip search (eval-7) and comply
   with wrong-tool instructions (eval-8, 12) unless an explicit Iron Rule is
   stated early.

2. **Explicit "Do NOT substitute" table** listing each wrong tea-rags tool with
   reason. Avoids generic "use semantic_search" that baseline agents rationalize
   past (eval-3 baseline: "I'd Glob + Read existing SKILL.md examples").

3. **Explicit "Do NOT pass" list** for parameters — no `rerank`, no git-signal
   `filter`. Baseline eval-12 showed compliance with `rerank='techDebt'` when
   user suggests it. Explicit prohibition closes the loophole.

4. **Fallback contract when index is empty**: "report 'no SKILL.md corpus
   indexed' + skip to Step 4 without pattern block". Baseline eval-5 showed
   agents retry with `hybrid_search` or fabricate patterns. Explicit fallback
   prevents both.

5. **Red Flags section** naming specific rationalizations observed in baseline
   ("I already know the SKILL.md format", "tea-rags is slow, let me skip it").
   Converts rationalizations into explicit STOP conditions.

6. **Controls distinguish triggering vs listing/edit**: evals 9, 10 confirm the
   skill doesn't over-trigger for "what skills exist" or trivial one-word edits.
   Both PASS in baseline — skill body doesn't erode this natural behavior.

## Iteration Log

**Iteration 0 (initial draft):** 12/12 PASS with-rule. 3/12 PASS without-rule.
Delta +75pp.

No iteration needed — draft hit target. Design decisions above were front-loaded
based on methodology (Iron Rule placement, explicit loophole closure, fallback
contract).

## Risks and follow-ups

- **Small eval set (12)**: consider Phase 8 full integration eval once the skill
  is actually used to bootstrap the next 9 dinopowers wrappers. If convergence
  is faster than `/optimize-skill` without this wrapper — confirms bootstrap
  value.

- **Eval grader = subagent, not human**: agents may be over-lenient grading
  their own plans. Recommend periodic human audit of eval grading for
  regressions.

- **Corpus depends on tea-rags index**: if `SKILL.md` files are not indexed (no
  markdown chunker, or filter excludes them), Step 2 returns empty and the
  fallback path is always taken. Verified 2026-04-20: index has SKILL.md chunks
  (top score 0.51 for pattern query). Re-verify after any indexing pipeline
  changes.

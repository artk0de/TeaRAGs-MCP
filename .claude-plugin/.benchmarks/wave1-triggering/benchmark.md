# Wave 1 — Triggering Eval (all 28 skills, Opus 4.7 migration)

## Summary

Validate that current skill `description` fields fire the correct skill under
Opus 4.7's literal classifier. Compared against a baseline (skill names only, no
descriptions) and against the with-rule eval after description fixes.

## Context

User reported two symptom classes when migrating from Opus 4.6 to 4.7:

1. Skills no longer fire when they should (description triggering regression)
2. Skills fire but ignore body instructions (instruction-following regression)

This benchmark covers symptom #1 — the description / triggering layer. Body
restructuring is tracked under `wave2-restructure/`.

## Methodology

- 30 eval cases spanning 26 user-invocable skills (excludes 2
  `user-invocable: false` skills)
- Each case: a realistic user prompt (English + Russian) → expected skill
- 3 simulated runs by Opus 4.7 subagents:
  - **Baseline**: agent sees skill NAMES only, no descriptions
  - **With-rule (before)**: agent sees current skill descriptions
  - **With-rule (after)**: agent sees rewritten descriptions

The simulation is a fidelity-limited proxy for the real Anthropic skill
classifier — both subagents are 4.7 themselves and may erroneously converge.
Confidence scoring (HIGH/MED/LOW) is the more discriminating signal than raw
correctness.

## Results

| Run                          | Correct | HIGH conf | MED conf | LOW conf | Notes                                                                |
| ---------------------------- | ------- | --------- | -------- | -------- | -------------------------------------------------------------------- |
| Baseline (names only)        | 28/30   | 24        | 4        | 2        | Lost case 29 (data-driven-generation), HIGH NONE on case 30 distract |
| With-rule (OLD descriptions) | 30/30   | 16        | 13       | 1        | All correct but 14 wrappers MED due to "USE INSTEAD OF" meta-prefix  |
| With-rule (NEW descriptions) | 30/30   | **30**    | 0        | 0        | All HIGH confidence, zero regressions                                |

**Delta vs baseline**: +6 confidence points (LOW/MED → HIGH on edge cases)
**Delta vs old descriptions**: +14 cases moved MED→HIGH, +1 LOW→HIGH

## Triage Findings (confirmed by eval)

| Finding                                                      | Eval evidence                               | Action taken                                                        |
| ------------------------------------------------------------ | ------------------------------------------- | ------------------------------------------------------------------- |
| Bare `add-*` descriptions match only literal paraphrase      | Cases 1-6 PASS but require literal keywords | Rewrote to `Intent + Triggers + NOT-list` template                  |
| `dinopowers:*` "USE INSTEAD OF" prefix down-weights wrappers | Cases 14-27 ranked MED                      | Removed meta-prefix; lead with verb-first intent; chain line at end |
| `data-driven-generation` description too abstract            | Case 29 LOW confidence                      | Rewrote with concrete code-writing triggers + "NOT for discovery"   |
| `tune` lacks `Use when` triggers                             | Case 10 ambiguity vs install                | Added explicit triggers ("indexing is slow", "benchmark hardware")  |
| `bug-hunt` lacks symptom triggers                            | Used in eval as alt_ok only                 | Added symptom triggers ("test fails", "stack trace says Z")         |

## Per-eval results

| ID  | Prompt                                                               | Expected                                  | Old conf | New conf |
| --- | -------------------------------------------------------------------- | ----------------------------------------- | -------- | -------- |
| 1   | Add a new derived signal called 'freshness'                          | project:add-derived-signal                | HIGH     | HIGH     |
| 2   | Мне нужен новый DTO для tool'а                                       | project:add-dto                           | HIGH     | HIGH     |
| 3   | Add Kotlin support to the chunker                                    | project:add-language-hook                 | HIGH     | HIGH     |
| 4   | I need a new MCP tool that returns project stats                     | project:add-mcp-endpoint                  | HIGH     | HIGH     |
| 5   | Schema needs a new payload field, write the migration                | project:add-migration                     | HIGH     | HIGH     |
| 6   | I want a new ranking strategy that boosts security-audit code        | project:add-rerank-preset                 | HIGH     | HIGH     |
| 7   | Indexing is slow today, can you check the latest pipeline debug log? | project:debug-pipeline-log                | HIGH     | HIGH     |
| 8   | This skill description doesn't fire on prompts that should match it  | project:optimize-skill                    | HIGH     | HIGH     |
| 9   | Set up tea-rags in this fresh repo from scratch                      | tea-rags-setup:install                    | HIGH     | HIGH     |
| 10  | My indexing is too slow, can we benchmark and tune                   | tea-rags-setup:tune                       | HIGH     | HIGH     |
| 11  | Index the codebase at /Users/me/project                              | tea-rags:index                            | HIGH     | HIGH     |
| 12  | I want to rebuild the index from scratch with zero downtime          | tea-rags:force-reindex                    | HIGH     | HIGH     |
| 13  | How does the EnrichmentCoordinator handle concurrent prefetch?       | tea-rags:explore                          | HIGH     | HIGH     |
| 14  | Test fails with TypeError: cannot read property 'chunks'             | dinopowers:systematic-debugging           | MED      | **HIGH** |
| 15  | Падает миграционный тест на CI                                       | dinopowers:systematic-debugging           | MED      | **HIGH** |
| 16  | Write a failing test for the new RecencySignal                       | dinopowers:test-driven-development        | MED      | **HIGH** |
| 17  | Implementation is done, all tests pass, ready to commit              | dinopowers:verification-before-completion | MED      | **HIGH** |
| 18  | готово, можно коммитить и пушить                                     | dinopowers:verification-before-completion | MED      | **HIGH** |
| 19  | Time to open a PR for this branch and request review                 | dinopowers:requesting-code-review         | MED      | **HIGH** |
| 20  | Reviewer suggested I rename loadConfig to readConfig                 | dinopowers:receiving-code-review          | MED      | **HIGH** |
| 21  | PR comment says I should extract this into a helper                  | dinopowers:receiving-code-review          | MED      | **HIGH** |
| 22  | Let's brainstorm how to redesign the chunker hook system             | dinopowers:brainstorming                  | MED      | **HIGH** |
| 23  | Давай обсудим как разбить enrichment на модули                       | dinopowers:brainstorming                  | MED      | **HIGH** |
| 24  | Draft an implementation plan for sparse vector rebuild               | dinopowers:writing-plans                  | MED      | **HIGH** |
| 25  | Execute Task 3 from the trajectory enrichment plan                   | dinopowers:executing-plans                | MED      | **HIGH** |
| 26  | Branch is ready to merge to main                                     | dinopowers:finishing-a-development-branch | MED      | **HIGH** |
| 27  | Create a new dinopowers wrapper skill for refactoring                | dinopowers:writing-skills                 | MED      | **HIGH** |
| 28  | How healthy is the trajectory domain? Hotspot files?                 | tea-rags:risk-assessment                  | HIGH     | HIGH     |
| 29  | Implement a function that parses git log output                      | tea-rags:data-driven-generation           | **LOW**  | **HIGH** |
| 30  | What's the weather in Moscow today?                                  | NONE                                      | HIGH     | HIGH     |

## Files Changed

20 SKILL.md files — `description` field only, body untouched in this wave.

| Plugin / Group      | Files                                |
| ------------------- | ------------------------------------ |
| dinopowers wrappers | 10                                   |
| tea-rags discovery  | 2 (bug-hunt, data-driven-generation) |
| tea-rags-setup      | 2 (install, tune)                    |
| project add-\*      | 6                                    |

Total: +139 / -99 lines in description blocks.

## Caveats

- The simulated classifier is not the real Anthropic classifier. Treat
  HIGH/MED/LOW confidence as relative — large MED→HIGH movement is the
  meaningful signal, absolute "100% pass" is a methodology artifact.
- Real-world validation: after publishing the bumped plugin versions, observe
  how often skills fire on natural prompts in the next ~10 sessions and compare
  to the prior baseline.
- **dinopowers and tea-rags plugins are loaded from
  `~/.claude/plugins/marketplaces/`, not from this repo's `.claude-plugin/`**.
  Description fixes will only take effect after the marketplace copies are
  refreshed (publish + reinstall, or manual sync).

## Files

- `evals.json` — full 30-case eval set with assertions and per-iteration results
- `workspace/skill-snapshot/before/` — frozen copies of pre-fix descriptions
- `workspace/skill-snapshot/after/` — frozen copies of post-fix descriptions

# Benchmark — dinopowers:executing-plans (v2 optimization)

**Date:** 2026-05-06 **Skill:**
`.claude-plugin/dinopowers/skills/executing-plans/SKILL.md` **Plugin version
bump:** dinopowers `0.14.0` → `0.14.1` (patch — text changes to existing skill)

## Summary

Audit identified one critical instruction gap: the wrapper enforced a git-signal
**pre-touch guard** for blast-radius safety, but never instructed agents to
invoke `tea-rags:data-driven-generation` for **code-generation Tasks**. As a
result, agents executing plan Tasks that create new files / new functions /
rewrites would fall back to manual `Read sibling.ts → Write new.ts`, missing:

1. Strategy selection (DEFENSIVE / STABILIZATION / CONSERVATIVE / STANDARD)
2. Template via "proven" rerank (long-lived, low-churn, low-bug, multi-author)
3. Silo-author style copy (`dominantAuthorPct ≥ 95%` → exact match + flag owner)

Phase 2 baseline confirmed the gap: **0/7 audit-F1 cases passed** with the
existing skill. Phase 3 added Step 5 — Code-Gen Cascade — with a 5-row Task
classification table (generation / refactor / modification / deletion /
trivial). Phase 4 verification: **10/10 PASS, +70pp from before-fix.**

## Changes

| File                                                        | Change                                                                                                                                                                                                                                                                    |
| ----------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `.claude-plugin/dinopowers/skills/executing-plans/SKILL.md` | +66 lines (205 → 271). Description expanded. Chaining rule lists `tea-rags:data-driven-generation` as cross-plugin step. New **Step 5 — Code-Gen Cascade** with classification table + invocation contract + ordering rule. 2 new Red Flags + 2 new Common Mistakes rows. |
| `.claude-plugin/dinopowers/.claude-plugin/plugin.json`      | Version `0.14.0` → `0.14.1` (patch per `plugin-versioning.md`).                                                                                                                                                                                                           |

## Key design decisions

1. **Step 5 sits AFTER verdict gate (Step 4), BEFORE
   `superpowers:executing-plans`.** Two independent gates: blast-radius (Step
   2/4) is about _should we touch this file_; data-driven (Step 5) is about
   _what should the new code look like_. Both must clear independently before
   generation proceeds. New-file Tasks pass Step 4 trivially (SAFE) but still
   need Step 5 for style/strategy.

2. **Classification by intent table (5 rows), not by file count.** Agents
   confused "new file" with "guard skip" and concluded the whole wrapper skips.
   Explicit 5-row table (generation / refactor / modification / deletion /
   trivial) makes the data-driven gate visible as a separate axis from the
   blast-radius gate.

3. **`tea-rags:data-driven-generation` is NOT a `superpowers:Y` redirect.**
   Existing chaining rule swaps `superpowers:Y` → `dinopowers:Y` for known
   wrappers. Data-driven is a NEW step the wrapper inserts, not a redirect of
   anything. The chaining rule section now has a separate "cross-plugin" entry
   to make this distinction explicit.

4. **No parameters passed to `tea-rags:data-driven-generation`.** The skill
   reads area context from conversation; if missing it internally chains to
   `tea-rags:explore`. Pre-fetching labels in the wrapper would duplicate the
   data-driven skill's workflow ownership.

5. **Russian trigger E10 ("выписат legacy auth middleware ... на новый шаблон,
   основываясь на стиле новых middleware") classified as "rewrite-to-
   new-template" → generation row.** Verifies that style-copy intent in non-
   English language still triggers the cascade.

## Metrics

| Metric                 | Before | After | Delta         |
| ---------------------- | ------ | ----- | ------------- |
| SKILL.md lines         | 205    | 271   | +66 (+32%)    |
| With-rule pass rate    | 30%    | 100%  | +70pp         |
| Without-rule pass rate | 20%    | 20%   | 0pp (control) |
| With-rule vs baseline  | +10pp  | +80pp | +70pp         |

## Iterations

| Iteration                          | Pass rate    | Notes                                                                                                                       |
| ---------------------------------- | ------------ | --------------------------------------------------------------------------------------------------------------------------- |
| Baseline (with-rule)               | 3/10 (30%)   | E5/E6/E7 controls passed. All 7 audit-F1 cases failed (no data-driven invocation).                                          |
| Baseline (without-rule)            | 2/10 (20%)   | E6/E7 trivial. E5 failed because `semantic_search` not used (used `find_symbol` + `trace_impact`).                          |
| Iteration 1 (with-rule, after fix) | 10/10 (100%) | All audit-F1 cases now invoke `tea-rags:data-driven-generation`. Controls preserved. **Target met, no further iterations.** |

## Per-eval detail

| ID  | Category            | Prompt summary                            | Before | After | Notes                                                                                   |
| --- | ------------------- | ----------------------------------------- | ------ | ----- | --------------------------------------------------------------------------------------- |
| E1  | audit-F1            | New file `extractor.ts`                   | ❌     | ✅    | Step 5 invokes data-driven                                                              |
| E2  | audit-F1            | New method on existing class `Reranker`   | ❌     | ✅    | semantic_search guard (existing file) + Step 5                                          |
| E3  | audit-F1            | New elixir hook from ruby/python pattern  | ❌     | ✅    | Was: manual `Read ruby + Read python`. Now: data-driven proven rerank                   |
| E4  | audit-F1            | New DefensiveStrategy class               | ❌     | ✅    | Was: manual `Read standard-strategy.ts`. Now: proven rerank picks battle-tested example |
| E5  | control-refactor    | Rename across 12 callers                  | ✅     | ✅    | Step 5 SKIP correctly applied                                                           |
| E6  | control-tiny        | Typo fix                                  | ✅     | ✅    | Wrapper bypassed entirely per Step 5 trivial row                                        |
| E7  | control-delete      | Delete legacy file                        | ✅     | ✅    | Step 5 SKIP, guard runs                                                                 |
| E8  | subagent-explore    | Subagent: new CascadeStrategy             | ❌     | ✅    | Subagent without parent CLAUDE.md still picks Step 5 from skill text alone              |
| E9  | subagent-autonomous | Autonomous: BugFixRateSignal class        | ❌     | ✅    | Step 5 + dinopowers:test-driven-development chain                                       |
| E10 | edge-russian        | Russian rewrite of legacy auth middleware | ❌     | ✅    | "переписать ... на новый шаблон" classified as rewrite-to-new-template                  |

## Workspace

- `evals.json` — 10 eval cases with audit-finding refs, expected sequences,
  must_include/must_not_include assertions
- `workspace/skill-snapshot/before/SKILL.md` — frozen pre-fix copy
- `workspace/skill-snapshot/after/SKILL.md` — frozen post-fix copy
- `workspace/iteration-1/` — placeholder (subagent outputs captured inline in
  this conversation; no per-iteration directories needed for tool-selection-only
  eval)

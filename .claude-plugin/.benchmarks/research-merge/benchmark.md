# Research → Explore Merge Benchmark

**Date:** 2026-03-30 **Scope:** Research skill eliminated, merged into explore
as PRE-GEN flow

## Summary

Research skill had 15 identified collisions with explore, risk-assessment, and
search-cascade. After audit + baseline eval confirmed 7 failures, research was
merged into explore as a PRE-GEN classification branch. This eliminated all
skill boundary collisions and reduced total line count by 36%.

## Changes

| File                            | Change                                                  |
| ------------------------------- | ------------------------------------------------------- |
| explore/SKILL.md                | Added PRE-GEN flow (Step 0 classification + PG-1..PG-4) |
| research/SKILL.md               | **Deleted** — merged into explore                       |
| search-cascade.md               | One explore branch instead of explore+research          |
| data-driven-generation/SKILL.md | Prereq = area context (not specific skill)              |
| bug-hunt/SKILL.md               | Removed post-search-validation (moved to cascade)       |
| risk-assessment/SKILL.md        | Removed post-search-validation (moved to cascade)       |
| search-cascade.md               | Added post-search-validation, pathPattern base rules    |

## Key Design Decisions

1. **Pre-gen classification first** — Step 0 checks pre-gen signals before
   pattern-search keywords, ensuring "before I modify" always wins over
   "understand"
2. **Risk assessment as sub-skill** — explore PRE-GEN delegates to
   risk-assessment instead of duplicating risk flagging logic
3. **Self-contained output** — PRE-GEN output doesn't auto-invoke
   data-driven-generation. Agent/user controls flow.
4. **ddg auto-invokes explore** — if area context missing,
   data-driven-generation invokes explore automatically (no manual user step)
5. **documentation="exclude"** in PRE-GEN DISCOVER — prevents RFC/docs from
   taking code result slots

## Metrics

| Metric                        | Before  | After          |
| ----------------------------- | ------- | -------------- |
| explore lines                 | 153     | 186            |
| research lines                | 119     | 0 (deleted)    |
| **Total lines**               | **272** | **186 (−36%)** |
| Skills count                  | 2       | 1              |
| search-cascade skill branches | 2       | 1              |

## Eval Results

### Iterations

| Iteration             | Evals | With-skill | Baseline | Delta |
| --------------------- | ----- | ---------- | -------- | ----- |
| 0 (original research) | 10    | 60%        | 70%      | −10pp |
| 1 (merged explore)    | 15    | 100%       | 70%      | +30pp |

### Per-eval detail

| #   | Prompt                                | Before                  | After | Finding  |
| --- | ------------------------------------- | ----------------------- | ----- | -------- |
| 1   | "retry logic... before coding"        | FAIL (circular cascade) | PASS  | #2,3     |
| 2   | "Who owns auth?"                      | FAIL (research claims)  | PASS  | #1       |
| 3   | "What changed in ingest?"             | FAIL (research claims)  | PASS  | #6       |
| 4   | "understand chunker... before modify" | FAIL (explore wins)     | PASS  | #5,8     |
| 5   | "Assess code health"                  | PASS                    | PASS  | control  |
| 6   | "Bug in enrichment"                   | PASS                    | PASS  | control  |
| 7   | "refactor reranker, research first"   | FAIL (auto-invoke ddg)  | PASS  | #4,10    |
| 8   | "Исследуй... перед тем как менять"    | PASS                    | PASS  | #9,13    |
| 9   | "Research error handling"             | PASS                    | PASS  | #12      |
| 10  | "Show pipeline architecture"          | PASS                    | PASS  | control  |
| 11  | ddg missing context                   | —                       | PASS  | subagent |
| 12  | Plan step research                    | —                       | PASS  | subagent |
| 13  | Two-part question                     | —                       | PASS  | subagent |
| 14  | Subagent no skill access              | —                       | PASS  | subagent |
| 15  | Post-brainstorming impl               | —                       | PASS  | subagent |

### Integration tests (real MCP calls)

| Test                        | Tool                          | Result               |
| --------------------------- | ----------------------------- | -------------------- |
| PRE-GEN discover (semantic) | semantic_search metaOnly=true | PASS — 5 files       |
| Explore ownership           | rank_chunks ownership         | PASS — silo labels   |
| Explore recent changes      | rank_chunks codeReview        | PASS — recent+churn  |
| PRE-GEN discover (hybrid)   | hybrid_search metaOnly=true   | PASS — docs filtered |

## Audit Findings

15 findings identified, 7 confirmed by baseline eval, all fixed:

1. Ownership queries in both skills → explore only
2. Circular delegation to search-cascade → direct tool selection
3. Risk flagging duplicates risk-assessment → delegate
4. Auto-invoke data-driven-generation → self-contained output
5. Research use cases overlap explore → research = strictly pre-gen
6. "What changed recently?" → explore only
7. Iteration loop overhead → single checkpoint
8. Missing description triggers → positive + negative triggers
9. metaOnly conflict → DISCOVER = metaOnly:true
10. Output format overlap → actionable data only
11. Rerank preset in research → removed (RA manages)
12. DEEP TRACE duplicates explore → limited to find_symbol 1-2 symbols
13. Pre-checks duplicate cascade → removed
14. post-search-validation in every skill → moved to search-cascade
15. pathPattern rules duplicated → base rule in cascade, extraction in skills

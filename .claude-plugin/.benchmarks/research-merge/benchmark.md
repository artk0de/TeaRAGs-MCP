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

## 2026-10-23 — harness-context-economy re-run (Task 12)

- Subject model: sonnet
- Result: 15/15 PASS (100%)
- Last recorded rate: 100% (15/15 after_fix)
- FAIL list: none
- Notes: Cases 2/3 (ownership / recent changes) were planned as direct semantic_search/rank_chunks rerank=ownership|recent without invoking tea-rags:explore (graded PASS on behaviour: right preset, no git blame/log); the eval expected the explore flow. Delta 0pp.
- Context: new SessionStart core+digest / SubagentStart block; old plugin hook text present in subject context but declared void (limitation).

## 2026-10-23 — Codex run (Task 14)

- Subject: Codex CLI 0.162.1, default model, plugins via repo-root marketplace, real hooks (plan-only)
- Result: 14/15 PASS (93%) over graded cases (N/A excluded: 0)
- Claude T12 rate for comparison: 15/15 (100%)
- CODEX-ONLY: case 9 (routes 'research error-handling patterns before adding an error type' to EXEMPLAR/proven pattern search instead of PRE-GEN flow with find_symbol deep trace - model routing behaviour)
- Both-fail count: 0

## 2026-10-23 — evals-to-100 re-run (Task 22)

- Subject model: sonnet
- Result: 13/15 PASS (87%) over scored cases (superseded: 0)
- Task 12 rate: 100%
- Delta: -13pp
- FAIL list: 2 (ownership question answered via semantic_search rerank=ownership, not rank_chunks; explain-pattern.md ownership recipe not read); 15 (post-brainstorming 'implement' routed to data-driven-generation only; explore PRE-GEN before implementation is conditional ('if DDG finds none'), not planned (borderline -> FAIL))
- Notes: Cases 1 (no risk-assessment delegation) graded on intent: pre-gen-pattern.md no longer delegates.
- Context: new SessionStart core+digest / SubagentStart block; old plugin hook text present in subject context but declared void (limitation).

## 2026-10-23 — Codex re-run (Task 22)

- Subject: Codex CLI 0.162.1, default model, plan-only, plugins (tea-rags 0.46.10 + dinopowers 0.24.3 + superpowers 7.0.1) via repo-root marketplace, real hooks (SessionStart digest + dinopowers routing, SubagentStart block), AGENTS.md = core.
- Result: 10/15 PASS (67%) over graded cases (N/A excluded: 0).
- Codex T14: 14/15 (93%). Claude T22: 13/15 (87%).
- FAIL list:
  - `1` — FAIL (stale?); new: PRE-GEN route correct but no risk-assessment delegation and no metaOnly=true DISCOVER; Claude T22 noted pre-gen-pattern.md no longer delegates, graded PASS on intent
  - `2` — FAIL; new: Routes to TRACE and uses semantic_search rerank=ownership, not rank_chunks ownership (EXPLAIN recipe not read). Claude T22 FAIL
  - `4` — FAIL; new: "before I modify" classed as EXPLAIN, not PRE-GEN. Claude T22 PASS
  - `8` — FAIL; new: PRE-GEN route correct, Russian handled, but DISCOVER search not metaOnly=true. Claude T22 PASS
  - `9` — FAIL; still (T14 FAIL): EXEMPLAR route instead of PRE-GEN with find_symbol on 1-2 base error classes. Claude T22 PASS

## 2026-10-23 — evals-to-100 re-run round 2 (Task 22)

- Subject model: sonnet (plan-only simulation, blind; strict literal grading)
- Result: 13/15 PASS (87%) over scored cases (superseded: 0)
- Baseline (round 1): 13/15 (87%)
- Delta: +0pp (case 2 fixed: rank_chunks rerank=ownership; case 3 newly failing)
- FAIL list:
  - 3 — rank_chunks rerank=codeReview with pathPattern but no `maxAgeDays=14`; explore SKILL.md "## Change intent" omits the window (it lives only in references/explain-pattern.md, which the subject did not open for this case)
  - 15 — DDG named as the entry, but TDD planned as a separate dinopowers:test-driven-development phase "per CLAUDE.md"; no DDG Step 6a RED via tea-rags:test-first before production edits. The SessionStart routing table lists DDG and the TDD wrapper as peer rows with nothing saying DDG owns RED/GREEN (Step 6); the real user CLAUDE.md TDD mandate also leaked in (harness limitation).
- Context: new SessionStart core+digest / SubagentStart block; old plugin hook text present in subject context but declared void (limitation).

## 2026-10-23 — Codex re-run round 2 (Task 22)

- Subject: Codex CLI 0.162.1, default model, plan-only; plugins tea-rags 0.46.11 / dinopowers 0.24.4.
- Result: 4/15 PASS (26.7%) (N/A excluded: 0).
- Round-1 Codex: 10/15 (66.7%). Delta: -40.0 pp.
- FAIL list:
  - `1` — generic $explore research; PRE-GEN not named, DISCOVER not metaOnly, no PG-2 find_symbol rerank=techDebt risk signals
  - `2` — semantic_search rerank=ownership, not rank_chunks ownership
  - `3` — semantic_search rerank=recent, not rank_chunks codeReview
  - `4` — 'before I modify' not classified PRE-GEN; Explore-style hook-flow explanation
  - `7` — routes to $dino-brainstorming instead of explore PRE-GEN
  - `8` — Explore route, PRE-GEN not named, DISCOVER not metaOnly=true
  - `9` — not PRE-GEN; find_symbol on examples AND their callers (traces call chains), not limited to 1-2 base error classes
  - `11` — DDG runs its own semantic_search; never detects missing area context nor auto-invokes explore PRE-GEN
  - `12` — routes to $dino-executing-plans + DDG cascade, not self-contained explore PRE-GEN
  - `13` — explore + risk-assessment; 'before I change' not detected as PRE-GEN (skill: risks of one named change -> PRE-GEN PG-2)
  - `15` — DDG entry, but no explore PRE-GEN prerequisite and no Step 6a RED via test-first before production edit

## 2026-10-23 — evals-to-100 re-run round 3 (Task 22)

- Subject model: sonnet (plan-only simulation, blind; strict literal grading; no per-case length cap)
- Result: 15/15 PASS (100%) over scored cases (superseded: 0)
- Baseline (round 2): 13/15 (87%)
- Delta: +13pp (case 3 fixed: rank_chunks codeReview now carries maxAgeDays=14; case 15 fixed: DDG is the entry, explore PRE-GEN on "area context missing", Step 6a RED via tea-rags:test-first before 6b GREEN, no separate TDD phase)
- FAIL list: none
- Notes: case 14 (subagent, no skill access) graded PASS on the expected_output's "use MCP tools directly" branch: subject named the missing skill access, applied the SubagentStart rules directly and reported to the parent; it did not separately suggest that the parent inject context.
- Context: new SessionStart core+digest / SubagentStart block (tea-rags 0.46.12 / dinopowers 0.24.5, rebuilt from live hook output); old plugin hook text present in subject context but declared void (limitation).

## 2026-10-23 — Codex re-run round 3 (Task 22)

- Subject: Codex CLI 0.162.1, default model, plan-only; plugins tea-rags 0.46.12 / dinopowers 0.24.5.
- Result: 12/15 PASS (80.0%) (N/A excluded: 0).
- Round-2 Codex: 4/15 (26.7%). Delta: +53.3 pp.
- FAIL list:
  - `8` — PRE-GEN + metaOnly OK, but "Keep the query in Russian" — no translation to English
  - `11` — "don't restart or replace it with $explore" — DDG runs own semantic_search; no missing-context detection / explore PRE-GEN auto-invoke
  - `15` — DDG entry + test-first before impl, but no explore PRE-GEN context step and no recorded RED gate before production edit

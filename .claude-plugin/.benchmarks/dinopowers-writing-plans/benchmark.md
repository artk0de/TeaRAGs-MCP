# dinopowers:writing-plans Optimization Benchmark

**Date:** 2026-04-20 **Skill created:**
`.claude-plugin/dinopowers/skills/writing-plans/SKILL.md` **Eval cases:** 14 (6
core-rule/tool, 3 parameters, 2 edges, 3 controls/pressure)

## Metrics

| Metric                | Value             |
| --------------------- | ----------------- |
| Lines (SKILL.md)      | 121               |
| Words (SKILL.md)      | 1039              |
| With-rule pass rate   | 100% (14/14)      |
| Without-rule baseline | 29% (4/14)        |
| Delta                 | +71pp             |
| Iterations            | 1 (no fix needed) |

## Context

Third skill of the `dinopowers` plugin. Authored via `dinopowers:writing-skills`
bootstrap. Unlike `dinopowers:brainstorming` (3 risk-preset calls on an area),
this wrapper makes ONE impact-analysis call on an explicit file list and
aggregates per-file signals for plan decomposition.

**Core value**: correct use of the established **impact-analysis idiom** —
`{imports: 0.5, churn: 0.3, ownership: 0.2}` custom rerank documented in
`tea-rags:data-driven-generation` Step 6 and `tea-rags-analytics.md`. Plans are
data-driven instead of guessed.

## Eval Cases

| ID      | Category                 | Prompt gist                                      | With-rule | Baseline |
| ------- | ------------------------ | ------------------------------------------------ | --------- | -------- |
| eval-1  | core-rule                | Refactor: extract types from tree-sitter-chunker | PASS      | FAIL     |
| eval-2  | parameters-custom-rerank | Add rerank preset — 2 files                      | PASS      | FAIL     |
| eval-3  | single-call-brace-exp    | Migration — 3 files                              | PASS      | FAIL     |
| eval-4  | tool-selection           | Reranker + contracts impact analysis             | PASS      | FAIL     |
| eval-5  | edge (no files)          | Postgres migration (architectural)               | PASS      | PASS     |
| eval-6  | edge (new files)         | New analytics module (not yet in git)            | PASS      | FAIL     |
| eval-7  | aggregation              | 5 files in derived-signals/                      | PASS      | FAIL     |
| eval-8  | ordering (plan-exec)     | Sub-plan for TreeSitterChunker split             | PASS      | FAIL     |
| eval-9  | pressure                 | "Не парься с tea-rags"                           | PASS      | FAIL     |
| eval-10 | wrong-preset-pressure    | "Используй rerank='impactAnalysis'"              | PASS      | PASS     |
| eval-11 | subagent (explore)       | Add new DTO — 3 files                            | PASS      | FAIL     |
| eval-12 | control (listing)        | "Какие файлы есть в chunker/?"                   | PASS      | PASS     |
| eval-13 | control (no file-set)    | Архитектура плагинов                             | PASS      | PASS     |
| eval-14 | parameters-metaOnly      | "Покажи содержимое в enrichment'е"               | PASS      | FAIL     |

## Key Design Decisions

1. **Single call + brace expansion over per-file calls** (Step 2). Baseline
   eval-3 confirmed agents default to N separate calls or N Read operations when
   given a file list. Brace expansion `{file1,file2,...}` + `limit: N*3` covers
   all in one roundtrip.

2. **Custom rerank weights, not named preset** (Step 2, eval-10). Project idiom
   from `tea-rags:data-driven-generation` Step 6 and `tea-rags-analytics.md`:
   `{imports: 0.5, churn: 0.3, ownership: 0.2}`. Named presets (`hotspots`,
   `codeReview`) lack the `imports` dimension. `impactAnalysis` preset does NOT
   exist — baseline eval-10 surprisingly passed (agent knew presets list), but
   explicit Iron Rule protects against drift.

3. **Aggregation by `relativePath`** (Step 3, eval-7). Plans care about files,
   not chunks. Cross-reference primary key from `tea-rags:risk-assessment` Phase
   2: MERGE. Baseline emitted chunk-level output or just Read-based exploration.

4. **New-file handling contract** (eval-6). If a file isn't in git yet, table
   shows `— (new)` — never drop the row. Baseline skipped enrichment entirely
   for new modules, hiding the "new file" signal from the plan.

5. **No-file-list fallback** (eval-5, eval-13). Architectural/conceptual plans
   with no file list → skip enrichment, invoke `superpowers:writing-plans`
   directly. Don't fabricate file list like `src/**/*.ts`. Both evals pass in
   baseline — rule doesn't erode correct natural behavior.

6. **Iron Rule at top + pressure evals** (eval-9). Baseline eval-9 complies with
   "не парься с tea-rags". Iron Rule placement resists.

7. **`metaOnly: true` locked** (eval-14). Baseline eval-14 defaults to
   `metaOnly: false` when user asks for content. Rule: separate follow-up call
   with `metaOnly: false` AFTER enrichment, never collapse.

## Bootstrap Observation

Bootstrap `semantic_search` returned:

- `tea-rags:data-driven-generation` Step 6 IMPACT (score 0.46): the exact
  `{imports: 0.5, churn: 0.3, ownership: 0.2}` weights + "Warn on high-import
  modules. Flag shared taskIds → coordinated change."
- `tea-rags:risk-assessment` Phase 2 MERGE (0.47): cross-reference by
  `relativePath` (primary key)
- `tea-rags:refactoring-scan` ENRICH (0.49): tier classification pattern
- `dinopowers:brainstorming` Step 3 (0.46): enrichment block format

Pattern extraction gave the exact set of design decisions #1-#4 without
invention. Bootstrap flow confirmed again — draft hit 100% on first iteration.

## Iteration Log

**Iteration 0 (bootstrapped draft):** 14/14 PASS with-rule. 4/14 PASS
without-rule. Delta +71pp.

No iteration needed.

## Risks and follow-ups

- **Custom-weight drift**: if `tea-rags:data-driven-generation` changes the
  idiomatic weights, this skill silently diverges. Consider extracting the
  weights into a shared constant reference (rule file or dedicated skill).

- **`imports` signal availability**: requires `CODE_ENABLE_STATIC_ANALYSIS` or
  static trajectory to be enabled. If disabled, `imports` weight in custom
  rerank is effectively zero. Add to Phase 8 integration check: verify `imports`
  signal is non-null in results before claiming impact analysis ran.

- **Large file lists (>30)**: brace expansion works but response size grows with
  `limit: N*3`. Phase 8 should test with 50+ file plans — may need chunking
  (first N files → call 1; remaining → call 2) while still aggregating by
  `relativePath`.

## 2026-10-23 — harness-context-economy re-run (Task 12)

- Subject model: sonnet
- Result: 15/15 PASS (100%) (intent-graded; evals still say custom rerank {imports,churn,ownership} but current SKILL.md prescribes rerank 'blastRadius'; subject followed SKILL.md. Strict literal grading would FAIL 1,2,3,4,9,10,11,14 on that stale rerank text)
- Last recorded rate: 14/14 (100%)
- Delta: 0pp
- FAIL list: none (stale-expectation note above)
- Context: new SessionStart core+digest / SubagentStart block; old plugin hook text present in subject context but declared void (limitation).

## 2026-10-23 — Codex run (Task 14)

- Subject: Codex CLI 0.162.1, default Codex model, plan-only, plugins (tea-rags 0.46.8 + dinopowers 0.24.2 + superpowers 7.0.1) via repo-root marketplace, real hooks (SessionStart digest + dinopowers routing, SubagentStart block).
- Result: 2/15 PASS (13%) over graded cases (N/A excluded: 0).
- Claude T12 for comparison: 15/15 (100%).
- CODEX-ONLY (harness regression candidates):
  - `eval-1` — no ONE brace-expanded semantic_search impact enrichment (blastRadius) before $writing-plans; used find_symbol/hybrid_search/get_callers instead (wrapper Step 2 not followed) [skill body not applied / model behaviour]
  - `eval-2` — no ONE brace-expanded semantic_search impact enrichment (blastRadius) before $writing-plans; used find_symbol/hybrid_search/get_callers instead (wrapper Step 2 not followed) [skill body not applied / model behaviour]
  - `eval-3` — no ONE brace-expanded semantic_search impact enrichment (blastRadius) before $writing-plans; used find_symbol/hybrid_search/get_callers instead (wrapper Step 2 not followed) [skill body not applied / model behaviour]
  - `eval-4` — no ONE brace-expanded semantic_search impact enrichment (blastRadius) before $writing-plans; used find_symbol/hybrid_search/get_callers instead (wrapper Step 2 not followed) [skill body not applied / model behaviour]
  - `eval-6` — no ONE brace-expanded semantic_search impact enrichment (blastRadius) before $writing-plans; used find_symbol/hybrid_search/get_callers instead (wrapper Step 2 not followed) [skill body not applied / model behaviour]
  - `eval-7` — no per-file aggregation table (dominantAuthor/commitCount/ageDays/bugFixRate/taskIds) or shared-taskId coordinated-change candidates; no enrichment call [model behaviour]
  - `eval-8` — no ONE brace-expanded semantic_search impact enrichment (blastRadius) before $writing-plans; used find_symbol/hybrid_search/get_callers instead (wrapper Step 2 not followed) [skill body not applied / model behaviour]
  - `eval-9` — no ONE brace-expanded semantic_search impact enrichment (blastRadius) before $writing-plans; used find_symbol/hybrid_search/get_callers instead (wrapper Step 2 not followed) [skill body not applied / model behaviour]
  - `eval-10` — no ONE brace-expanded semantic_search impact enrichment (blastRadius) before $writing-plans; used find_symbol/hybrid_search/get_callers instead (wrapper Step 2 not followed) [skill body not applied / model behaviour]
  - `eval-11` — no ONE brace-expanded semantic_search impact enrichment (blastRadius) before $writing-plans; used find_symbol/hybrid_search/get_callers instead (wrapper Step 2 not followed) [skill body not applied / model behaviour]
  - `eval-14` — no ONE brace-expanded semantic_search impact enrichment (blastRadius) before $writing-plans; used find_symbol/hybrid_search/get_callers instead (wrapper Step 2 not followed) [skill body not applied / model behaviour]
  - `eval-5` — no-file-list edge: invoked $dino-brainstorming and ran an un-pathPattern'd semantic_search instead of reporting 'no file list' and going to $writing-plans directly [model behaviour]
  - `eval-15` — Task name VendorEnvelopeFetcher never checked: get_naming_lexicon called for 'scope' without names=[...] and no MISFIT/NEW_TERM verdict before fixing the name [model behaviour]
- Both-fail count: 0.

## 2026-10-23 — Cursor run (Task 15)

- Subject: Cursor CLI (`agent` 2026.10.22-27dcf5f), model `auto`, plugins from harness/cursor (tea-rags + dinopowers), sessionStart hook digest, plan-only.
- Partial run — Cursor free-plan usage limit stopped the eval after 7 of 45 parts.
- Result: 14/15 PASS (93%) over 15 graded cases (N/A excluded: 0)
- Claude T12 for comparison: 15/15 (100%); Codex T14: 2/15 (13%)
- CURSOR-ONLY: none
- Both-fail (all) count: 0
- FAIL list: eval-9 (vs-claude) - Skips Step 2-3 enrichment on user "не парься с tea-rags" ("user override beats Iron Rule"); expected enrichment under pressure. Codex also FAIL.
- Notes: Intent-graded: rerank "blastRadius" accepted instead of stale custom {imports,churn,ownership} (same as Claude T12); [no-superpowers] on chaining into writing-plans.

## 2026-10-23 — evals-to-100 re-run (Task 22)

- Subject model: sonnet (plan-only simulation, blind)
- Result: 15/15 PASS (100%) over 15 scored cases (0 superseded); intent-graded (evals still cite custom rerank, SKILL.md prescribes blastRadius)
- Task 12 rate: 15/15 (100%)
- Delta: 0pp
- FAIL list: none
- Context: new SessionStart core+digest / SubagentStart block; old plugin hook text present in subject context but declared void (limitation).

## 2026-10-23 — Codex re-run (Task 22)

- Subject: Codex CLI 0.162.1, default model, plugins via repo-root marketplace (tea-rags 0.46.10 + dinopowers 0.24.3 + superpowers 7.0.1), real hooks (plan-only)
- Result: 14/15 PASS (93%) over 15 graded cases (N/A 0); intent-graded on rerank (expected/ still cites custom weights, stale?)
- Codex T14 for comparison: 2/15 (13%)
- Claude T22 for comparison: 15/15 (100%)
- FAIL list:
  - ` eval-7 ` — FAIL ( still; Claude T22 PASS ) aggregation: one row per file + shared taskIds, but never names dominantAuthor/commitCount/ageDays/bugFixRate/taskIds fields 

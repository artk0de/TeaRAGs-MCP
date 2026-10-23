# tea-rags:pattern-search Optimization Benchmark

**Date:** 2026-04-21 **Eval cases:** 14

| Metric    | Value        |
| --------- | ------------ |
| With-rule | 100% (14/14) |
| Baseline  | 21% (3/14)   |
| Delta     | +79pp        |

## Core Value

4-phase SEED → EXPAND → DEDUPLICATE → GROUP flow with strategy-driven rerank
selection (collect/spread/antipattern/reference → different presets or custom
weights), mandatory find_similar expansion, content-overlap dedup (>80% same-dir
only), module-grouped output with overlay labels, and strategy-specific output
markers (⚠️ for antipattern, ✓ for reference).

## Failure Analysis (baseline 11/14 FAIL)

1. **EXPAND step always skipped** (evals 1, 2, 4, 5) — baseline runs ONE search,
   reads results, doesn't systematically `find_similar` from each seed
2. **Reference-strategy custom weights** (eval-3) — baseline picks named
   `proven`/`stable` preset instead of constructing
   `{similarity:0.2, stability:0.3, age:0.3, bugFix:-0.15, ownership:-0.05}`
3. **Cross-domain diversification** (eval-4) — baseline doesn't run additional
   semantic_search with pathPattern excluding found modules
4. **Content-overlap dedup** (eval-6) — baseline has no formal >80%-same-dir
   rule
5. **Group-by-module output** (eval-7) — baseline lists results flat, omits
   overlay labels
6. **Rule 2 CRITICAL — no built-in grep/ripgrep-only-as-fallback** (eval-9) —
   baseline treats ripgrep as first choice for regex, violates cascade
   discipline
7. **Rule 1 Execute-YOURSELF** (eval-10) — baseline delegates broad-scope to
   subagent
8. **Output markers** (evals 11, 12) — baseline uses plain text labels, no ⚠️/✓
   convention
9. **Post-search-validation** (eval-14) — baseline jumps SEED→EXPAND without
   validation gate

## Delta Interpretation

+79pp. Baseline gets 3 correct cases:

- eval-5 (always-EXPAND reasoning under "skip, enough results" pressure —
  natural to continue)
- eval-8 (metaOnly=false — natural to want content for matching)
- eval-13 (single-entity routing to find_symbol — obvious)

Everything else requires the skill's formal 4-phase protocol + strategy table +
output conventions.

## Iteration Log

**Iteration 0:** 14/14 with-rule, 3/14 baseline (21%), delta +79pp. No fix
needed.

## 2026-10-23 — harness-context-economy re-run (Task 12)

- Subject model: sonnet
- Result: 13/14 PASS (93%)
- Last recorded rate: 100% (14/14 with-rule, iteration 0)
- FAIL list: eval-14 (after SEED, before EXPAND: subject noted chunk ids/seen paths but omitted the post-search validation step - no-match detection + disambiguation). Cause: pattern-search SKILL.md has no validation step; that content now lives in rules/guides/navigation.md and the subject did not read it for this case.
- Notes: Delta -7pp. Subject read tea-rags://guide/decision-tree.
- Context: new SessionStart core+digest / SubagentStart block; old plugin hook text present in subject context but declared void (limitation).

## 2026-10-23 — Codex run (Task 14)

- Subject: Codex CLI 0.162.1, default model, plan-only, plugins via repo-root marketplace, real hooks (SessionStart digest + dinopowers routing, SubagentStart block), AGENTS.md = core
- Result: 4/14 PASS (29%) over 14 graded cases (N/A: 0)
- Claude T12 for comparison: 13/14 (93%)
- Both-fail: 0
- CODEX-ONLY (10):
  - `eval-1` — no rerank=relevance/metaOnly=false, EXPAND only "if gaps" not from each seed; pattern-search SKILL.md deferred, not read
  - `eval-2` — no techDebt/refactoring rerank, EXPAND optional
  - `eval-3` — no custom proven weights, EXPAND "only if needed" not from single best seed
  - `eval-4` — no relevance rerank, no cross-domain pathPattern-exclusion semantic_search
  - `eval-5` — skips EXPAND (violates Rule 4 always-expand)
  - `eval-6` — drops chunk without richer-signals comparison and omits the different-dir keep-both rule
  - `eval-7` — no group-by-module, no overlay labels in output
  - `eval-10` — would delegate to a subagent; expected refusal (Rule 1 execute yourself)
  - `eval-11` — no warning-sign marker prefix named
  - `eval-12` — no check-mark marker named for best example

## 2026-10-23 — Cursor run (Task 15)

- Subject: Cursor CLI (`agent` 2026.10.22-27dcf5f), model `auto`, plugins from harness/cursor (tea-rags + dinopowers), sessionStart hook digest, plan-only.
- Partial run — Cursor free-plan usage limit stopped the eval after 7 of 45 parts.
- Result: 13/14 PASS (93%) over 14 graded cases (N/A excluded: 0)
- Claude T12 for comparison: 13/14 (93%); Codex T14: 4/14 (29%)
- CURSOR-ONLY: none
- Both-fail (all) count: 0
- FAIL list: eval-14 (vs-codex) - Notes chunk IDs and asks on 2+ unrelated clusters (disambiguation) but no no-match detection step; Claude also FAIL, Codex PASS.

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

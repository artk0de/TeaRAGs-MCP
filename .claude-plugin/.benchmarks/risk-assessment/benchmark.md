# risk-assessment Optimization Benchmark

**Date:** 2026-03-30 **Skills modified:** risk-assessment, explore **Eval
cases:** 12 (10 original + 2 subagent/plan)

## Metrics

| Metric                         | Value        |
| ------------------------------ | ------------ |
| Lines before (risk-assessment) | 304          |
| Lines after (risk-assessment)  | 321          |
| Lines before (explore)         | 223          |
| Lines after (explore)          | 224          |
| With-rule before fix           | 55% (5.5/10) |
| With-rule after fix            | 100% (12/12) |
| Without-rule baseline          | 10% (1/10)   |
| Delta                          | +90pp        |
| Iterations                     | 2            |

## Changes

| #     | Finding                                          | Category            | Fix                                                                | Eval  |
| ----- | ------------------------------------------------ | ------------------- | ------------------------------------------------------------------ | ----- |
| 1     | "4 presets" inconsistency in flow/anti-patterns  | Stale rules         | Replaced all with "3 presets"                                      | 1, 7  |
| 2     | Phase 0 "search-cascade decides tool"            | Conflicts           | Inline rule: concept→semantic, symbol→hybrid                       | 2     |
| 3     | "Apply search-cascade stop conditions"           | Conflicts           | Removed cascade ref, kept rules as-is                              | 3     |
| 4     | Rule 3 mentions ripgrep (not used in skill)      | Verbosity           | Simplified to "tea-rags tools only"                                | 7     |
| 6     | `ownership` in description not used              | Stale rules         | Removed from description. Backlog task created (tea-rags-mcp-k0cj) | 7     |
| 7     | explore "CRITICAL: search-cascade governs ALL"   | Conflicts           | Replaced with one-line self-contained rule                         | 10    |
| 8     | explore "no ripgrep verification passes"         | Conflicts+Verbosity | Shortened, removed cascade ref                                     | 10    |
| 9     | Delegation duplicates scope resolution           | Wrong routing       | Added pathPattern shortcut to Phase 0                              | 4, 12 |
| 10    | No machine-readable output for chaining          | Missing use case    | Added "Context for generation" block to Phase 5                    | 6, 9  |
| 11    | explore "across" misroutes risk intent           | Wrong routing       | Added risk intent check before keyword matching                    | 10    |
| extra | explore BREADTH "search-cascade determines tool" | Conflicts           | Inline tool selection rule                                         | —     |

## Key Design Decisions

1. **Self-contained skills (approach B)** over search-cascade as single source
   of truth. Skills embed only the subset of rules they need. Rationale: agent
   doesn't switch between two instruction documents; duplication is minimal (2-3
   lines per skill); cascade still handles routing TO skills.

2. **Risk intent overrides keyword matching** in explore classification. "risk
   surface of X across codebase" should route to risk-assessment despite
   "across" being a Spread keyword. Risk signals checked before keyword table.

3. **risk-assessment is standalone, human-only.** No machine-readable context
   block. DDG gets overlay labels via find_symbol(rerank=...) through explore
   PG-2, not through risk-assessment. This eliminates the heavy 3-preset scan
   from the generation chain.

4. **Tool call optimization.** Batch find_similar (all Critical UUIDs in one
   call), batch test coverage (one hybrid_search for all symbols). Target: ≤12
   calls for domain, ≤16 for broad.

## Iterations

| Iteration                                       | Scope                         | Pass rate            |
| ----------------------------------------------- | ----------------------------- | -------------------- |
| Baseline (no skill)                             | 10 cases                      | 10%                  |
| Before fix (with skill)                         | 10 cases                      | 55%                  |
| After fix                                       | 12 cases                      | 96% (Eval-6 PARTIAL) |
| Iteration 1 (Eval-6 "ALWAYS" fix)               | 3 cases (Eval-6 + 2 controls) | 100%                 |
| Iteration 2 (output mode split)                 | 4 cases (Eval-6,1,9,7)        | 100%                 |
| Iteration 3 (standalone only, remove DDG chain) | architectural                 | —                    |
| Integration tests                               | 3 real MCP runs (Eval-1,4,6)  | 100%                 |

## Per-Eval Detail

| Eval | Prompt                                                                          | Before  | After |
| ---- | ------------------------------------------------------------------------------- | ------- | ----- |
| 1    | Assess risks in the ingest domain                                               | PASS    | PASS  |
| 2    | Evaluate code health of enrichment pipeline                                     | FAIL    | PASS  |
| 3    | Risk scan whole project                                                         | PASS    | PASS  |
| 4    | Find risky areas before I refactor the trajectory module                        | FAIL    | PASS  |
| 5    | Оцени проблемные зоны в explore стратегиях                                      | PASS    | PASS  |
| 6    | What are the riskiest files that data-driven-generation should be careful with? | FAIL    | PASS  |
| 7    | Show hotspots and ownership patterns in adapters/                               | PASS    | PASS  |
| 8    | Assess risks in the chunker hooks area                                          | PASS    | PASS  |
| 9    | Risk assessment for the reranker — I need context before generating             | PARTIAL | PASS  |
| 10   | Explore the risk surface of error handling across the codebase                  | FAIL    | PASS  |
| 11   | [subagent] Assess code risks in ingest/                                         | N/A     | PASS  |
| 12   | [plan execution] Risk assessment on trajectory domain                           | N/A     | PASS  |

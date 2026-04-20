# dinopowers:finishing-a-development-branch Optimization Benchmark

**Date:** 2026-04-20 **Eval cases:** 13

| Metric    | Value        |
| --------- | ------------ |
| With-rule | 100% (13/13) |
| Baseline  | 38% (5/13)   |
| Delta     | +62pp        |

## Core Value

Second composition-style wrapper (after systematic-debugging). Delegates to
`Skill(tea-rags:risk-assessment)` on the FULL branch diff (not last commit)
BEFORE presenting completion options. Multi-preset convergence (hotspots +
ownership + techDebt) surfaces Critical/High risk zones the branch touched that
tests don't cover.

## Key Design

1. **Compose via `tea-rags:risk-assessment` skill** — same pattern as
   `dinopowers:systematic-debugging` delegating to `bug-hunt`. Direct
   `semantic_search` misses multi-preset convergence.
2. **Full branch scope, not last commit** (eval-3, eval-11) —
   `git diff base...HEAD`, not `HEAD~1..HEAD`. Branch risk surface ≠ last
   commit's risk.
3. **Trivial-scope skip** for docs-only, renames-only, 0-commits-ahead (eval-5,
   eval-6).
4. **Unindexed-branch honesty** (eval-7) — note limitation, don't fabricate
   tiers.
5. **Green-tests ≠ clean-scan** (eval-10) — tests miss hotspot/silo/debt
   convergence by design.
6. **Distinct from verification-before-completion** — that is per-edit
   blast-radius; this is branch-wide multi-signal risk tier.

## Delta

+62pp. Baseline correctly handles trivial cases (eval-3, 5, 6, 9, 13). Fails at:
wrapper delegation (1, 2, 4, 12), pressure resistance (10, 11), unindexed
discipline (7), critical-first gating (8).

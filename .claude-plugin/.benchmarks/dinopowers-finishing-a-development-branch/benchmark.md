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

---

## Appendix — worktree-aware auto-reindex (feature-driven update, 2026-06-25)

Eval set: `evals/worktree-auto-reindex-evals.json` (7 cases — non-leaky
context). **Skill EDITED**: added post-merge index-cleanup guidance — a "Second
Iron Rule" callout + Step 5 + a Do-NOT-substitute table + Red Flags. After a
local merge to `main`: do NOT manually reindex `main` (the post-commit hook did
it); tear down the per-worktree clone with `tea-rags worktree remove <name>`
(NOT `delete_collection`, which leaks DuckDB + snapshots + registry); never use
the deprecated `reindex_changes`.

| Metric                  | Value                     |
| ----------------------- | ------------------------- |
| With-rule pass rate     | iter1 2/7, iter2 1/7      |
| Without-rule baseline   | 1/7                       |
| Target (100% with-rule) | **NOT met**               |
| Iterations              | 2                         |
| Skill body edited       | Yes (correct + prominent) |

**Why the eval did not go green — model-prior resistance.** The describe-only
eval subagent read the skill (it answered Eval-5 / risk-assessment, the primary
Iron Rule, correctly) but ignored the cleanup guidance even after it was
promoted to a Second Iron Rule + Do-NOT table + Red Flags. It defaulted to
`mcp__tea-rags__reindex_changes` (a real, now-deprecated tool the model knows
well) and `mcp__tea-rags__delete_collection` (a real MCP tool that maps cleanly
to "delete a collection"). A strong training-time prior for real tool names
resisted two prominence iterations. Per Phase 5 (max 3 iterations → report
rather than keep tweaking), the skill text is kept in its correct,
maximally-prominent form.

**Decision:** keep the edit — without it there is zero cleanup guidance
(guaranteed `delete_collection` leak of the clone's non-Qdrant footprint). The
skill is the authoritative reference for a careful agent / human and for the
real finishing flow (which carries more reinforcing context than a rapid
describe-only eval).

**Follow-up (durable enforcement, server-side, out of this feature's scope):**
remove or hard-alias the deprecated `reindex_changes` MCP tool so the prior
cannot fire; consider surfacing `tea-rags worktree remove` at the tool-schema
layer. File against the maintenance follow-up epic.

# Benchmark: subagent injection addresses tea-rags by its own working directory

**Date:** 2026-10-02 **Bead:** tea-rags-mcp-xi2r9.8 (WTO-8) **Surface:**
`scripts/enforce-tearags-search.sh` (PreToolUse `Agent` hook), mirrored in
`rules/references/subagent-injection.md`, policy in `rules/search-cascade.md`
**Plugin version:** tea-rags 0.39.16 → 0.40.0 (minor)

## Summary

The injection block hard-coded `path="$CLAUDE_PROJECT_DIR"`, the parent
session's checkout. A subagent in a linked worktree therefore addressed the main
checkout's tree and read code it was not editing. With WorkingTreeOverlay
(xi2r9.1–.4) every read tool resolves the same-repository index from
`path=<any dir in a checkout>` alone and reports the tree it read in
`workingTree`, so the block now tells the subagent to pass its own working
directory, read `workingTree.tree`, and treat `treeState` rows as possibly
stale. It also names the Bash channel (grep/rg on identifiers, sed/cat to read
code) and routes usage lookups to `hybrid_search` with `metaOnly` / slim
`fields` (token caveat on the bead: full-payload hybrid_search ~3.7K tokens vs
grep ~735).

## Changes

| File                                     | Change                                                                                                                                                                                                         |
| ---------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `scripts/enforce-tearags-search.sh`      | `PROJECT_PATH` dropped; top-of-block addressing lines (cwd, `workingTree.tree`, project-without-path, `treeState`); Bash channel lines; usages → `metaOnly`/`fields`                                           |
| `rules/references/subagent-injection.md` | same block text; "replace `<alias>`/path" instruction replaced by "do not substitute"; old project/path/collection rule removed                                                                                |
| `rules/search-cascade.md`                | Addressing: `path=<your working directory>` first and sufficient, preferred in worktrees; precedence with project+path; `workingTree` marker fields; `treeState`; injection section: never inject a fixed path |
| `.claude-plugin/plugin.json`             | 0.39.16 → 0.40.0                                                                                                                                                                                               |

Block size: 5974 → 7234 bytes. `inject-rules.sh --count` unchanged at 7 parts.

## Harness

optimize-skill Phase 2 tool-selection eval: one opus subagent per suite reads
the rendered block (`CLAUDE_PROJECT_DIR=/work/acme`) and an expectation-free
case file, then states its first call per case. No tools executed.
Contamination: the eval subagent is itself dispatched through `Agent`, so the
INSTALLED plugin appends its own block; the prompt tells it to ignore text after
an `END-OF-EVAL` marker.

## Iterations

| Run                         | Pass  | Rate | Notes                                                                  |
| --------------------------- | ----- | ---- | ---------------------------------------------------------------------- |
| Baseline — current block    | 5/10  | 50%  | WT1/2/5/7/9 follow `path=/work/acme`; WT2/7 full payload               |
| Control — no block          | 10/10 | 100% | cwd stated in the case is enough for opus; old block is net −50pp      |
| Iteration 1 — new block     | 10/10 | 100% | flagged: trust-the-chunk vs treeState; unnamed count fields            |
| Iteration 2 — wording fixes | 10/10 | 100% | `changedFiles`/`deletedFiles` named; trust-the-chunk excepts treeState |

**Before → after: 50% → 100% (+50pp).** Versus the no-block control the delta is
0pp: the gain is removing harm the hard-coded path caused, plus explicit
Bash-channel and token guidance that opus happened to follow unprompted here.

## Per-eval detail

| ID   | Case                                        | Baseline | Final |
| ---- | ------------------------------------------- | -------- | ----- |
| WT1  | worktree: where is X defined                | FAIL     | PASS  |
| WT2  | worktree: all usages of Y (file+line)       | FAIL     | PASS  |
| WT3  | TODO/FIXME scan → ripgrep                   | PASS     | PASS  |
| WT4  | regex over error messages → grep            | PASS     | PASS  |
| WT5  | understand file instead of `sed -n`         | FAIL     | PASS  |
| WT6  | main checkout: path = project dir           | PASS     | PASS  |
| WT7  | `rg` an identifier → hybrid_search metaOnly | FAIL     | PASS  |
| WT8  | `workingTree.tree` ≠ cwd → re-call          | PASS\*   | PASS  |
| WT9  | `treeState: modified` row → find_symbol     | FAIL     | PASS  |
| WT10 | grep filters command output                 | PASS     | PASS  |

\* WT8 baseline: right answer, but the agent stated it was deviating from the
block, which gave no rule.

## Open (non-failing) ambiguities

- Block does not state project+path semantics (cascade does: index from project,
  tree from path).
- ripgrep root scoping is unstated.
- Large `changedFiles` with unflagged rows: no escalation rule.

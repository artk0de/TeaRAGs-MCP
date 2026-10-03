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

## Overlay wave (2026-10-03, epic xi2r9, tea-rags 0.40.0 → 0.40.1)

### Changes

| File                                     | Change                                                                                                                                                                                                                                                                                                                                                                      |
| ---------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `rules/references/subagent-injection.md` | Single source of the block. Addressing paragraph: every tool — search, find_symbol, graph tools, review_changes, get_naming_lexicon — takes the same `path`; `floors` named (`chunks`/`sparse`/`codegraph`), outside them = index. New Tool-selection branch: impact / call graph → get_callers / get_callees / trace_path, branch review → review_changes `changes={base}` |
| `scripts/enforce-tearags-search.sh`      | No inline copy: reads the first fenced block under "## The block to inject" from the reference file (awk) and appends it; missing block → no injection, exit 0. Emitted block == reference byte-for-byte                                                                                                                                                                    |
| `rules/search-cascade.md`                | "Addressing the Codebase": tool list incl. graph tools / review_changes / get_naming_lexicon / analytics presets; subagent in a worktree → same `path`, full toolset; `codegraph` floor                                                                                                                                                                                     |

The reference block previously diverged from the hook (it carried a "Typed
filters" section the hook never emitted, and lacked the symbolId convention).
The hook's text was the evaluated one, so it became canonical; typed filters
remain owned by `/tea-rags:filter-building`.

Block size: **7233 → 8236 bytes (+1003, +13.9%)** at the end of the wave: +293
addressing paragraph, +260 graph-routing branch, then the defect-closure lines
(graph answer without a `codegraph` floor, override scope, wrong-tree rule,
regex → ripgrep); the redundant closing addressing rule was dropped (−70).

### Cases added

| ID   | Case                                                         | Expected                                                      |
| ---- | ------------------------------------------------------------ | ------------------------------------------------------------- |
| WT11 | worktree: who calls `ChunkCache#evict` (impact of a change)  | `get_callers symbolId=ChunkCache#evict path=<cwd>`            |
| WT12 | worktree: call chain to `WorkingTreeDelta#compute` + floors  | `trace_path from/to path=<cwd>`; codegraph floor = tree edges |
| WT13 | worktree: naming + architecture review of the branch vs main | `review_changes path=<cwd> changes={base:"main"}`             |

### Iterations

| Run         | Pass  | Rate | Notes                                                                                    |
| ----------- | ----- | ---- | ---------------------------------------------------------------------------------------- |
| Iteration 3 | 12/13 | 92%  | WT11 FAIL: first call hybrid_search ("all callers" usage branch), get_callers only after |
| Iteration 4 | 13/13 | 100% | graph-routing branch added; WT2 (usage listing) still → hybrid_search metaOnly           |

WT1–WT10 stayed PASS in both runs (10/10 → 10/10). Answers:
`workspace/iteration-{3,4}-answers.md`.

Open (non-failing): "all callers" still sits in the usage branch (impact vs
listing decides); no stated fallback when a graph answer lacks the `codegraph`
floor; ripgrep root scoping unstated.

### Defect-closure rounds (owner policy: every defect found is fixed)

| Run          | Pass  | Rate | Notes                                                                                                                        |
| ------------ | ----- | ---- | ---------------------------------------------------------------------------------------------------------------------------- |
| Iteration 5  | 14/14 | 100% | WT14 added (graph answer, no `codegraph` floor, `changedFiles` 5): trust untouched-file edges, re-check changed ones         |
| Iteration 6  | 13/14 | 93%  | WT2 FAIL → `get_callers`: the graph branch sat above the usage branch and "every place that calls" matched first             |
| Iteration 7  | 14/14 | 100% | graph branch scoped to impact + "plain usage listing → next branch"; regex over text routed to ripgrep in the selection list |
| Iteration 8  | 14/14 | 100% | override scoped to Grep/Glob/Read routing (a skill's tea-rags choice stands); `treeState` exception points to `find_symbol`  |
| Iteration 9  | 14/14 | 100% | 2 contradictions left: "every read call" vs a skill-named checkout; `hybrid_search` re-check vs `treeState` rows             |
| Iteration 10 | 14/14 | 100% | both fixed; **0 contradictions inside the block**                                                                            |

Answers: `workspace/iteration-{5..10}-answers.md`. The hook output equals the
reference block byte-for-byte after every revision.

## Dense floor wave (2026-10-03, epic xi2r9 WTO-5, tea-rags 0.40.1 → 0.40.2)

### Changes

| File                                     | Change                                                                                                                                                                                     |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `rules/references/subagent-injection.md` | `floors` gains `dense` (semantic_search / find_similar / hybrid vector ranking) and `chunks` names rank_chunks rows; `denseUnavailable` / `treeGraphUnavailable` say why a layer fell back |
| `rules/search-cascade.md`                | same floor vocabulary; a `treeState` row is served only when no tree floor covered it (e.g. `denseUnavailable`)                                                                            |

Block size: **8236 → 8404 bytes (+168, +2.0%)**.

### Cases added

| ID   | Case                                                                | Expected                                                 |
| ---- | ------------------------------------------------------------------- | -------------------------------------------------------- |
| WT15 | semantic_search row of a branch-added file, floors `[chunks,dense]` | row is current; whole class → `find_symbol` path=`<cwd>` |
| WT16 | `treeState: modified` row, floors `[]`, `denseUnavailable`          | row stale; `find_symbol` path=`<cwd>`; no reindex        |
| WT17 | find code similar to a chunk of a branch-changed file (id given)    | `find_similar positiveIds=[id] path=<cwd>`               |

### Iterations

| Run          | Pass  | Rate | Notes                                             |
| ------------ | ----- | ---- | ------------------------------------------------- |
| Iteration 11 | 17/17 | 100% | WT1–WT14 unchanged PASS; WT15–WT17 PASS first run |

Answers: `workspace/iteration-11-answers.md`.

# Worktree-aware auto-reindex — design

Date: 2026-06-24 Status: approved (design) Scope: Claude Code integration
(plugins `tea-rags` + `dinopowers`), no `src/core` changes Relates to:
`2026-06-24-tea-rags-worktree-design.md` (the `tea-rags worktree` CLI this
builds on)

## Problem

tea-rags/dinopowers skills do not reindex during work, so mid-task searches read
stale payloads. The current freshness mechanism (`dinopowers/FRESHNESS.md`)
fails on three counts:

1. **Soft, skippable.** It is a manual "Step 0" checklist the agent must
   remember before every tea-rags call. Agents skip it.
2. **Wrapper-only.** It lives inside dinopowers wrappers; bare
   `mcp__tea-rags__*` calls and commits made inside subagents are not covered.
3. **Deprecated endpoint.** It calls `reindex_changes`, which is deprecated. The
   canonical incremental entrypoint is `index_codebase`.

FRESHNESS.md itself promised a hook-based replacement ("Long-term: a hook-based
auto-reindex … would make this protocol unnecessary. Until that's built …") that
was never built. This deliverable builds it.

## Goal

Make incremental reindex happen automatically at the right git-workflow events,
targeting the right collection, and encode the "when to reindex" knowledge in
both the tea-rags canon and the dinopowers wrappers.

This is **deliverable A** of a two-part effort. Deliverable B (worktree-clone
activation policy — when to _create_ a clone: not-gigantic-index gate,
explore-only stays on main, large-WIP triggers a clone) is a separate later
brainstorm. A handles the lifecycle of a clone that _may_ exist; B decides
whether one is created.

## Trigger taxonomy (the canonical knowledge)

The reindex trigger is **git-workflow events**, not per-edit. A commit is a
natural checkpoint, and the incremental diff since the last index is exactly the
committed change — no thrashing on burst edits.

| Event                                                  | Action                                 | Target                        | Gate                               |
| ------------------------------------------------------ | -------------------------------------- | ----------------------------- | ---------------------------------- |
| Commit on a worktree branch (plain or subagent-driven) | `index_codebase` incremental           | worktree clone (cwd-resolved) | auto — clone is throwaway          |
| Merge into `main`                                      | `index_codebase` incremental           | `main` collection             | the merge act IS the explicit gate |
| Branch finished (post-merge)                           | `tea-rags worktree remove`             | clone footprint dropped       | skill-only (not a git event)       |
| Edited-but-uncommitted before a search                 | manual `index_codebase` (escape hatch) | current collection            | commit boundary is primary         |
| Schema drift                                           | `force_reindex`                        | —                             | explicit consent (unchanged)       |

Reconciliation with the existing "reindex is always user-gated" rule:
incremental `index_codebase` on a throwaway clone is safe and needs no gate;
`index_codebase` on `main` is gated by the merge itself (you do not merge by
accident). Full `force_reindex` still requires explicit consent and is out of
scope here.

## Component 1 — enforcement hook (the backstop)

A new `PostToolUse` hook on `Bash`, registered in the **tea-rags** plugin
manifest (`tea-rags` owns the index; the hook is tool-level so it also covers
commits made inside subagents and bare sessions, which is where the
soft-instruction approach fails).

Script: `.claude-plugin/tea-rags/scripts/reindex-on-git-commit.sh` (peer to
`inject-rules.sh`, `enforce-tearags-search.sh`).

Behavior:

1. **Detect** a successful `git commit` or `git merge` from the PostToolUse
   payload: the invoked command contains `git commit` / `git merge` AND the tool
   exited 0. Substring detection is a heuristic backstop — it covers the common
   case; the skill-knowledge layer (Component 2) carries the deliberate
   orchestration.
2. **Resolve the target collection from `cwd`** via the tea-rags registry
   (path-hash → alias). A worktree path resolves to its clone alias
   (`<project>-worktree-<name>`); a main checkout resolves to the main alias.
3. **Execute** `tea-rags index-codebase --project <alias> --json` **without**
   `--wait-enrichments` — this is the "block fast-embed, detach enrichment"
   mode. The hook runs the CLI in the foreground and waits for it to return; the
   CLI returns once the embedding phase for the committed diff (a few files,
   ~1–3 s) has stored, so the semantic layer is immediately fresh for the next
   search, while codegraph/git enrichment detaches to the background. The ~1–3 s
   the hook adds to the commit's turn is the deliberately chosen tradeoff
   (search correctness over commit latency); enrichment cost is never on the
   turn.
4. **Edge — cwd not registered** (bare git worktree with no tea-rags clone): the
   committed files live at a path that is not in any collection's snapshot.
   **Skip** with a logged note — do not pollute `main` with files at the wrong
   path.
5. **Idempotency**: re-indexing unchanged files is a near-noop — the merkle/hash
   `needsReindex` check returns false. So a double fire (hook + skill-knowledge)
   is harmless; no dedup machinery is required.
6. **No cleanup here.** Clone removal is not a git event and cannot be inferred
   from a merge (merges also happen mid-development). Cleanup is skill-only
   (Component 2, `finishing-a-development-branch`).

The hook performs no `force_reindex` and no full rebuild — incremental only.

## Component 2 — skill-knowledge wiring

The hook is the enforcement backstop; the wrappers carry the deliberate,
context-bearing orchestration (which needs the worktree alias and the
branch-is-done signal the hook cannot see).

- **`tea-rags/rules/index-freshness.md`** — add the trigger-taxonomy table above
  as the canonical reference. This file is auto-injected via `inject-rules.sh`,
  so the knowledge reaches every session (wrapped or not).
- **`dinopowers/FRESHNESS.md`** — rewrite: commit-driven triggers,
  `index_codebase` (not `reindex_changes`), defer to the tea-rags canon, drop
  the per-search manual checklist as the primary path (the hook covers it), keep
  the manual escape hatch for searching uncommitted WIP.
- **`dinopowers:executing-plans`** and **`dinopowers:test-driven-development`**
  — add a note: after committing a task the hook reindexes the worktree; to
  search uncommitted WIP, reindex manually.
- **`dinopowers:finishing-a-development-branch`** — add the merge orchestration:
  after a successful merge to `main` (the hook reindexes `main`), run
  `tea-rags worktree remove <name>` to drop the clone footprint. This is the
  cleanup-on-merge.
- **`subagent-driven-development`** — no dinopowers wrapper exists, so the hook
  is the mechanism there. Add a one-line pointer in the tea-rags canon for
  discoverability.

### Method: SKILL.md changes go through `/optimize-skill`

The three wrapper edits above touch `SKILL.md` files. Each is applied via the
`/optimize-skill` eval cycle, NOT ad-hoc editing: audit → baseline eval (with /
without the change) → fix → verify to 100% with-rule pass → PERSIST benchmark
artifacts (`evals.json` + `benchmark.md`) under
`.claude-plugin/.benchmarks/<skill>/`. This measures that the new freshness
guidance actually changes agent behavior (delta ≥ +50pp target) rather than
adding dead instruction weight. Plain rules and docs
(`tea-rags/rules/index-freshness.md`, `dinopowers/FRESHNESS.md`) and the hook
script are NOT SKILL.md files — they are edited normally and covered by the hook
unit test and the freshness eval, not the optimize-skill cycle.

## Component 3 — deprecation sweep

Replace every `reindex_changes` reference with `index_codebase` across
`dinopowers/FRESHNESS.md`, wrapper skill text, and tea-rags rules.

## Versioning

- `tea-rags` plugin `0.27.0` → `0.28.0` (new hook = feature).
- `dinopowers` plugin `0.18.0` → `0.19.0` (FRESHNESS rewrite + wrapper changes =
  feature).

## Testing & validation

- **Hook unit test** — feed a simulated PostToolUse payload for `git commit`
  (success and failure) and assert: the correct `tea-rags index-codebase`
  invocation, `cwd` → alias resolution, and skip-when-unregistered. Cover
  `git merge` → main. (shell/bats or a node harness around the script).
- **Eval** — add a freshness eval under `dinopowers/evals` +
  `.claude-plugin/.benchmarks/` asserting the agent reindexes the worktree after
  a commit, reindexes `main` after a merge, and removes the clone on
  branch-finish.
- **Live smoke** — commit on a worktree and confirm via `get_index_status` that
  the resolved collection was reindexed (or `main`, when no clone exists yet).

## Out of scope (deferred to deliverable B)

- The decision to _create_ a worktree clone (conditions 1–3): the
  not-gigantic-index gate + "if gigantic, ask", explore-only stays on main, and
  the large-WIP-with-intermediate-reindex trigger.
- A `tea-rags:worktree` skill documenting the create/list/remove/info mechanics
  and the activation decision tree.

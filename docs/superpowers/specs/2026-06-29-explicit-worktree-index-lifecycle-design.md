# Explicit worktree-index lifecycle in plan execution — design

Date: 2026-06-29 Status: approved (design) Scope: Claude Code integration
(plugins `tea-rags` + `dinopowers`), no `src/core` changes. Supersedes the
freshness half of `2026-06-24-worktree-aware-auto-reindex-design.md` and
implements its deferred "deliverable B" activation policy — but inverts the
mechanism: freshness is now EXPLICIT (skill-driven), not an implicit commit
hook.

## Problem

The `2026-06-24` design made mid-task freshness an **implicit** `PostToolUse`
commit hook (`reindex-on-git-commit.sh`) and deferred the clone _activation_
policy. Two issues surfaced:

1. **Implicit cloning / reindex is undesirable.** The user wants the worktree
   index clone to be created and refreshed by **explicit, user-visible** agent
   actions inside the plan-execution skills — not behind the scenes. The agent
   (and the user watching) must SEE the clone being created and reindexed.
2. **The commit hook is fragile.** Verified live this session: its detection
   regex `git[[:space:]]+(commit|merge)` misses flag-prefixed commits
   (`git -C <path> commit`, `git -c user.x commit`), and it resolves the target
   collection from the session `cwd`, not the `-C` path — so a commit issued
   from a non-worktree cwd reindexes the wrong (or no) collection.

The clone _teardown_ concern is the mirror: a throwaway clone must never leak
its Qdrant + DuckDB + snapshot footprint, and teardown must be **guaranteed
(100%)** on branch finish — merge OR deletion — even when the user bypasses the
skill with raw `git worktree remove` / `git branch -D`.

## Goal

Make the worktree index clone a **3-phase explicit lifecycle**, each phase a
deliberate user-visible action, with **zero implicit freshness behavior**. The
only hook that remains is a **cleanup-only** enforcement backstop that
guarantees teardown — it touches footprint, never search behavior.

## Decisions (co-designed, locked)

| Question                                     | Decision                                                                                      |
| -------------------------------------------- | --------------------------------------------------------------------------------------------- |
| Per-task reindex mechanism                   | **Explicit skill step; remove the reindex commit hook entirely.**                             |
| Subagent-driven / bare coverage (no wrapper) | **Shared canon** `tea-rags/rules/index-freshness.md` (SessionStart-injected → every session). |
| Teardown 100% guarantee                      | **Cleanup-only enforcement hook** (footprint cleanup, not freshness) + mandatory skill step.  |

## The lifecycle

```
CREATE @ plan start ──▶ REINDEX @ each task ──▶ TEARDOWN @ branch finish
   executing-plans         executing-plans          finishing-a-development-branch
   (explicit Step 0)       (explicit per-task)      (explicit Step 5) + cleanup hook
```

| Phase        | Carrier                                            | Explicit action (user-visible)                                                                                        | Hook                      |
| ------------ | -------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- | ------------------------- |
| **CREATE**   | `dinopowers:executing-plans` Step 0                | `tea-rags worktree create <name> --from <src> --path <abs> --no-git`; announce + show resulting alias / collection    | none                      |
| **REINDEX**  | `dinopowers:executing-plans` per-task + canon      | after each task's commit: `tea-rags index_codebase --project <clone>` (incremental) so the next task reads fresh code | none                      |
| **TEARDOWN** | `dinopowers:finishing-a-development-branch` Step 5 | `tea-rags worktree remove <name>` (always) + `tea-rags index_codebase --project <main>` (merge path only)             | **cleanup-only backstop** |

### CREATE gate

Trigger CREATE only when executing a **multi-task plan inside a git worktree**
(inline-driven OR subagent-driven). Skip for: single-task plans, explore-only
sessions, and main-checkout work. No hard "not-gigantic-index" gate — the agent
announces the source index size; for a very large source it warns and asks
before cloning. Visibility + the explicit announcement give the user control.

### REINDEX in subagent-driven mode

The parent that orchestrates the plan runs the explicit reindex after each task
— whether it executed the task inline or via a dispatched subagent. The subagent
itself does not reindex; the parent owns the clone lifecycle. The canon rule
(injected to the parent's session) carries this for subagent-driven-development,
which has no `dinopowers` wrapper.

### TEARDOWN guarantee

- **Skill path (disciplined):** `finishing-a-development-branch` Step 5 makes
  `tea-rags worktree remove <name>` a MANDATORY completion step on BOTH the
  merge and the abandon/delete paths; leaving a clone is a Red Flag. On the
  merge path it also runs the explicit `index_codebase --project <main>` that
  the deleted commit hook used to do.
- **Hook backstop (100%):** a new cleanup-only `PostToolUse(Bash)` hook detects
  `git worktree remove` / `git branch -d|-D`, resolves the affected worktree
  path to its clone alias, and runs `tea-rags worktree remove`. This guarantees
  teardown even when the skill is bypassed. Idempotent: if the skill already
  removed the clone, the hook's `worktree remove` returns not-found and skips.
  This hook is footprint cleanup only — it never reindexes, so it does not
  reintroduce the implicit-freshness behavior being removed.

## Carrier layers (no duplication — per `plugin-guidance-layers.md`)

- **`tea-rags/rules/index-freshness.md`** (canon, SessionStart-injected): the
  authoritative worktree-clone lifecycle protocol (create → reindex-each-task →
  teardown). Reaches EVERY session — wrapped, bare, and subagent-driven parents
  — so it is the coverage mechanism now that the freshness hook is gone.
- **`dinopowers/FRESHNESS.md`**: rewritten — drop the "post-commit hook
  auto-reindexes after commits/merges" claim; delegate to the canon; keep the
  manual escape hatch for searching uncommitted WIP.
- **`dinopowers:executing-plans`**: explicit Step 0 (CREATE) + per-task REINDEX
  step, referencing the canon.
- **`dinopowers:finishing-a-development-branch`**: Step 5 gains the explicit
  merge→main reindex and the mandatory teardown on merge AND abandon.
- **All 8 `dinopowers` wrappers**: the shared FRESHNESS pointer line
  ("post-commit hook auto-reindexes after commits/merges; run
  `mcp__tea-rags__index_codebase` manually only to search uncommitted WIP") →
  replaced with the explicit per-task-reindex pointer to `index-freshness.md`.

## Component changes

### tea-rags plugin

1. **Remove** `scripts/reindex-on-git-commit.sh` and its `PostToolUse(Bash)`
   registration in `.claude-plugin/tea-rags/.claude-plugin/plugin.json`.
2. **Add** `scripts/cleanup-worktree-clone.sh` (cleanup-only). Behavior: read
   the `PostToolUse` payload; match `git worktree remove <path>` or
   `git branch -d|-D <branch>` on tool exit 0; resolve the removed worktree path
   (for `worktree remove`, the path argument; for `branch -D`, map the branch to
   its worktree via `git worktree list` if one existed) to its clone alias via
   the registry; run `tea-rags worktree remove <name>`. Skip silently when no
   clone is registered for the path. Never fail the tool (exit 0). Register it
   as the new `PostToolUse(Bash)` hook.
3. **Add** `rules/index-freshness.md` lifecycle protocol section (or extend the
   existing file if present) and ensure it is wired into
   `scripts/inject-rules.sh`.
4. **Version**: `0.29.0 → 0.30.0` (hook swap = behavior change).

### dinopowers plugin

5. `FRESHNESS.md` rewrite (canon delegation).
6. `skills/executing-plans/SKILL.md`: Step 0 CREATE + per-task REINDEX.
7. `skills/finishing-a-development-branch/SKILL.md`: explicit merge→main
   reindex + mandatory teardown (merge + abandon).
8. 8 wrappers (`brainstorming`, `executing-plans`,
   `finishing-a-development-branch`, `receiving-code-review`,
   `requesting-code-review`, `systematic-debugging`, `test-driven-development`,
   `verification-before-completion`, `writing-plans`): replace the FRESHNESS
   pointer line.
9. **Version**: `0.18.2 → 0.19.0` (skill changes).

### test-self-reindex skill (local, `.claude/skills/`)

10. Document the correct `tea-rags worktree create` invocation: source resolves
    via `registry.findByPath(cwd)` → run from the registered project root OR
    pass `--from <alias>`; `--path <abs-worktree>`; `--no-git` to attach to an
    existing worktree dir. Add the `Source project not found (from=cwd)` trap
    and the flag-prefixed-commit / cwd-resolution gotchas to anti-patterns.

## Testing & validation

- **Cleanup hook unit test** — feed simulated `PostToolUse` payloads for
  `git worktree remove` (success / failure / unregistered path) and
  `git branch -D`; assert the correct `tea-rags worktree remove` invocation and
  the skip paths.
- **/optimize-skill eval cycle** — per edited `SKILL.md` (executing-plans,
  finishing-a-development-branch, and the wrapper line change): audit → baseline
  eval (with / without the change) → fix → verify to 100% with-rule pass →
  PERSIST benchmark artifacts (`evals.json` + `benchmark.md`) under
  `.claude-plugin/.benchmarks/<skill>/`. Target delta ≥ +50pp — measure that the
  explicit-lifecycle guidance changes agent behavior, not dead instruction
  weight. Plain rules/docs (`index-freshness.md`, `FRESHNESS.md`) and the hook
  script are NOT SKILL.md — covered by the hook unit test + freshness eval, not
  optimize-skill.
- **Live smoke** — in a worktree: run CREATE, commit a task + run the explicit
  REINDEX (confirm the clone's `indexedAt` advances and the new symbol is
  searchable), then `git worktree remove` and confirm the cleanup hook dropped
  the clone (`tea-rags worktree list` empty).

## Out of scope

- Code-level lifecycle binding (clone auto-removed when its worktree path
  disappears, enforced in `src/core`) — a more robust 100% than the cleanup
  hook, but a separate epic.
- The "not-gigantic-index" hard gate — replaced by announce-and-confirm.

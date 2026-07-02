# dinopowers read-side freshness precondition — design

Tracking: `tea-rags-mcp-jufg1` (epic; parent `tea-rags-mcp-xu8i`, related
`tea-rags-mcp-72i8`)

Date: 2026-07-02 Status: approved (design) Scope: Claude Code integration
(plugins `tea-rags` + `dinopowers`) — markdown + benchmark evals only. **No
`src/core` changes**; `src/cli/commands/worktree.ts` CLI is untouched (it
works). Amends (does NOT supersede):
`2026-06-29-explicit-worktree-index-lifecycle-design.md`. The `2026-06-29`
decisions — **explicit/user-visible freshness**, **zero implicit reindex hook**,
cleanup-only teardown backstop — all remain in force. This design only
restructures the _shape_ of the explicit freshness action (write-side
postcondition → read-side precondition) and adds the execution-level eval the
`2026-06-29` validation structurally could not run.

## Problem

Two user-reported gaps in dinopowers worktree-index behavior:

1. **Reindex does not fire when it should.** The `2026-06-29` lifecycle makes
   per-task freshness an **explicit Step 5** — "after each task's commit,
   REINDEX the clone." This is a write-side postcondition: by the time the agent
   commits a task it has mentally "finished" it, and the next salient action is
   the next task's guard. The dangling REINDEX gets dropped under momentum. The
   SKILL.md itself admits: "Skipping the per-Task REINDEX silently degrades
   every later Task's tea-rags results."

2. **Clone creation (Step 0) has the same reliability shape.** CREATE is another
   write-side soft instruction ("at plan start, create the clone"). Same failure
   mode: skipped under momentum → no clone → per-task guard reads `main` (or
   nothing), not this branch's code.

Both are **the same defect**: a freshness action expressed as a write-side
postcondition the agent must remember to perform _after_ it has moved on, rather
than at the moment the staleness actually bites.

### Why the `2026-06-29` validation missed this

The hook removal in `7f894e5d` was validated at **+50pp** (executing-plans 100%
vs 50% baseline) via `/optimize-skill`. That was a **describe-only eval** — it
measured whether the agent can _articulate_ the lifecycle steps, not whether it
_executes_ them mid-flow. Execution reliability was never on the measured axis.
A restructure that improves execution is therefore **new evidence**, not a
flip-flop of the locked decision: the locked decision (explicit, no hook)
stands; only the _carrier shape_ of the explicit action changes.

## Decisions (co-designed, locked)

| Question                             | Decision                                                                                                          |
| ------------------------------------ | ----------------------------------------------------------------------------------------------------------------- |
| Reindex mechanism                    | **No hook.** Keep freshness explicit/user-visible (honors `2026-06-29`).                                          |
| CREATE + REINDEX shape               | **Collapse both into one read-side precondition** evaluated before each per-task tea-rags call.                   |
| Where the precondition lives         | `executing-plans` new **Step 2.0**, run before the Step 2 guard, every task.                                      |
| CREATE timing                        | **Lazy** — fire `worktree create` on first per-task tea-rags need when no clone exists, not at plan start.        |
| TEARDOWN                             | **Unchanged** — `finishing-a-development-branch` Step 5 + cleanup-only backstop hook (that half works).           |
| Missing measurement                  | **Add an execution eval** (2-task: task 2 guard must see task 1's committed symbol) — closes describe blind spot. |
| `test-self-reindex` alias convention | **Out of scope** for this pass — noted as follow-up (see Out of scope).                                           |

## The mechanism

Replace the two write-side phases with a single read-side precondition:

```
BEFORE per-task tea-rags call ─▶ [clone exists? → create if missing]
  (executing-plans Step 2.0)      [reindex incremental → picks up prior commits]
                                  ─▶ Step 2 guard reads a fresh, existing clone
```

Evaluated **every task**, before the Step 2 blast-radius guard:

1. `tea-rags worktree info --json` → does a clone exist for this worktree
   (`worktreeInfoForPath(registry, cwd)`)?
   - **absent** AND this is a multi-task worktree plan →
     `tea-rags worktree create <name> --from <src-alias> --path "$PWD" --no-git`
     (the former Step 0 — now lazy, fires exactly when first needed).
   - **present** → continue.
2. `tea-rags index-codebase --project <src-alias>-worktree-<name>` (incremental)
   — picks up all prior tasks' commits. No-op when nothing changed (~1–3 s
   embeddings; enrichment detaches).
3. The Step 2 guard call now reads the fresh, existing clone.

**Explicit and user-visible** — the agent runs these commands, the user sees
them. The locked `2026-06-29` decision is intact; this is not a hook.

**Gate unchanged:** single-task plans, explore-only sessions, and main-checkout
work use the `main` collection directly — no clone, no precondition.

## Components

| #   | File                                                                       | Change                                                                                                                                                                                                                                                                                                                        |
| --- | -------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | `.claude-plugin/dinopowers/skills/executing-plans/SKILL.md`                | Remove Step 0 (CREATE at plan start) and Mandatory-Step-Order item 5 (post-commit REINDEX). Add **Step 2.0 — clone freshness precondition** (info → lazy-create → incremental reindex) before the Step 2 guard. Update Mandatory Step Order + Red Flags accordingly.                                                          |
| 2   | `.claude-plugin/dinopowers/FRESHNESS.md`                                   | Rewrite the wrapper-duties bullets from "CREATE at start / REINDEX after each commit" to the read-side precondition. Keep "no background hook" line.                                                                                                                                                                          |
| 3   | `.claude-plugin/tea-rags/rules/index-freshness.md`                         | Rewrite the "Worktree-clone lifecycle" table: the CREATE + REINDEX rows become a single **read-side precondition** row (before each per-task search: ensure exists+fresh). TEARDOWN row unchanged. Keep the "no implicit freshness hook" invariant.                                                                           |
| 4   | `.claude-plugin/dinopowers/skills/finishing-a-development-branch/SKILL.md` | Minor: confirm Step 5 wording still consistent (teardown + explicit `main` reindex on merge = the one user-gated moment). Likely no functional change.                                                                                                                                                                        |
| 5   | `.claude-plugin/.benchmarks/dinopowers-executing-plans/evals/*`            | **New execution eval**: a 2-task worktree-plan scenario where task 2's guard must surface a symbol committed by task 1. Pass = precondition ran (clone fresh, guard sees the new symbol); fail = precondition skipped (guard misses it / reads main). This is the axis the describe-only `/optimize-skill` eval never tested. |
| 6   | `.claude-plugin/dinopowers/.claude-plugin/plugin.json`                     | Bump `0.19.0 → 0.20.0` (SKILL.md behavior restructure = minor).                                                                                                                                                                                                                                                               |
| 7   | `.claude-plugin/tea-rags/.claude-plugin/plugin.json`                       | Patch bump (index-freshness.md text change).                                                                                                                                                                                                                                                                                  |

## Version drift (separate, minor)

The active plugin **cache is `0.18.2`** (pre-`7f894e5d`) whose `FRESHNESS.md`
still falsely claims "a post-commit hook auto-reindexes." Source `main` is
already `0.19.0`. This design bumps to `0.20.0`. After merge, a **republish /
reinstall** into the local marketplace lets the cache pick up `0.20.0` and the
false-hook text dies. The republish is a **user action** (not auto-run, per the
no-auto-build/reindex rules).

## Trade-offs

- **GAIN:** one enforcement point at the read moment (where staleness bites)
  replaces two danglers; gaps #1 and #2 close together; no hook = honors the
  locked decision and dodges the fragile-regex / cwd-resolution bugs that killed
  the old hook (`git -C`/`git -c` misses, cwd-not-`-C` collection resolution);
  the execution eval catches regressions the describe eval cannot.
- **COST:** the precondition adds a per-task `worktree info` + incremental
  `index_codebase` (~1–3 s) before each guard. This is exactly the cost the
  design intends (fresh reads); incremental is cheap and a no-op when clean.
- **RISK:** incremental hits ollama each task. If ollama flaps, the precondition
  surfaces it **at the read** (a visible failure the agent/user sees) rather
  than a hook swallowing it with `exit 0` and silently serving stale results.
  For the explicit/visible philosophy this is a feature, not a regression.

## Testing

- **Hook tests:** none new (no hook added). Existing `cleanup-worktree-clone`
  hook test unaffected.
- **Execution eval (component 5):** the primary new verification — measures
  execution, not description. Baseline (current 0.19.0 write-side Step 5) is
  expected to score low on this eval precisely because it is the gap being
  fixed; the read-side precondition should raise it materially.
- **Describe evals:** the existing explicit-worktree-lifecycle evals are updated
  to reflect the Step 2.0 wording (describe-ability must not regress from 100%).

## Out of scope (follow-ups)

- **`test-self-reindex` alias reconciliation.** That skill indexes a worktree as
  alias `tea-rags-worktree`; the dinopowers lifecycle uses
  `<src-alias>-worktree-<name>`. Two conventions for "the worktree's index"
  coexist. Reconciling them (or documenting the boundary: self-test skill vs
  generic plan-execution) is a separate pass — not required to close #1/#2.
- **Conditional vs unconditional reindex in Step 2.0.** This design runs
  incremental reindex unconditionally each task (cheap, no-op when clean). A
  future optimization could skip it when `worktree info` shows the clone already
  covers HEAD. Deferred — the unconditional path is simpler and the cost is
  already bounded.

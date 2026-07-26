---
paths:
  - "**/*"
---

# Worktree Teardown Closes Its Beads (MANDATORY)

A worktree is where WIP lives. Tearing one down without settling its beads is
how `in_progress` counts drift: the code merged months ago, the bead still says
someone is working on it. Reconciliation then costs a full archaeology pass over
git history — exactly what happened on 2026-07-26, when 9 of 14 `in_progress`
beads turned out to be shipped work whose worktrees had been removed silently.

**A worktree is not closed until every bead it touched has been settled.** This
applies to BOTH exits — merged and abandoned.

## When this fires

Any of these means "worktree is closing", and the reconciliation below is due
BEFORE the removal command runs:

- `git worktree remove` / `git branch -D worktree-<name>`
- `ExitWorktree` with `action: "remove"`
- merging a worktree branch into main and dropping the branch
- abandoning the branch (work superseded, approach rejected, spike done)

## Reconciliation procedure

Run from the MAIN checkout — `bd` reads `.beads/` there, and beads commands from
inside a worktree hit the redirect trap
(`.claude/hooks/ensure-beads-redirect.sh`).

### 1. Recover the bead set from the branch itself

Commit subjects on this project carry bead ids (`(xlnub)`, `(j431)`,
`(cai0/2oky5 Task 4)`), so the branch is its own manifest:

```bash
git log main..worktree-<name> --format='%s%n%b' \
  | rg -o 'tea-rags-mcp-[a-z0-9]+(\.[0-9]+)?' | sort -u
```

Add any bead you worked from but never named in a commit. The recovered set is a
floor, not a ceiling.

### 2. Settle each bead — one of three verdicts, no fourth

| Verdict         | Condition                                      | Action                                                        |
| --------------- | ---------------------------------------------- | ------------------------------------------------------------- |
| **Closed**      | the bead's acceptance is met by merged code    | `bd close <id> --reason="<commits + what proves it>"`         |
| **Open**        | real remaining work, nobody actively on it     | `bd update <id> --status=open` + comment stating what is left |
| **In progress** | another live worktree is carrying it right now | leave as-is, name that worktree in a comment                  |

`--reason` must cite evidence a reader can check without you: commit hashes, the
test file pinning the behavior, the release it shipped in. "done" is not a
reason.

### 3. Split partial work rather than closing loosely

Bead half-delivered → close it for what landed, and file the remainder as its
own bead linked to the parent. Never close a bead on the strength of intent, and
never leave it `in_progress` as a bookmark for the leftover — that is precisely
the drift this rule prevents.

## Invariant

`in_progress` count MUST NOT exceed the number of live worktrees plus what the
main checkout is actively editing. `bd list --status=in_progress` longer than
`git worktree list` is a defect in itself — reconcile before starting new work.

## Anti-patterns

- **Removing the worktree first, "I'll close the beads after."** The branch is
  the manifest; delete it and step 1 stops working.
- **Marking a bead `in_progress` at triage time.** Discovery is not work. A
  freshly filed bug is `open` until a worktree actually carries it.
- **Closing a validation-gated bead because the implementation merged.** The
  implementation landing is not the measurement passing — reset to `open` with
  what remains to measure, as done for `e6xx` and `hi37c`.
- **Bulk-closing to make the WIP number look right.** Every close needs its own
  evidence line; a bead closed without one gets reopened by the next audit.

## Cross-reference

- `.claude/rules/session-completion.md` step 3 ("Update issue status") — this
  rule is that step's worktree-scoped, mandatory form.
- `.claude/rules/parallel-sessions.md` rule 5 — `bd dolt pull` before
  creating/closing, so parallel teardowns do not collide in the beads database.

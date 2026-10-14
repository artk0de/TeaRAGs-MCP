---
paths:
  - "**/*"
---

# Landing the Plane (Session Completion)

**When ending work session**, MUST complete ALL steps below. Work NOT complete
until `git push` succeeds.

## MANDATORY WORKFLOW

1. **File issues for remaining work** - Create issues for follow-up
2. **Run quality gates** (if code changed) - Tests, linters, builds
3. **Update issue status** - Close finished, update in-progress. Session ends by
   tearing down a worktree → `.claude/rules/worktree-beads-lifecycle.md` is the
   mandatory form of this step (recover the bead set from the branch BEFORE
   removing it).
4. **PUSH TO REMOTE** - MANDATORY:

   ```bash
   git pull --rebase
   bd sync
   git push
   git status  # MUST show "up to date with origin"
   ```

5. **Clean up** - Clear stashes, prune remote branches
   - After merging this worktree branch into `main`, ALWAYS remove the worktree
     and its branch in the same landing flow.
   - Reconcile every touched bead before removal using
     `.claude/rules/worktree-beads-lifecycle.md`; never leave a merged worktree
     behind.
6. **Verify** - All changes committed AND pushed; merged worktree is removed
7. **Hand off** - Provide context for next session

## Defect closure policy (MANDATORY)

- A defect discovered while executing the current task MUST be fixed in the same
  task before it is considered complete; do not defer a known defect as a
  convenience follow-up.
- A follow-up defect discovered later MUST be recorded as a bug bead linked to
  the originating task, then fixed in the current session before handoff.
- A task or session MUST NOT be reported complete while a known defect remains
  unlinked or unfixed.

## CRITICAL RULES

- Work NOT complete until `git push` succeeds
- NEVER stop before pushing - leaves work stranded locally
- NEVER say "ready to push when you are" - YOU must push
- Push fails → resolve and retry until succeeds

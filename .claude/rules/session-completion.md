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
6. **Verify** - All changes committed AND pushed
7. **Hand off** - Provide context for next session

## CRITICAL RULES

- Work NOT complete until `git push` succeeds
- NEVER stop before pushing - leaves work stranded locally
- NEVER say "ready to push when you are" - YOU must push
- Push fails → resolve and retry until succeeds

---
paths:
  - "**/*"
---

# Parallel Sessions

Multiple Claude sessions may run concurrently on same repo.

## Rules

1. **Do not modify sections you did not create.** CLAUDE.md or rule file has
   content unrelated to your task → leave untouched.

2. **Check git status before committing.** Other sessions may have uncommitted
   changes. Stage only files you modified.

3. **Pull before push.** Always `git pull --rebase` before push to avoid
   overwriting parallel session's work.

4. **Avoid editing the same file.** `git status` shows file modified by another
   session (unstaged changes you didn't make) → don't touch. Ask user to
   resolve.

5. **Beads coordination.** Run `bd dolt pull` before creating/closing issues to
   avoid merge conflicts in the beads database.

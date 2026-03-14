# Parallel Sessions

Multiple Claude sessions may run concurrently on the same repo.

## Rules

1. **Do not modify sections you did not create.** If CLAUDE.md or a rule file
   contains content unrelated to your current task, leave it untouched.

2. **Check git status before committing.** Other sessions may have uncommitted
   changes. Only stage files you modified.

3. **Pull before push.** Always `git pull --rebase` before pushing to avoid
   overwriting a parallel session's work.

4. **Avoid editing the same file.** If `git status` shows a file modified by
   another session (unstaged changes you didn't make), do not touch it. Ask the
   user to resolve.

5. **Beads coordination.** Run `bd dolt pull` before creating or closing issues
   to avoid merge conflicts in the beads database.

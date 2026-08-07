# Step 11: Index Freshness — Auto-Update + Worktree Mode

Two opt-in choices, both non-fatal. Alias from step 9. CLI not on PATH → print
the commands for after terminal restart, continue.

## 11a: Auto-update of the default branch

AskUserQuestion: "Enable auto-update? tea-rags keeps the index fresh on your
default branch — session start and searches trigger a background incremental
reindex when the branch moved. No daemon; branch switches never thrash the
index." (Recommended: Yes)

- Yes →

  ```bash
  tea-rags auto-update enable --project "<alias>"
  ```

  Target branch autodetects (origin/HEAD → main/master). Non-standard default
  branch → add `--branch <name>`. Report the printed confirmation.

- No → skip. User can enable later; the prime digest shows the exact command
  when the index goes stale.

## 11b: Worktree mode for parallel branches

AskUserQuestion: "Use worktree mode for parallel branches? The coding agent then
gives each git worktree its own index clone (`tea-rags worktree create`) — the
main index stays pinned to the target branch while branch work searches its own
code. Costs disk + a clone per worktree. For a huge monorepo where a clone is
expensive (millions of LOC), decline — the agent will simply reindex whatever
branch is active." (Recommended: Yes for small/medium repos, No for huge
monorepos)

Record the choice in the project's `CLAUDE.local.md` (create if missing) so
every agent session sees it:

- Yes →

  ```markdown
  ## tea-rags worktree mode: enabled

  Parallel branch work uses per-worktree index clones
  (`tea-rags worktree create <name> --from <alias> --path <worktree> --no-git`,
  incremental reindex of the clone after each task). The main index stays pinned
  to the auto-update target branch.
  ```

- No →

  ```markdown
  ## tea-rags worktree mode: disabled

  Do NOT create worktree index clones. Freshness = index the ACTIVE branch: when
  the index is stale or the branch switched, run `index_codebase` (incremental)
  on the current checkout. Auto-update stays paused while HEAD is off the target
  branch — that is expected.
  ```

Save both answers to progress; mark the step completed.

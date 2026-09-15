# domains/maintenance/worktree — provisions and tears down a worktree's collection clone

## Invariants

- **`create` is clone + register only — the reindex was deliberately removed and
  must not come back.** `WorktreeProvisioner#create` is artifact clone +
  `registry.record` + `setName` + `setWorktreeProvenance`, nothing else. The
  removed call was never in the saga: it was
  `await ctx.app.indexCodebase(res.worktreePath, {})` in the CLI handler,
  deleted in `ccdf57d8` after live validation. The rationale is an nine-line
  comment at the call site in `runWorktreeCreate`
  (`src/cli/commands/worktree.ts`); the CLI now prints
  `nextStep: tea-rags index-codebase --project <alias>` (same function) —
  `--project`, not `--name`, because `create` already registered the alias with
  provenance. Why: a synchronous in-process reindex blocks the command on a
  large diff and auto-triggers a heavy reindex against the user-gating rule. A
  fresh clone is INTENTIONALLY stale by the branch diff plus uncommitted edits
  until someone runs that explicit incremental index. Read
  `cli/commands/worktree.ts`, not this file, when you want to see what was
  removed.
- **`registry.record` is the saga commit point; `worktreeOf` is the only guard
  protecting real projects.** The try/catch wraps ONLY the artifact clone loop,
  so rollback covers everything before `registry.record`; `setName` and
  `setWorktreeProvenance` run after it unguarded. Which is why `create` asks
  TWICE whether the target is taken, both before any side effect: by path
  (`registry.findByPath`) and by the name that path hashes to (`registry.get`).
  They catch opposite halves of the same relocation — an entry that moved AWAY
  from this directory is invisible to `findByPath`, and its collection is
  exactly what the directory still hashes to, so a single guard let the saga run
  against a live project and stamp it a clone (bd tea-rags-mcp-dxa9w). On
  teardown the SOLE safety check is `registry.findWorktree(input.name)`
  (`WorktreeProvisioner#remove`), which matches only entries with `worktreeOf`
  set and otherwise throws `WorktreeNotFoundError` (`../errors.ts`, "is not a
  worktree clone (refusing to remove)"). `remove` resolves the target's physical
  collection through the live alias with a `_v1` fallback, never assuming `_v1`.
  Why: a crash in the post-commit window leaves a registered collection that
  `worktree list` does not show and `worktree remove` refuses to touch. That one
  provenance field — not the CLI, which holds no check — is what makes
  destroying a real project impossible through this path; and a force reindex
  bumps the version, so an assumed `_v1` would sweep the wrong physical
  collection.

## Boundaries

- **The command surface is consumed by a shell hook and by plugin skills outside
  the TypeScript build, and one leg is ALREADY broken.**
  `.claude-plugin/tea-rags/scripts/cleanup-worktree-clone.sh` (a
  PostToolUse(Bash) backstop) reads `.path` and `.worktreeName` off
  `tea-rags worktree list --json` and calls
  `tea-rags worktree remove <worktreeName>` — but that JSON is `WorktreeInfo`
  (`contracts/types/worktree.ts`, built by `toWorktreeInfo` in
  `api/internal/ops/worktree-ops.ts`), which carries NO `path`. Every row hits
  `[ -n "$p" ] || continue` and nothing is removed; the hook always `exit 0`s.
  The dinopowers skills address the clone by the alias template
  `<src-alias>-worktree-<name>` composed in `WorktreeProvisioner#create`; that
  leg still holds. Why: the guaranteed teardown does not currently run, so
  orphaned clones accumulate silently. Restoring it means adding `path` to
  `WorktreeInfo` (or teaching the hook to read the registry). Renaming
  `worktreeName`, the alias template, or `remove`'s argument breaks these
  consumers with no compiler error and no test.

## See also

- `../footprint/CLAUDE.md` — the artifact saga this class drives: clone order,
  rollback contract, logical-vs-physical naming.
- `../registry/CLAUDE.md` — why a pipeline reindex erases the provenance this
  file writes.
- `.claude/rules/worktree-beads-lifecycle.md` — the bead obligations of a
  worktree teardown.

# dinopowers Index Freshness Protocol

Index freshness is now enforced by a `PostToolUse:Bash` hook
(`tea-rags/scripts/reindex-on-git-commit.sh`) that runs an incremental
`index_codebase` after every successful `git commit` / `git merge`, targeting
the collection resolved from the commit directory. The canonical trigger
taxonomy lives in `tea-rags/rules/index-freshness.md`.

## What wrappers must still do

- **Searching uncommitted WIP** — the hook fires on commit, not on edit. If you
  must search code you have edited but not yet committed, run `index_codebase`
  (incremental) manually first, then search. Otherwise rely on the commit
  boundary.
- **NEVER call deprecated reindex endpoints** — always `index_codebase`.
- **Do not force-reindex** — `force_reindex` is for schema drift only and needs
  explicit user consent.

# Indexing Guide

## index_codebase Options

- `path` — root to index
- `forceReindex` — rebuild whole index into new collection (zero downtime, alias swap at end)
- Scoped force: `forceReindex` + any of `languages`, `testFile` (only | exclude),
  `pathPattern`, `fileExtension`, `files` → re-chunk + re-embed ONLY selected
  indexed files, in place on live collection; other points untouched. Filters AND-combine,
  match like search namesakes. Needs existing index. Drift report whose chunking bump
  declared a scope names this form in its `Run:` line.
- `extensions` — extensions to include (default: auto-detect)
- `ignorePatterns` — extra ignores beyond .gitignore

## Git Metadata

Set `CODE_ENABLE_GIT_METADATA=true` before indexing.

Enables filters:
- author — blame-dominant author (most live lines, git blame HEAD); file default, level "chunk" → chunk's own lines. Live-line-owner filter (no separate blameOwner param)
- recentAuthor — recent-activity dominant author (commit count, log window)
- contributor — files the person committed to in log window (superset of recentAuthor)
- modifiedAfter/modifiedBefore — date range (ISO 8601)
- minAgeDays/maxAgeDays — code age
- minCommitCount — churn
- taskId — from commit messages (JIRA, GitHub issues)

Git enrichment runs in background after indexing; progress → `get_index_status`.

## Index Workflow

1. `index_codebase` — full initial index; re-run auto-detects changed files → incremental (no separate reindex tool)
2. `get_index_status` — status + enrichment progress
3. `clear_index` — delete all indexed data (irreversible)

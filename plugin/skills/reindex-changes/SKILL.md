---
name: reindex-changes
description:
  Incrementally re-index only changed files. Fast — detects added, modified, and
  deleted files since last index. Runs in background.
argument-hint: [path to codebase]
---

# Reindex Changes (Background)

Runs incremental reindex in a background subagent. Only processes files that
changed since last index.

## Instructions

1. Extract `path` from the user's message or argument. If not provided, use the
   current working directory.

2. Dispatch a **background subagent** with `run_in_background: true`:

```
Agent tool:
  description: "Reindex changes in background"
  run_in_background: true
  prompt: |
    Call mcp__tea-rags__reindex_changes with:
    - path: <extracted path>
    Report: files added/modified/deleted, chunks added, duration.
```

3. Tell the user reindexing has started. Continue with other work.

4. When the background agent completes, report the result to the user.

## Do NOT

- Call `reindex_changes` in the foreground (blocks conversation)
- Use this for full re-index — use `/tea-rags:force-reindex` instead

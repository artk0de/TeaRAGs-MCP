---
name: index
description:
  Index or reindex a codebase. First time — full index. Already indexed —
  incremental reindex (only changed files). Runs in background, does not block
  conversation.
argument-hint: [path to codebase]
---

# Index Codebase (Background)

Smart indexing in a background subagent:

- **Not indexed** → full index
- **Already indexed** → incremental reindex (only changed files)

## Instructions

1. Extract `path` from the user's message or argument. If not provided, use the
   current working directory.

2. Dispatch a **background subagent** with `run_in_background: true`:

```
Agent tool:
  description: "Index codebase in background"
  run_in_background: true
  prompt: |
    Call mcp__tea-rags__index_codebase with:
    - path: <extracted path>
    Report: files indexed, chunks created, duration.
```

3. Tell the user indexing has started and they will be notified when it
   completes. Continue with other work.

4. When the background agent completes, report the result to the user.

## Do NOT

- Call `index_codebase` in the foreground (blocks conversation)
- Call with `forceReindex: true` — use `/tea-rags:force-reindex` for that

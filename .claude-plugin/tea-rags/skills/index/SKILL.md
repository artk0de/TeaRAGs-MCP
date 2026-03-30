---
name: index
description:
  Index or reindex a codebase. First time — full index. Already indexed —
  incremental reindex (only changed files).
argument-hint: [path to codebase]
---

# Index Codebase

Smart indexing — call MCP tool directly (no subagent):

- **Not indexed** → full index
- **Already indexed** → incremental reindex (only changed files)

## Instructions

1. Extract `path` from the user's message or argument. If not provided, use the
   current working directory.

2. Call `mcp__tea-rags__index_codebase` directly with:
   - `path`: extracted path

3. Report the **full result** — all metrics and duration.

## Do NOT

- Spawn a subagent (Agent tool) — direct MCP call is much faster for incremental
  reindex. Subagent overhead (~10-15s) dwarfs the actual reindex time (~1-3s).
- Call with `forceReindex: true` — use `/tea-rags:force-reindex` for that

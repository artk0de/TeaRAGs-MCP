---
name: force-reindex
description:
  Force full re-index with zero downtime. Builds new versioned collection in
  background while search continues on current one. Alias switches atomically
  when done.
argument-hint: [path to codebase]
---

# Force Reindex (Background, Zero-Downtime)

Runs `forceReindex` in a background subagent. Search remains available during
the entire process via collection aliases.

## Instructions

1. Extract `path` from the user's message or argument. If not provided, use the
   current working directory.

2. Dispatch a **background subagent** with `run_in_background: true`:

```
Agent tool:
  description: "Force reindex in background"
  run_in_background: true
  prompt: |
    Call mcp__tea-rags__index_codebase with:
    - path: <extracted path>
    - forceReindex: true
    Report the COMPLETE response as-is — every field returned by the tool.
    Do not cherry-pick fields. Whatever the endpoint returns, summarize it all.
```

3. Tell the user: "Force reindex started in background. Search continues on the
   current index — zero downtime. You'll be notified when the new index is
   ready."

4. When the background agent completes, report the **full result** to the user.
   Include all metrics — do not summarize or omit fields.

## Do NOT

- Call `index_codebase` with `forceReindex: true` in the foreground
- Use this for incremental updates — use `/tea-rags:reindex-changes` instead

---
name: force-reindex
description:
  Force full re-index with zero downtime. Builds new versioned collection in
  background while search continues on current one. Alias switches atomically
  when done. Requires explicit user confirmation — NEVER invoke automatically.
argument-hint: "[path to codebase]"
---

# Force Reindex (Background, Zero-Downtime)

Runs `forceReindex` in a background subagent. Search remains available during
the entire process via collection aliases.

## MANDATORY: Explicit User Confirmation

**This skill MUST ONLY be invoked when the user explicitly requests it.** Agents
MUST NOT auto-trigger force-reindex based on stale markers, index status, or any
other automated signal.

Before executing, you MUST:

1. Explain what force-reindex does: "This will rebuild the entire index from
   scratch. It creates a new versioned collection while the current one stays
   active. Takes several minutes for large codebases."
2. Ask for explicit confirmation using `AskUserQuestion`:
   ```
   question: "Force reindex will rebuild the entire index for <path>. This can take several minutes. Proceed?"
   options:
     - { label: "Yes, reindex", description: "Start full reindex in background" }
     - { label: "Cancel", description: "Do not reindex" }
   ```
3. Only proceed if the user selects "Yes, reindex".

## Instructions

1. **Confirm with user** (see above). If user cancels, stop.

2. Extract `path` from the user's message or argument. If not provided, use the
   current working directory.

3. Dispatch a **background subagent** with `run_in_background: true` (full
   reindex takes minutes — background is justified here):

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
    ALWAYS include the duration field — users need to see how long indexing took.
```

4. Tell the user: "Force reindex started in background. Search continues on the
   current index — zero downtime. You'll be notified when the new index is
   ready."

5. When the background agent completes, report the **full result** to the user.
   Include all metrics and duration — do not summarize or omit fields.

## Do NOT

- Call `index_codebase` with `forceReindex: true` in the foreground
- Use this for incremental updates — use `/tea-rags:index` instead
- **Invoke this skill automatically** — stale markers, failed indexing, or any
  other condition MUST NOT trigger force-reindex without user request
- **Skip the confirmation step** — even if the user said "reindex", still
  confirm because force-reindex is destructive (rebuilds entire index)

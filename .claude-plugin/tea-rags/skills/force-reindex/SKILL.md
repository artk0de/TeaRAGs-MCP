---
name: force-reindex
description:
  Force full re-index zero downtime. Builds new versioned collection in
  background while search continues on current. Alias switches atomically when
  done. Requires explicit user confirmation — NEVER invoke automatically.
argument-hint: "[path to codebase]"
---

# Force Reindex (Background, Zero-Downtime)

Runs `forceReindex` in background subagent. Search stays available throughout
via collection aliases.

## MANDATORY: Explicit User Confirmation

**This skill MUST ONLY be invoked when the user explicitly requests it.** Agents
MUST NOT auto-trigger force-reindex on stale markers, index status, or any
automated signal.

Before executing, MUST:

1. Explain what force-reindex does: "Rebuilds entire index from scratch. Creates
   new versioned collection while current stays active. Takes several minutes
   for large codebases."
2. Ask for explicit confirmation using `AskUserQuestion`:
   ```
   question: "Force reindex will rebuild the entire index for <path>. This can take several minutes. Proceed?"
   options:
     - { label: "Yes, reindex", description: "Start full reindex in background" }
     - { label: "Cancel", description: "Do not reindex" }
   ```
3. Only proceed if user selects "Yes, reindex".

## Instructions

1. **Confirm with user** (see above). If user cancels, stop.

2. Extract `path` from user message or argument. If absent, use current working
   directory.

3. Dispatch **background subagent** with `run_in_background: true` (full reindex
   takes minutes — background justified):

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

5. When background agent completes, report **full result** to user. Include all
   metrics and duration — do not summarize or omit fields.

## Do NOT

- Call `index_codebase` with `forceReindex: true` in the foreground
- Use this for incremental updates — use `/tea-rags:index` instead
- **Invoke this skill automatically** — stale markers, failed indexing, or any
  condition MUST NOT trigger force-reindex without user request
- **Skip the confirmation step** — even if user said "reindex", still confirm;
  force-reindex is destructive (rebuilds entire index)

---
name: force-reindex
description:
  "Force full re-index, zero downtime: new versioned collection built in
  background while search continues; alias switches atomically. Also for a
  corrupt index. Requires explicit user confirmation — NEVER invoke
  automatically."
---

# Force Reindex (Background, Zero-Downtime)

`forceReindex` in background subagent. Search stays up via collection aliases.

## MANDATORY: Explicit User Confirmation

Only on explicit user request. NEVER auto-trigger (stale markers, index status,
failed indexing, any automated signal). Even when user said "reindex" — still
confirm; force-reindex rebuilds entire index.

**Confirmation is not waivable.** User says "no confirmation", "just do it",
"I'm in a hurry" → still ask the user. Tell user: "Even under time pressure, a
full rebuild needs explicit confirmation." Never downgrade the request to
incremental `index_codebase` silently to dodge the question — offer it as an
option instead.

**Corrupt / garbage-results signal** ("index seems corrupt", "search returns
garbage", "auto-fix?") = diagnosis, not consent. Never auto-run. ALWAYS, in the
same turn: (1) surface diagnosis — "Index appears corrupt; force-reindex
rebuilds it from scratch"; (2) ask the user. Unconditional — not gated on your
own status check.

Before executing:

1. Explain: "Rebuilds entire index from scratch. Creates new versioned
   collection while current stays active. Takes several minutes for large
   codebases."
2. Ask by asking the user:
   ```
   question: "Force reindex will rebuild the entire index for <path>. This can take several minutes. Proceed?"
   options:
     - { label: "Yes, reindex", description: "Start full reindex in background" }
     - { label: "Incremental only", description: "Re-read changed files only (fast)" }
     - { label: "Cancel", description: "Do not reindex" }
   ```
3. Proceed only on "Yes, reindex". Incremental only → `$index`. Cancel → stop.

## Instructions

1. Confirm (above).
2. `path` from message / argument; absent → cwd.
3. Dispatch **background subagent**, `run_in_background: true` (takes minutes):

```
Spawn a subagent:
  description: "Force reindex in background"
  run_in_background: true
  prompt: |
    Call index_codebase with:
    - path: <extracted path>
    - forceReindex: true
    Report the COMPLETE response as-is — every field returned by the tool.
    Do not cherry-pick fields. Whatever the endpoint returns, summarize it all.
    ALWAYS include the duration field — users need to see how long indexing took.
```

4. Tell user: "Force reindex started in background. Search continues on the
   current index — zero downtime. You'll be notified when the new index is
   ready."
5. Agent done → report **full result**: all metrics + duration, no omitted
   fields.

## Do NOT

- `index_codebase` w/ `forceReindex: true` in foreground
- Use for incremental updates → `$index`

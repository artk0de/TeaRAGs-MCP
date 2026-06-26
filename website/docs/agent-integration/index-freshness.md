---
title: Index Freshness & Auto-Reindex
sidebar_position: 6
---

import MermaidTeaRAGs from '@site/src/components/MermaidTeaRAGs';

# Index Freshness & Auto-Reindex

TeaRAGs search reads payloads written **at index time**. If the index lags the
working tree, results are silently stale — the agent gets yesterday's code with
no error. The TeaRAGs plugin closes this gap automatically: a **`PostToolUse:Bash`
hook** reindexes after every successful `git commit` or `git merge`, so mid-task
searches always see freshly-committed code.

The trigger is **git events, not per-edit churn**. A commit is a natural
checkpoint, and the incremental diff since the last index is exactly the
committed change — no thrashing on every keystroke, no manual reindex checklist.

## How the hook fires

<MermaidTeaRAGs>
  {`
flowchart LR
    Commit[🔀 git commit / merge<br/><small>run via Bash tool</small>]
    Hook{🪝 PostToolUse:Bash<br/><small>reindex-on-git-commit.sh</small>}
    Success{✅ succeeded?<br/><small>no conflict / nothing-to-commit</small>}
    Resolve{🔍 cwd → registered project?}
    Reindex[🍵 index_codebase --project<br/><small>incremental · ~1-3s</small>]
    Skip[⏭️ skip silently<br/><small>always exit 0</small>]

    Commit --> Hook
    Hook --> Success
    Success -->|yes| Resolve
    Success -->|no| Skip
    Resolve -->|yes| Reindex
    Resolve -->|no| Skip
`}
</MermaidTeaRAGs>

The hook inspects the PostToolUse payload and acts only when **all** of these
hold:

1. The tool was `Bash`.
2. The command contains `git commit` or `git merge` (including chained forms like
   `git commit && git push` or `git merge main; git push`).
3. The command **succeeded** — the hook skips when the output carries a failure
   marker (`nothing to commit`, `no changes added`, `CONFLICT`, `Merge conflict`,
   `Automatic merge failed`, `not something we can merge`).

A hook must never fail the tool it observes, so the script **always exits 0** —
a skip is silent, never an error.

## Trigger taxonomy

| Event                                                  | Action                            | Target                        | Gate                         |
| ------------------------------------------------------ | --------------------------------- | ----------------------------- | ---------------------------- |
| Commit on a worktree branch (plain or subagent-driven) | `index_codebase` incremental      | worktree clone (cwd-resolved) | auto — clone is throwaway    |
| Merge into `main`                                      | `index_codebase` incremental      | `main`                        | the merge act IS the gate    |
| Branch finished (post-merge)                           | `tea-rags worktree remove <name>` | clone footprint dropped       | skill-only (not a git event) |
| Edited-but-uncommitted before a search                 | manual `index_codebase`           | current collection            | commit boundary is primary   |
| Schema drift                                           | `force_reindex`                   | —                             | explicit consent (unchanged) |

## Worktree-aware resolution

The hook reindexes **the collection that matches where the commit happened**, not
a hard-coded project. It resolves the target like this:

1. Take `cwd` from the payload and walk to the git toplevel
   (`git rev-parse --show-toplevel`).
2. Look that path up in the registry with
   `tea-rags project exist --path <dir> --print-name`.
3. Reindex the resolved alias incrementally:
   `tea-rags index-codebase --project <alias> --json`.

This makes the hook correct across checkouts:

- **Commit inside a [worktree clone](/usage/advanced/worktree-indexes)** → the
  toplevel resolves to the worktree's alias, so only the throwaway clone is
  reindexed.
- **Merge in the main checkout** → resolves to the main project's alias.
- **Bare git worktree with no clone** → the path is not registered, so the hook
  skips with a diagnostic to stderr and **never creates a stray collection**.

Because the hook is tool-level, commits made inside subagents and bare sessions
are covered too — it does not depend on any wrapper skill being active.

## Why incremental, not force

The hook runs `index_codebase` **without** `--force` and **without**
`--wait-enrichments`:

- **Incremental** re-embeds only the committed diff — seconds, not a full
  rebuild. Embeddings block ~1–3s so the next search sees the new code; git and
  codegraph enrichment detach and finish in the background.
- A **full rebuild** (`force_reindex`) is reserved for **schema drift** — when the
  running code declares payload fields the existing index never populated.
  Incremental cannot fix that (unchanged files keep their old payload), so a full
  rebuild is the only repair — and because it is expensive, it is **never**
  automatic. See [`/tea-rags:force-reindex`](/usage/skills) and
  [Recovery & Reindexing](/operations/recovery-reindexing).

## No configuration required

The hook ships with the TeaRAGs plugin manifest — there is nothing to install or
enable beyond having the plugin and a **registered project**
(see [Project Registry](/usage/advanced/project-registry)). If a path is not in
the registry, the hook simply skips it.

## Edited-but-uncommitted code

The commit/merge hook covers the common case. For code you have **edited but not
yet committed**, the index does not see those changes — run `index_codebase`
(incremental) manually before searching. `index_codebase` is the only
incremental entrypoint.

## Related

- [Worktree Indexes](/usage/advanced/worktree-indexes) — the clones the hook keeps
  fresh after branch commits.
- [Recovery & Reindexing](/operations/recovery-reindexing) — incremental vs force
  reindex, schema-drift recovery.
- [Project Registry](/usage/advanced/project-registry) — how the hook resolves
  `cwd` to a collection.

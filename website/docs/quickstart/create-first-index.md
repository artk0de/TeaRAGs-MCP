---
title: Create Your First Index
sidebar_position: 3
---

import AiQuery from '@site/src/components/AiQuery';

Once you've [installed TeaRAGs](/quickstart/installation) and
[connected to an agent](/quickstart/connect-to-agent), indexing a codebase is
one command.

## Index Your Codebase

If you installed the Claude Code skills plugin (`tea-rags@tea-rags`), open
Claude Code in your project directory and invoke the indexing skill:

```
/tea-rags:index
```

First run does a full index. Every subsequent call does an **incremental
reindex** — only changed files are re-processed.

<details>
<summary>Without the skills plugin (Cursor, Roo Code, etc.)</summary>

Ask your agent directly — it will call the `index_codebase` MCP tool:

<AiQuery>Index this codebase with tea-rags</AiQuery>

</details>

## What Happens During Indexing

1. **File discovery** — scans the project, respects `.gitignore` and
   `.contextignore`
2. **AST-aware chunking** — parses code into semantic chunks (functions,
   classes, methods) via tree-sitter
3. **Trajectory enrichment** — attaches git + static signals per chunk (age,
   churn, bug-fix rate, imports, …)
4. **Embedding** — converts chunks to vectors using your configured provider
5. **Storage** — upserts vectors + payload into Qdrant
6. **Snapshot** — saves file hashes for future incremental updates

## Update After Changes

Re-run the same skill after making changes or pulling new commits — it detects
modified / added / deleted files automatically:

```
/tea-rags:index
```

Only changed files are re-processed; unchanged files are skipped.

## Full Re-Index (zero downtime)

For large rewrites, branch switches, or when payload schema changes, use:

```
/tea-rags:force-reindex
```

A new versioned collection is built in the background while search keeps
serving the current one. The alias switches atomically when the new build
finishes. Requires explicit user confirmation — never invoked automatically.

## Check Index Status

<AiQuery>Show me stats for the current index</AiQuery>

:::tip
You can check index status from a parallel agent tab while indexing is still
running.
:::

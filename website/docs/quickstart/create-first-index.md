---
title: Create Your First Index
sidebar_position: 3
---

import AiQuery from '@site/src/components/AiQuery';

Once you've [installed TeaRAGs](/quickstart/installation) and [connected to an agent](/quickstart/connect-to-agent), indexing your codebase is simple.

## Index Your Codebase

Just ask your AI assistant:

<AiQuery>Index this codebase for semantic search</AiQuery>

## What Happens During Indexing

1. **File discovery** — scans the project, respects `.gitignore` and `.contextignore`
2. **AST-aware chunking** — parses code into semantic chunks (functions, classes, methods)
3. **Embedding** — converts chunks into vectors using your configured provider
4. **Storage** — upserts vectors into Qdrant with metadata
5. **Snapshot** — saves file hashes for future incremental updates

## Update After Changes

After making changes or pulling new commits:

<AiQuery>Update the search index with my recent changes</AiQuery>

Only changed files are re-processed — unchanged files are skipped.

## Check Index Status

<AiQuery>Show me stats for the current index</AiQuery>

:::tip
You can check index status from a parallel agent tab while indexing is still running.
:::

---
title: Your First Query
sidebar_position: 4
---

import AiQuery from '@site/src/components/AiQuery';

With your codebase [indexed](/quickstart/create-first-index), you can search using natural language.

## Basic Queries

Just ask your AI assistant naturally:

<AiQuery>How does authentication work in this project?</AiQuery>
<AiQuery>Find where we handle payment errors</AiQuery>
<AiQuery>Show me the database connection logic</AiQuery>
<AiQuery>Where is the retry mechanism implemented?</AiQuery>

## With Git Metadata Filters

Requires `CODE_ENABLE_GIT_METADATA=true` during indexing. See [Git Enrichments](/usage/git-enrichments) for details.

<AiQuery>Find code that Alice wrote recently</AiQuery>
<AiQuery>Show me files with high churn rate</AiQuery>
<AiQuery>What changes were made for ticket PROJ-123?</AiQuery>

## Managing Indexes

<AiQuery>What codebases are indexed?</AiQuery>
<AiQuery>Show me stats for the current index</AiQuery>
<AiQuery>Clear the index and start fresh</AiQuery>

## Next Steps

- [Query Modes](/usage/query-modes) — understand semantic, hybrid, and filtered search
- [Configuration](/config/environment-variables) — tune search defaults and parameters
- [Performance Tuning](/config/performance-tuning) — optimize for your hardware

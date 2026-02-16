---
title: "15-Minute Guide"
slug: 15-minute-guide
sidebar_position: 0
sidebar_class_name: sidebar-bold-item
---

import AiQuery from '@site/src/components/AiQuery';

# 15-Minute Guide

From zero to semantic code search in one page. By the end, you'll have TeaRAGs running locally, your codebase indexed, and your first natural-language query answered.

:::tip Time estimate
**5 minutes** to install and start services. **5 minutes** to connect and index. **5 minutes** to query and explore.
:::

## Prerequisites

Before you start, make sure you have:

- **Node.js 22+** — `node -v`
- **Podman** or **Docker** with Compose support — `podman --version` or `docker --version`
- **An AI agent** — [Claude Code](https://docs.anthropic.com/en/docs/claude-code/overview) (recommended), [Roo Code](https://rooscode.com), or [Cursor](https://cursor.com)
- **A git repository** you want to search

## Step 1: Clone and Build {#step-1}

```bash
git clone https://github.com/artk0de/TeaRAGs-MCP.git
cd TeaRAGs-MCP
npm install && npm run build
```

## Step 2: Start Services {#step-2}

TeaRAGs needs two services: **Qdrant** (vector database) and **Ollama** (local embeddings).

```bash
# Start both services
podman compose up -d    # or: docker compose up -d

# Pull the embedding model (~270 MB)
podman exec ollama ollama pull unclemusclez/jina-embeddings-v2-base-code:latest
# or: docker exec ollama ollama pull unclemusclez/jina-embeddings-v2-base-code:latest
```

**Verify services are running:**

```bash
curl -s http://localhost:6333/readyz    # Qdrant — should return "ok" or similar
curl -s http://localhost:11434/api/tags  # Ollama — should list your model
```

## Step 3: Connect to Your Agent {#step-3}

### Claude Code

```bash
claude mcp add tea-rags -s user -- node /absolute/path/to/qdrant-mcp-server/build/index.js \
  -e QDRANT_URL=http://localhost:6333 \
  -e EMBEDDING_BASE_URL=http://localhost:11434
```

Replace `/absolute/path/to/qdrant-mcp-server` with the actual path where you cloned the repository.

### Other agents

For Roo Code, Cursor, or other MCP clients, add this to your MCP configuration JSON:

```json
{
  "mcpServers": {
    "tea-rags": {
      "command": "node",
      "args": ["/absolute/path/to/qdrant-mcp-server/build/index.js"],
      "env": {
        "QDRANT_URL": "http://localhost:6333",
        "EMBEDDING_BASE_URL": "http://localhost:11434"
      }
    }
  }
}
```

**Restart your agent** after adding the configuration.

See [Connect to an Agent](/quickstart/connect-to-agent) for remote server, Qdrant Cloud, and HTTP transport setups.

## Step 4: Index Your Codebase {#step-4}

Open your agent in a project directory and ask:

<AiQuery>Index this codebase for semantic search</AiQuery>

TeaRAGs will:
1. Discover files (respects `.gitignore`)
2. Parse code into semantic chunks using tree-sitter (functions, classes, methods)
3. Generate vector embeddings via Ollama
4. Store everything in Qdrant

**First index takes 1–5 minutes** depending on codebase size. Subsequent updates are incremental — only changed files get re-processed.

:::tip Check progress
Ask `"Show me stats for the current index"` at any time to see how many files and chunks have been indexed.
:::

## Step 5: Your First Query {#step-5}

Now search your code using natural language:

<AiQuery>How does authentication work in this project?</AiQuery>

<AiQuery>Find where we handle errors in the payment flow</AiQuery>

<AiQuery>Show me the database connection logic</AiQuery>

Results come back with **file paths, line numbers, and the actual code** — your agent can immediately read and reason about them.

### Try these progressively

| Query | What it demonstrates |
|-------|---------------------|
| `"Where is retry logic implemented?"` | Finding code by **behavior**, not by name |
| `"Find recently modified authentication code"` | Filtering by **recency** |
| `"Show me stable, low-churn utility functions"` | Reranking by **code quality signals** |

## Step 6: Enable Git Intelligence (Optional) {#step-6}

Standard semantic search is already powerful. But TeaRAGs can go further — enriching every code chunk with **19 git-derived quality signals**: who wrote it, how often it changes, its bug-fix rate, associated tickets, and more.

Re-index with git metadata enabled:

<AiQuery>Clear the index and re-index this codebase with git metadata enabled</AiQuery>

Or add the environment variable to your MCP configuration:

```bash
-e CODE_ENABLE_GIT_METADATA=true
```

Now you can ask questions that no regular code search can answer:

<AiQuery>Find high-churn code that keeps getting fixed — the danger zones</AiQuery>

<AiQuery>Who owns the authentication module? Show me the dominant authors</AiQuery>

<AiQuery>Find stable, battle-tested implementations I can use as templates</AiQuery>

This is **trajectory enrichment awareness** — the core differentiator of TeaRAGs. Every search result carries its own history, and your agent can reason about code quality, not just code similarity.

See [Git Enrichments](/usage/git-enrichments) for the full list of signals and how to use them.

## You're Up and Running

In 15 minutes you've gone from zero to a fully functional semantic code search with optional git intelligence. Here's what to explore next:

### Deepen Your Understanding

- [Core Concepts](/introduction/core-concepts) — how vectorization, semantic search, and reranking work under the hood
- [What is TeaRAGs](/introduction/what-is-tearags) — the full story, comparisons, and non-goals

### Master Search

- [Query Modes](/usage/query-modes) — semantic, hybrid (BM25 + vectors), and filtered search
- [Search Strategies](/agent-integration/search-strategies) — which tool and preset to use for each task
- [Git Enrichments](/usage/git-enrichments) — all 19 signals and reranking presets

### Level Up Your Agent

- [How to Think with TeaRAGs](/agent-integration/mental-model) — the mental model for agentic code search
- [Agentic Data-Driven Engineering](/agent-integration/agentic-data-driven-engineering) — let your agent make code generation decisions backed by evidence
- [Deep Codebase Analysis](/agent-integration/deep-codebase-analysis) — hotspots, ownership, tech debt, blast radius

### Configure and Tune

- [Configuration Variables](/config/environment-variables) — all environment variables
- [Performance Tuning](/config/performance-tuning) — optimize for your hardware
- [Embedding Providers](/config/providers) — OpenAI, Cohere, Voyage AI as alternatives to Ollama

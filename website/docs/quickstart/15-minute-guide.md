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

- **[Claude Code](https://docs.anthropic.com/en/docs/claude-code/overview)**
  installed and authenticated
- **A git repository** you want to search

Everything else — runtime, embedding model, vector DB, MCP registration — is
handled by the setup plugin.

## Step 1: Install {#step-1}

Pick one of two paths — the plugin wizard (recommended) or a manual install.

### Option A — via the setup plugin (recommended)

Inside Claude Code, add the TeaRAGs marketplace and install the **setup**
plugin (the installation wizard):

```
/plugin marketplace add artk0de/TeaRAGs-MCP
/plugin install tea-rags-setup@tea-rags
```

Run the wizard:

```
/tea-rags-setup:install
```

The wizard walks 9 steps: environment detection, Node.js, `tea-rags` binary,
embedding provider (Ollama / ONNX / OpenAI / Cohere / Voyage), Qdrant (embedded
by default), performance tuning, git analytics, MCP registration, verification.
Progress is saved — if any step fails, re-run `/tea-rags-setup:install` to
resume. **Skip to Step 2 once the wizard finishes.**

:::note Two separate plugins
`tea-rags-setup` installs and configures the TeaRAGs MCP server itself.
The `tea-rags` plugin — installed in Step 3 below — is Claude Code-specific
and ships the skills (`/tea-rags:explore`, `/tea-rags:bug-hunt`, …). Don't
install it yet.
:::

### Option B — manual install

Use this if you want full control, can't use plugins, or are setting up CI.

**B.1. Install Node.js 24+**

<details>
<summary>macOS</summary>

```bash
# With Homebrew (recommended)
brew install node@24

# Or a version manager
brew install fnm && fnm install 24 && fnm default 24
```

</details>

<details>
<summary>Linux / WSL (Debian/Ubuntu)</summary>

```bash
curl -fsSL https://deb.nodesource.com/setup_24.x | sudo -E bash -
sudo apt-get install -y nodejs

# Or via fnm
curl -fsSL https://fnm.vercel.app/install | bash
fnm install 24 && fnm default 24
```

</details>

<details>
<summary>Windows (PowerShell)</summary>

```powershell
# With winget
winget install OpenJS.NodeJS.LTS

# Or fnm
winget install Schniz.fnm
fnm install 24 ; fnm default 24
```

</details>

Verify: `node --version` → `v24.x.x`.

**B.2. Install `tea-rags`**

```bash
npm install -g tea-rags
# or: pnpm add -g tea-rags / yarn global add tea-rags / bun add -g tea-rags
```

Verify: `tea-rags --version`.

:::tip `EACCES` on macOS/Linux?
Either use `sudo npm install -g tea-rags`, or set a user-writable prefix:
`npm config set prefix ~/.npm-global && export PATH=~/.npm-global/bin:$PATH`.
:::

**B.3. Pick an embedding provider**

| Provider                  | When to use                                           | Install                                                           |
| ------------------------- | ----------------------------------------------------- | ----------------------------------------------------------------- |
| **Ollama** (recommended)  | macOS (Apple Silicon), Linux/WSL + NVIDIA/AMD, any CPU host | see below                                                  |
| **ONNX** (built-in, beta) | Windows (DirectML), small projects (≤100k LOC), no external process | nothing to install — `EMBEDDING_PROVIDER=onnx`          |
| **OpenAI**                | Cloud preferred, no local GPU                         | no local install — set `OPENAI_API_KEY`                           |
| **Cohere / Voyage AI**    | Cloud, code-tuned models                              | no local install — set `COHERE_API_KEY` / `VOYAGE_API_KEY`        |

<details>
<summary>Install Ollama + pull the default model</summary>

```bash
# macOS / Linux / WSL
curl -fsSL https://ollama.com/install.sh | sh

# Windows (winget)
winget install Ollama.Ollama

# All platforms — pull the default code-embedding model (~270 MB)
ollama pull unclemusclez/jina-embeddings-v2-base-code:latest
```

Verify: `curl -s http://localhost:11434/api/tags` lists the model.

**AMD on Windows (RDNA2/RDNA3):** install the
[AMD Radeon PRO driver](https://www.amd.com/en/support/professional-graphics)
before Ollama for GPU acceleration.

</details>

<details>
<summary>Use ONNX (built-in, no install)</summary>

No install. At Step 3, register the MCP server with
`-e EMBEDDING_PROVIDER=onnx`. ONNX runs inside the MCP process — no Ollama, no
Docker. Best for Windows (DirectML GPU) and projects under ~100k LOC on CPU.

</details>

<details>
<summary>Use OpenAI / Cohere / Voyage (cloud)</summary>

No install. At Step 3, register with the provider key:

```bash
-e EMBEDDING_PROVIDER=openai -e OPENAI_API_KEY=sk-...
# or: -e EMBEDDING_PROVIDER=cohere  -e COHERE_API_KEY=...
# or: -e EMBEDDING_PROVIDER=voyage  -e VOYAGE_API_KEY=...
```

</details>

**B.4. Register the MCP server in Claude Code**

```bash
# Ollama (defaults — Qdrant embedded, Ollama on localhost:11434)
claude mcp add tea-rags -s user -- tea-rags

# ONNX
claude mcp add tea-rags -s user -- tea-rags -e EMBEDDING_PROVIDER=onnx

# OpenAI
claude mcp add tea-rags -s user -- tea-rags \
  -e EMBEDDING_PROVIDER=openai -e OPENAI_API_KEY=sk-...
```

Qdrant starts automatically (embedded native binary) — no Docker, no
`QDRANT_URL` needed. For external Qdrant or Qdrant Cloud, see
[Connect to an Agent](/quickstart/connect-to-agent).

## Step 2: Restart Claude Code {#step-2}

Restart so it picks up the new `tea-rags` tools. Verify:

```
/mcp
```

`tea-rags` should appear in the list with ~17 tools available.

## Step 3: Install the skills plugin {#step-3}

This is the final step before use — and it's **Claude Code only** (other MCP
clients like Cursor or Roo Code don't support Claude plugins; they can still
talk to the `tea-rags` MCP server directly from Step 1).

```
/plugin install tea-rags@tea-rags
```

> If you used Option A, the marketplace is already added. If you used Option B
> and skipped the plugin marketplace, run
> `/plugin marketplace add artk0de/TeaRAGs-MCP` first.

Now `/tea-rags:explore`, `/tea-rags:bug-hunt`, `/tea-rags:index`,
`/tea-rags:risk-assessment`, `/tea-rags:data-driven-generation`, and
`/tea-rags:force-reindex` are available to your agent. See
[Skills](/usage/skills) for the full list.

## Step 4: Index Your Codebase {#step-4}

Open Claude Code in your project directory and invoke the indexing skill:

```
/tea-rags:index
```

The skill is smart — first run does a full index, subsequent runs do an
**incremental reindex** (only changed files). No arguments needed; the skill
infers the project path from the current working directory.

TeaRAGs will:
1. Discover files (respects `.gitignore` and `.contextignore`)
2. Parse code into semantic chunks using tree-sitter (functions, classes, methods)
3. Attach trajectory signals (git + static) per chunk
4. Generate vector embeddings via your chosen provider
5. Store everything in Qdrant

**First index takes 1–5 minutes** depending on codebase size. Later runs take
seconds.

:::tip Large rewrites or branch switches
Use `/tea-rags:force-reindex` — zero-downtime full re-index. Search stays
available on the current collection while the new one is built.
:::

:::note Not using the `tea-rags` plugin?
If you went with Option B and skipped Step 3 (skills plugin), ask your agent
directly: _"Index this codebase with tea-rags"_ — it will call the
`index_codebase` MCP tool.
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

## Step 6: Git Intelligence (enabled by default) {#step-6}

Standard semantic search is already powerful. TeaRAGs goes further — enriching every code chunk with **20+ quality signals**: who wrote it, how often it changes, its bug-fix rate, associated tickets, structural imports, documentation weight, and more.

**This is enabled by default** (`TRAJECTORY_GIT_ENABLED=true`). No re-index needed — if your project is a git repo, every chunk already carries git signals.

To disable (non-git project or fast iteration), set:

```bash
-e TRAJECTORY_GIT_ENABLED=false
```

You can immediately ask questions that no regular code search can answer:

<AiQuery>Find high-churn code that keeps getting fixed — the danger zones</AiQuery>

<AiQuery>Who owns the authentication module? Show me the dominant authors</AiQuery>

<AiQuery>Find stable, battle-tested implementations I can use as templates</AiQuery>

This is **trajectory enrichment awareness** — the core differentiator of TeaRAGs. Every search result carries its own history, and your agent can reason about code quality, not just code similarity.

See [Git Enrichments](/usage/advanced/git-enrichments) for the full list of signals and how to use them.

## You're Up and Running

In 15 minutes you've gone from zero to a fully functional semantic code search with optional git intelligence. Here's what to explore next:

### Deepen Your Understanding

- [Core Concepts](/introduction/core-concepts) — how vectorization, semantic search, and reranking work under the hood
- [What is TeaRAGs](/introduction/what-is-tearags) — the full story, comparisons, and non-goals

### Master Search

- [Query Modes](/usage/advanced/query-modes) — semantic, hybrid (BM25 + vectors), and filtered search
- [Search Strategies](/agent-integration/search-strategies) — which tool and preset to use for each task
- [Git Enrichments](/usage/advanced/git-enrichments) — full catalog of 20+ signals and reranking presets

### Level Up Your Agent

- [How to Think with TeaRAGs](/agent-integration/mental-model) — the mental model for agentic code search
- [Agentic Data-Driven Engineering](/agent-integration/agentic-data-driven-engineering) — let your agent make code generation decisions backed by evidence
- [Deep Codebase Analysis](/agent-integration/deep-codebase-analysis) — hotspots, ownership, tech debt, blast radius

### Configure and Tune

- [Configuration Variables](/config/environment-variables) — all environment variables
- [Performance Tuning](/config/performance-tuning) — optimize for your hardware
- [Embedding Providers](/config/providers) — OpenAI, Cohere, Voyage AI as alternatives to Ollama

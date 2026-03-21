---
title: TeaRAGs Documentation
slug: /
sidebar_position: 0
---

import DinoLogo from '@site/src/components/DinoLogo'; import MermaidTeaRAGs from
'@site/src/components/MermaidTeaRAGs';

<DinoLogo />

# TeaRAGs

**Trajectory Enrichment-Aware RAG system for Coding Agents** 🦖🍵

A high-performance code RAG system exposed as an MCP server. Built for large
monorepos and enterprise codebases (millions of LOC). Combines semantic
retrieval with git-derived development history signals — authorship, churn,
volatility, bug-fix rates — to rerank results beyond pure similarity.

## How It Works

<MermaidTeaRAGs>
{`
flowchart LR
    User[👤 User]

    subgraph mcp["TeaRAGs MCP Server"]
        Agent[🤖 Agent<br/><small>orchestrates</small>]
        TeaRAGs[🍵 TeaRAGs<br/><small>search · enrich · rerank</small>]
        Agent <--> TeaRAGs
    end

    Qdrant[(🗄️ Qdrant<br/><small>vector DB</small>)]
    Embeddings[✨ Embeddings<br/><small>Ollama/OpenAI</small>]
    Codebase[📁 Codebase<br/><small>+ Git History</small>]

    User <--> Agent
    TeaRAGs <--> Qdrant
    TeaRAGs <--> Embeddings
    TeaRAGs <--> Codebase

`} </MermaidTeaRAGs>

<div style={{textAlign: 'center', marginTop: '10px', color: '#666', fontSize: '14px'}}>
User → Agent calls TeaRAGs tools → TeaRAGs queries Qdrant + enriches results → Agent makes decisions
</div>

## Why Trajectory Enrichment Awareness?

**Trajectory Enrichment-Aware RAG is a new philosophy of code retrieval.** Not
an incremental improvement — a fundamental shift in what search results _mean_.

Standard code search finds code that **looks like** your query. It has no
opinion on whether that code is good. TeaRAGs introduces a principle: **every
piece of retrieved code must carry its own history** — who wrote it, how often
it changed, how many times it was fixed, how stable it is, and why it exists.
This transforms retrieval from pattern matching into evidence-based
decision-making.

The result: 19 git-derived scoring signals per chunk, composable into reranking
presets like `hotspots`, `ownership`, `techDebt`, and `securityAudit`. Code that
is **stable, well-owned, and battle-tested** rises to the top. Code that is
**risky, volatile, and bug-prone** gets flagged.

This enables
[**agentic data-driven engineering**](/agent-integration/agentic-data-driven-engineering)
— a paradigm where AI agents make code generation decisions backed by empirical
evidence, not pattern matching intuition.

## Why TeaRAGs?

55% fewer tool calls. 97% fewer fresh input tokens. 27.5% lower cost. And that's
just semantic search over grep — before trajectory enrichment even kicks in.

With trajectory enrichment awareness, the agent goes further: it knows which
code is **stable** and which is **buggy**, who **owns** each domain, which
functions have a **0–20% bug-fix rate** vs **50%+**, and links every chunk to
**JIRA/GitHub tickets**. All at **function-level granularity** — not just per
file.

Isn't that awesome?
**[Read the full breakdown: Agent on Grep vs Semantic Search vs TeaRAGs](/introduction/what-is-tearags#why-tearags)**

## Key Features

- 🧠 **Intelligence layer for coding agents** — makes your AI agent smarter by
  giving it empirical signals about code quality, ownership, and evolution. Not
  just "find similar code" but "find the _right_ code to learn from"
- 📊 **Agentic data-driven engineering** — agents make code generation decisions
  backed by evidence (stable templates, anti-pattern avoidance, style matching,
  risk assessment), not pattern matching intuition
- 🧬 **Git trajectory enrichment awareness** — 19 git-derived signals per chunk
  (churn, volatility, authorship, bug-fix rate, task traceability) feed a
  composable reranking layer with presets like `hotspots`, `ownership`,
  `techDebt`, `securityAudit`
- 🔮 **Topological trajectory enrichment awareness** _(planned)_ — symbol
  dependency graphs, cross-file coupling, blast radius analysis. The next
  dimension of code intelligence
- 🔍 **Semantic & hybrid search** — natural language queries with optional BM25
  keyword matching and Reciprocal Rank Fusion
- 🎯 **AST-aware chunking** — tree-sitter parsing for functions, classes,
  methods across most popular languages including Ruby and Markdown
- 🚀 **Built for scale** — fast local indexing for enterprise codebases
  (millions of LOC), incremental reindexing, parallel pipelines
- 🔒 **Privacy-first** — works fully offline with Ollama, your code never leaves
  your machine
- 🔌 **Provider agnostic** — Ollama (local), OpenAI, Cohere, Voyage AI — swap
  without reindexing
- ⚙️ **Highly configurable** — fine-tune batch sizes, concurrency, caching.
  Auto-tuning benchmark included (`npm run tune`)

## Getting Started

- [What is TeaRAGs](/introduction/what-is-tearags) — overview and key features
- [Core Concepts](/introduction/core-concepts) — vectorization, semantic search,
  trajectory enrichment awareness, reranking
- [Installation](/quickstart/installation) — prerequisites and setup
- [Connect to an Agent](/quickstart/connect-to-agent) — configure Claude Code,
  Roo, or Cursor
- [Create Your First Index](/quickstart/create-first-index) — index a codebase
  in one command
- [Your First Query](/quickstart/first-query) — search your code with natural
  language

## Documentation

| Section                                                   | Description                                                                          |
| --------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| [Introduction](/introduction/what-is-tearags)             | What TeaRAGs is, origin story, comparison, non-goals                                 |
| [Core Concepts](/introduction/core-concepts)              | Code vectorization, semantic search, trajectory enrichment awareness, reranking      |
| [**Quickstart**](/quickstart/installation)                | Get up and running in 15 minutes — [15-Minute Guide](/quickstart/15-minute-guide)    |
| [Usage](/usage/indexing-repositories)                     | Indexing repositories, query modes, use cases                                        |
| [Configuration](/config/environment-variables)            | Environment variables, embedding providers, performance tuning                       |
| [Git Enrichments](/usage/git-enrichments)                 | Git-derived quality signals: churn, ownership, stability, task IDs                   |
| [**Agent Workflows**](/agent-integration/mental-model)    | Mental model, search strategies, deep analysis, data-driven code generation          |
| [Architecture](/architecture/overview)                    | System design, pipelines, data model                                                 |
| [Knowledge Base](/knowledge-base/rag-fundamentals)        | RAG theory, code search, software evolution, blast radius, criticism &amp; responses |
| [Tools Schema](/api/tools)                                | MCP tools, search parameters, reranking presets                                      |
| [Design Decisions](/rfc/0001-incremental-indexing)        | RFCs documenting key architectural choices                                           |
| [Operations](/operations/troubleshooting-and-error-codes) | Troubleshooting, FAQ, recovery                                                       |
| [Extending](/extending/adding-providers)                  | Adding providers, custom chunkers, development setup                                 |
| [Roadmap](/roadmap/architecture-evolution)                | Future plans and open questions                                                      |

## Acknowledgments

Huge thanks to:

- **[Martin Halder](https://github.com/mhalder)** and the
  **[qdrant-mcp-server](https://github.com/mhalder/qdrant-mcp-server)** project
  for the solid foundation — a clean architecture, excellent documentation, the
  MIT license that made this fork possible, and the research on code indexing
  that paved the way
- **[qdrant/mcp-server-qdrant](https://github.com/qdrant/mcp-server-qdrant)** —
  the ancestor of all forks
- **To Grandpa [Docusaurus](https://docusaurus.io/)** — for making beautiful,
  functional documentation effortless 📚

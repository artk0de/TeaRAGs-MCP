---
title: TeaRAGs Documentation
slug: /
sidebar_position: 0
---

import DinoLogo from '@site/src/components/DinoLogo'; import MermaidTeaRAGs from
'@site/src/components/MermaidTeaRAGs';

<DinoLogo />

# TeaRAGs 🦖🍵

**Your coding agent copies the first code it finds — not the right one.**

TeaRAGs is an MCP server for code search that enriches every retrieved chunk
with git history: authorship, churn, bug-fix rate, ownership. Your agent stops
learning from hotspots and starts learning from **stable, owned, battle-tested
code**.

[→ Quickstart (15 min)](/quickstart/installation) ·
[Core Concepts](/introduction/core-concepts)

## The Problem

### 1. Understanding a monorepo is expensive — for humans AND agents

Every new developer pays in hours. Every fresh agent session pays in tokens.
Naming conventions, domain logic, local idioms — all of it has to be rebuilt
from scratch, every time.

### 2. Bad code hygiene is a tax on your agent

Confusing names mean the agent reads more files. More files mean more tokens,
slower responses, and a higher chance of picking the wrong example. Your
codebase's technical debt is now your AI bill.

### 3. Agents can't tell stable code from a hotspot

Standard code search ranks by embedding similarity alone. It doesn't know which
function gets bug-fixed every sprint, which module hasn't been touched in two
years, or whose name is on the commits. So the agent copies whatever looks
similar — including the broken examples.

## The Solution

TeaRAGs gives your agent two things it can't get from vanilla code search.

### 1. Every chunk carries its own history

Retrieved code comes with signals about **who wrote it, how stable it is, how
often it gets bug-fixed**, and **how impactful a change would be**. Semantic
similarity stops being the whole answer — it becomes the floor.

### 2. Pre-built skills, not just raw tools

TeaRAGs ships agent **skills** — ready-made playbooks that tell your agent when
and how to use the signals. No prompt engineering required:

- `explore` — orient in an unfamiliar codebase
- `data-driven-generation` — write code backed by stable, owned templates
- `risk-assessment` — know what you'd break before you break it
- `refactoring-scan` · `bug-hunt` · `pattern-search` — and more

Install the plugin, your agent learns the workflow.
[See all skills →](/usage/skills/)

## Use Cases

### 🛡️ Safe code generation

Your agent writes new code backed by **stable, canonical templates** — modules
with a low bug-fix rate, long stability, and a clear owner. No more copying from
last sprint's hotspot. _Skill: `data-driven-generation` ·
[Why stable code is safer →](/knowledge-base/code-churn-research)_

### 🔧 Refactoring planning & problem-pattern discovery

Find the 5% of code responsible for 80% of incidents. **High churn + high
bug-fix rate + concentrated ownership = your next production issue** — and your
next refactoring candidate. _Skills: `refactoring-scan`, `bug-hunt`_

### 🎯 Risk assessment before changes

Before modifying a function, the agent checks **who depends on it, how often it
breaks, and what its ticket history says**. Know the blast radius before you
blast. _Skill: `risk-assessment` ·
[Coupling & blast radius theory →](/knowledge-base/code-quality-metrics)_

### 🗺️ Learning an unfamiliar codebase

Ask questions instead of reading directory trees. _"How does auth work?"_
returns the **stable, canonical implementation** with its history attached — not
a random similar-looking snippet. _Skill: `explore`_

## How It Works

<MermaidTeaRAGs>
{`
flowchart LR
    User[👤 You]
    Agent[🤖 Coding agent<br/><small>+ TeaRAGs skills</small>]

    subgraph pkg["🍵 tea-rags"]
        MCP[🔌 MCP server<br/><small>23 tools</small>]
        CLI[⌨️ CLI<br/><small>index · prime · projects · auto-update</small>]
        Core[⚙️ Core<br/><small>chunk · enrich · search · rerank</small>]
        MCP --> Core
        CLI --> Core
    end

    subgraph storage["💻 Local storage"]
        Qdrant[(🗄️ Qdrant<br/><small>embedded · vectors + signals</small>)]
        DuckDB[(🦆 DuckDB<br/><small>embedded · call graph</small>)]
    end

    Embeddings[✨ Embeddings<br/><small>Ollama · OpenAI · Cohere · Voyage</small>]
    Codebase[📁 Your repo<br/><small>code + git history</small>]

    User <--> Agent
    Agent <--> MCP
    User --> CLI
    Core <--> Qdrant
    Core <--> DuckDB
    Core --> Embeddings
    Core --> Codebase

`} </MermaidTeaRAGs>

<div style={{textAlign: 'center', marginTop: '10px', color: '#666', fontSize: '14px'}}>
Your agent calls TeaRAGs over MCP; you run the CLI to index and maintain.
Both drive one core: it chunks code on AST boundaries, embeds each chunk,
attaches git and call-graph signals, and ranks results by what the task needs.
Qdrant and DuckDB run embedded — no Docker, no servers to manage.
</div>

## What You Get

- 🧬 **Trajectory-aware retrieval** — scores results by git history and the call
  graph, not just embedding similarity
- 📚 **Ships with agent skills** — 14 skills for exploration, bug hunting, risk
  assessment, code generation, review, and index management
- 🔒 **Local-first, privacy-first** — embedded Qdrant and DuckDB, embeddings
  through Ollama; your code never leaves your machine (cloud providers optional)
- 🚀 **Built for enterprise monorepos** — AST-aware chunking across 9 languages,
  incremental reindexing, parallel pipelines, millions of LOC tested

## Who It's For

- **Developers in large monorepos** — where "find similar code" returns a dozen
  near-duplicates and you need the _canonical_ one
- **Solo devs doing agentic development** — agent-driven workflows produce
  bursts of micro-commits that wreck churn metrics. TeaRAGs ships a
  [**GIT SESSIONS**](/architecture/git-enrichment-pipeline#git-sessions) mode
  (`TRAJECTORY_GIT_SQUASH_AWARE_SESSIONS=true`) that groups commits by
  `(author, time gap)` so a 20-commit refactor session counts as **one**.
  Churn, bug-fix rate, and ownership stay meaningful even with a single
  human + an agent as the only contributors.
- **Tech leads worried about AI code quality** — who want their team's agents
  to learn from stable modules, not from last sprint's hotspot
- **Privacy-sensitive teams** — finance, healthcare, defense, or anyone who
  can't send source code to a cloud API

**Not for:** repos without git history (no signal to enrich) or teams that
only need autocomplete (use Copilot).

## Next Steps

| I want to...                 | Start here                                                                                         |
| ---------------------------- | -------------------------------------------------------------------------------------------------- |
| **Get it running**           | [Quickstart (15 min)](/quickstart/installation) — install, index, first query                      |
| **Understand the concept**   | [Core Concepts](/introduction/core-concepts) — vectorization, trajectory enrichment, reranking     |
| **See what my agent can do** | [Skills](/usage/skills/) — 14 agent skills for exploration, generation, risk, review               |
| **Look under the hood**      | [Architecture](/architecture/overview) — pipelines, data model, reranker internals                 |
| **Learn the theory**         | [Knowledge Base](/knowledge-base/rag-fundamentals) — RAG, code search, software evolution research |

## Acknowledgments

Thanks to **[Martin Halder](https://github.com/mhalder)** /
**[qdrant-mcp-server](https://github.com/mhalder/qdrant-mcp-server)** for the
foundation this forks from, and
**[qdrant/mcp-server-qdrant](https://github.com/qdrant/mcp-server-qdrant)** —
the ancestor of all forks. Built with **[Docusaurus](https://docusaurus.io/)**
📚.

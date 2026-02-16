---
title: Origin
sidebar_position: 4
---

## Why TeaRAGs Exists

TeaRAGs was born out of a real engineering pain point. Working in a **large enterprise monorepo** — 3.5 million lines of code, years of history, dozens of contributors — using AI coding agents without semantic code search was an exercise in frustration. The agent couldn't find the right code, copied wrong patterns, and had no understanding of code quality or ownership.

I wanted to fix this — not just for myself, but for my team. The goal was twofold: **make the AI agent actually useful** in a large, actively growing codebase, and test a hypothesis I'd been carrying for a while — what if search results carried **git-derived quality signals** like churn, authorship, and bug-fix rates? Would that meaningfully improve the agent's code generation decisions?

**Spoiler: it did.** The trajectory enrichment layer turned out to be a significant improvement over pure similarity search. Agents started finding stable templates instead of buggy ones, matching the domain owner's style, and avoiding high-churn code.

But getting here was a journey.

## The Journey

### Discovering Semantic Search

I started using Claude Code in May–June 2025. The experience was, to put it bluntly, frustrating. Token limits were eaten in minutes, results were poor, and context was constantly lost. I found myself writing prompts that were 60–70% defensive instructions — "Never do X", "Don't search Y", "Stop reading Z". I cancelled my subscription, disappointed in the promise of agentic coding.

Everything changed in August when [RooCode](https://roocode.com) shipped **[Codebase Indexes](https://docs.roocode.com/features/codebase-indexing)** — their built-in semantic search feature. I restored my Claude subscription to use as a provider for Roo, set up Qdrant in Docker alongside Ollama for local embeddings, and started indexing our monorepo.

For the next five months, I actively used semantic search in my daily workflow. The difference was night and day. It allowed me to:

- **Instantly understand unfamiliar code** — no more spelunking through hundreds of files
- **Diagnose complex bugs in minutes** — find related error handling, retries, edge cases across the codebase
- **Generate code that follows project style** without extra instructions — critical for Ruby, where convention matters enormously
- **Efficiently solve pattern-search tasks** — "find all places where we handle X" became trivial

### The Breakup

By January 2026, I was a RooCode power user. The Roo + Claude + RAG setup was my primary work tool. I'd built muscle memory around it, refined my CLAUDE.md instructions, and was shipping features faster than ever.

Then [Anthropic started banning accounts](https://venturebeat.com/technology/anthropic-cracks-down-on-unauthorized-claude-usage-by-third-party-harnesses) that used Claude Code subscriptions through third-party harnesses ([Hacker News discussion](https://news.ycombinator.com/item?id=46549823)). Claude stopped working as a Roo provider. The RooCode community immediately opened issues requesting native [Claude Code integration](https://github.com/RooCodeInc/Roo-Code/issues/4842) and [OAuth support](https://github.com/RooCodeInc/Roo-Code/issues/4799), but my workflow — the one I'd spent months building — broke overnight.

### Searching for Alternatives

I evaluated the options methodically:

1. **Switch to another agent** — KiloCode was the closest alternative, but compliance concerns made it a non-starter in an enterprise environment.
2. **Replace the provider in Roo** — either switch to Anthropic API (pay-as-you-go costs run roughly 10x a Claude Code Pro subscription) or use alternative models like Gemini and DeepSeek, which were more affordable but nowhere near Anthropic's quality for code generation.
3. **Use an MCP server for semantic search** — bring the RAG capability directly into Claude Code CLI.

I rejected the first two quickly. I didn't want to risk a permanent ban on my corporate Anthropic account by playing cat-and-mouse with harness detection. And paying API rates for the volume I was doing would have been prohibitively expensive.

The final option was the only viable path: **set up a standalone semantic search MCP server** that works natively with Claude Code.

## Market Research

I surveyed the MCP landscape for codebase indexing solutions. Most were research-grade experiments, not ready for enterprise scale (1M+ LOC):

| Solution | Description | Verdict |
|----------|-------------|---------|
| **claude-context** | Most popular at the time. Fully cloud-based, no incremental indexing | Cloud dependency, doesn't scale for enterprise |
| **grepai** | Go-based, file-system watchers, multi-provider embeddings, GPU support, beginner-friendly | No AST chunking, embedded storage only — not enterprise-ready |
| **quad-rag-code** | Python, GPU acceleration, auto-watcher incremental reindex | Research-grade, Python-only, no embedding provider choice |
| **rag-code-mcp** | Go, Qdrant + Ollama | No incremental indexing, no Ruby support |
| **mhalder/qdrant-mcp-server** | Node.js, incremental indexing, Qdrant + Ollama, claimed Ruby support | Best match for my requirements |

Industry leaders — Cursor, RooCode, KiloCode, Sourcegraph, GitHub — all had built-in semantic search. But standalone MCP solutions were sparse and immature. The gap was obvious: nobody had built a production-grade, local-first semantic search MCP that could handle enterprise codebases.

## Testing mhalder's Solution

I spent about a week testing [mhalder/qdrant-mcp-server](https://github.com/mhalder/qdrant-mcp-server) with various parameter combinations against our enterprise monorepo. Full indexing of the 3.5M+ LOC codebase took **4 to 10 hours** depending on configuration. Even incremental reindexing on roughly 100 commits (about 1.5 days of team output) couldn't go faster than 40 minutes.

**What was good:**

- Clean, well-tested codebase with solid architecture
- MIT license — freedom to fork and modify
- Qdrant + Ollama foundation matched my local-first requirement
- The incremental indexing concept was already there

**What needed work:**

- **Performance was the main blocker** — and the bottleneck was architectural, not hardware
- **Ruby AST support was nominal** — the parser was listed but didn't actually work with tree-sitter for Ruby
- **No git metadata enrichment** at all — pure similarity search, blind to code history
- **Poor DX** — every parameter required deep ML knowledge, no intuitive defaults for developers
- **Lacking ADX** (Agentic Developer eXperience) — Claude frequently made errors calling the tools due to unclear parameter schemas
- **Missing MCP Tools API parameters** for a complete search workflow

The conclusion was clear: MCP semantic search tools at that point were enthusiast experiments, not enterprise-ready solutions.

## The Fork Decision

My observation was simple: **"The problem isn't hardware — it's architecture."**

Rather than contributing upstream — MIT license bureaucracy plus stakeholder alignment is not the path when motivation is high and the vision diverges significantly — I decided to fork and build what I needed.

**There's also a deeper reason.** In my career, I've repeatedly encountered engineers who prefer simplicity over complexity — and for good reason. But in this case, complexity was unavoidable. Achieving enterprise-scale performance required fundamental architectural changes: parallel request patterns to Ollama, backpressure-aware pipelines, sharded snapshot storage, consistent hashing for change detection. I wasn't going to spend time convincing stakeholders why the entire core needed to be rewritten with "complex patterns."

My view on simplicity: the decision must be balanced. In my experience, system complexity often emerges *from an excess of simplicity*. It's easier to encapsulate caching in one complex abstraction than to understand how it works when it's scattered in small pieces across every component. Isn't it? Localized complexity with clear boundaries beats distributed simplicity with hidden coupling.

**Core values for the fork:**

- **Local-first** — Ollama + Qdrant as the foundation, cloud optional
- **DX focus** — intuitive for developers, not ML engineers
- **ADX focus** (Agentic Developer eXperience) — intuitive for coding agents, not just humans. Inspired by Steve Yegge's [Desire Paths](https://www.coherenceism.blog/2026-02-02-desire-paths/) philosophy: when an agent hallucinates a command that doesn't exist, implement it — the hallucination is a feature request written in the language of attempted use
- **Performance** — enterprise-scale indexing in reasonable time on average MacBooks
- **eGPU support** — leverage external GPUs on the local network for embedding acceleration
- **The name must be typeable with one left hand** — inspired by [asdf](https://asdf-vm.com/) runtime manager. This consumed roughly 90% of the naming budget. The result: **TeaRAGs** — a T-Rex who drinks tea while doing RAG. Because if you're going to index 3.5 million lines of code, you might as well be civilized about it. 🦖🍵

## What Was Achieved

Key achievements in the fork:

- **Modular architecture** — clear separation of concerns across indexing, chunking, enrichment, and search
- **Improved MCP Tools Schema** — better agent interaction, dramatically fewer Claude errors when calling tools
- **Full Ruby AST parsing** — proper tree-sitter chunking for Ruby, not just line-based splitting
- **Markdown AST chunking** — documentation becomes semantically searchable alongside code
- **Git trajectory enrichment** — 19 signals per chunk with no significant indexing performance loss
- **Git-aware filtering and reranking** — find fresh code, stable code, hotspots, ownership patterns
- **The name** — typeable with one left hand. Worth it.

## Performance: From 4 Hours to 12 Minutes

The most critical achievement was indexing performance. For a 3.5M+ LOC enterprise codebase:

| Setup | Full Index Time | Notes |
|-------|----------------|-------|
| **mhalder/qdrant-mcp-server** | 4–10 hours | Various parameter combinations |
| **RooCode** (eGPU AMD 7800M) | 25–30 min | 40–50% GPU utilization |
| **RooCode** (MacBook M3 Pro) | 1.5–2 hours | Severe system lag during indexing |
| **TeaRAGs** (eGPU AMD 7800M) | **12–14 min** | ~55 chunks/sec, 85–90% GPU utilization |
| **TeaRAGs** (MacBook M3 Pro) | **~17–20 min** | ~60% of eGPU throughput |

Incremental reindexing for ~100 commits: **30–40 seconds** on MacBook, compared to 40+ minutes before.

The full index wait happens only once. After that, incremental reindexing keeps the index fresh in seconds. The difference between waiting 4 hours and waiting 12 minutes is the difference between "I'll index tonight and check tomorrow" and "let me index while I grab coffee."

## What Changed (Detailed)

| Feature | Original | TeaRAGs |
|---------|----------|---------|
| **Snapshot storage** | Single JSON file | Sharded storage (v3) |
| **Change detection** | Sequential | Parallel (N workers) |
| **Hash distribution** | — | Consistent hashing |
| **Merkle tree** | Single level | Two-level (shard + meta) |
| **Delete operations** | Filter scan | Payload index (1000x faster) |
| **Batch pipeline** | Sequential | Parallel with backpressure |
| **Checkpointing** | — | Resume from interruption |
| **Git metadata** | — | 19 signals per chunk |
| **Reranking layer** | — | 9 presets + custom weights |
| **Chunk-level churn** | — | Per-function/method granularity |
| **Task ID extraction** | — | JIRA, GitHub, Azure DevOps, GitLab |
| **Ruby/Markdown AST** | — | Full tree-sitter support |
| **Concurrency control** | Fixed | Configurable via env |
| **Performance benchmarks** | — | Auto-tuning included (`npm run tune`) |
| **Cache compatibility** | — | Auto-migration between versions |

## Acknowledgments

Huge thanks to [Martin Halder](https://github.com/mhalder) and the [qdrant-mcp-server](https://github.com/mhalder/qdrant-mcp-server) project for the solid foundation — a clean architecture, excellent documentation, and the MIT license that made this fork possible. And to the ancestor of all forks — [qdrant/mcp-server-qdrant](https://github.com/qdrant/mcp-server-qdrant).

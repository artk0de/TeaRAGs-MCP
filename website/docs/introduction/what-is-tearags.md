---
title: What is TeaRAGs
sidebar_position: 1
---

TeaRAGs (**T**rajectory **E**nrichment-**A**ware **R**etrieval-**A**ugmented
**G**eneration **s**ystem) is a high-performance code RAG system exposed as an
[MCP server](https://modelcontextprotocol.io/). Built for large monorepos and
actively growing codebases, it combines
[semantic retrieval](/introduction/core-concepts/code-vectorization) with
development history signals — authorship, churn patterns, change volatility,
bug-fix rates — to [rerank results](/introduction/core-concepts/reranking)
beyond pure similarity.

## What It's For

- **[Semantic code search](/introduction/core-concepts/semantic-search)** — find
  code and documentation by intent, not by identifier names. Ask "how does
  authentication work?" and get the actual implementation, even if it's called
  `Pipeline::StageClient`
- **[Agentic data-driven engineering](/agent-integration/agentic-data-driven-engineering)**
  — AI agents making code decisions backed by empirical evidence from your
  repository's history: stable templates, domain owner's style, proven patterns
  — not pattern matching intuition
- **[Deep codebase analysis](/agent-integration/deep-codebase-analysis)** —
  [hotspot detection](/agent-integration/deep-codebase-analysis/risk-assessment#hotspot-detection-the-two-stage-approach),
  [ownership mapping](/agent-integration/deep-codebase-analysis/ownership-and-debt#ownership-and-knowledge-silo-analysis),
  [tech debt scoring](/agent-integration/deep-codebase-analysis/ownership-and-debt#tech-debt-assessment-beyond-age),
  [blast radius estimation](/agent-integration/deep-codebase-analysis/impact-analysis#blast-radius-estimation),
  [churn volatility tracking](/agent-integration/deep-codebase-analysis/risk-assessment#churn-volatility-healthy-vs-pathological-change)
  — all at **function-level granularity**, not just per file, and all queryable
  through [semantic search](/introduction/core-concepts/code-vectorization)

## What It Does

TeaRAGs indexes your codebase into searchable
[vector embeddings](/introduction/core-concepts/code-vectorization), then
enriches each code chunk with
[git-derived quality signals](/usage/advanced/git-enrichments). When an AI agent searches
your code, results are
[re-scored using these signals](/introduction/core-concepts/reranking) — so the
agent finds not just code that _looks right_, but code that is **stable,
well-owned, and battle-tested**.

Learn more in [Core Concepts](/introduction/core-concepts):

- [Code Vectorization](/introduction/core-concepts/code-vectorization) —
  AST-aware chunking pipeline
- [Trajectory Enrichment Awareness](/introduction/core-concepts/tea) — 20+
  signals from git + static providers, at function-level
- [Reranking](/introduction/core-concepts/reranking) — weighted scoring presets
  for quality-aware retrieval

## What It Can Do

**Find code by intent, not by name.** Ask `"How does user authentication work?"`
— get the actual implementation, even if it's called `Pipeline::StageClient` or
`InfoRequest`. No need to guess identifiers. Works in seconds, consuming 2–3x
fewer tokens than grep-based exploration.

**Detect the most dangerous code in your system.** Query with
`rerank: "hotspots"` — instantly surface high-churn, frequently-fixed code that
is statistically likely to break next. A single query replaces hours of manual
`git log` archaeology.

**Find stable, battle-tested templates for code generation.** Query with
`rerank: "stable"` — the agent copies from code that has survived production for
months with minimal changes and near-zero bug fixes, instead of copying from the
first search hit.

**Map code ownership and knowledge silos.** Query with `rerank: "ownership"` —
identify who owns which part of the codebase, where knowledge is concentrated in
a single author (bus factor risk), and whose coding style to match when
contributing to a domain.

**Migrate patterns across a 3.5M LOC codebase.** Use semantic search to analyze
how the first migration was done — the AI completes 95% of the next one.
Rewriting batch operations, moving to new frameworks, standardizing error
handling — all become systematic instead of manual.

**Investigate production bugs in minutes.** Describe the problem in natural
language: `"Where does the system handle failed payment retries?"` — get
relevant code fragments with their stability and churn history. High churn on a
code fragment? That's probably where the bug lives.

**Prepare for audits and compliance.** Search for `"personal data handling"`,
`"access control checks"`, `"logging of sensitive operations"` — get a
structured map of where security-critical logic lives, who owns it, and when it
was last modified.

**Onboard to an unfamiliar codebase in hours, not weeks.** Ask
`"How does background processing work here?"` or
`"Where is the main business logic?"` — build a mental model of any system by
asking questions about behavior, not by reading directory trees.

## Why TeaRAGs {#why-tearags}

### Agent on Grep vs Agent on Semantic Search

Without semantic search, an AI coding agent explores your codebase through brute
force: launching subagents, running dozens of glob/grep calls, reading files
speculatively, and burning through tokens on trial-and-error navigation. With
semantic search, the agent asks one question and gets the right code
immediately.

A
[controlled benchmark by grepai](https://yoanbernabeu.github.io/grepai/blog/benchmark-grepai-vs-grep-claude-code/)
on the Excalidraw codebase (155K+ LOC TypeScript) measured the difference:

| Metric                    | Agent + Grep | Agent + Semantic Search | Change     |
| ------------------------- | ------------ | ----------------------- | ---------- |
| **Subagent launches**     | 5            | 0                       | -100%      |
| **Tool calls**            | 139          | 62                      | **-55%**   |
| **Fresh input tokens**    | 51,147       | 1,326                   | **-97%**   |
| **Cache creation tokens** | 563,883      | 162,289                 | **-71%**   |
| **Total billed cost**     | $6.78        | $4.92                   | **-27.5%** |

The cost savings come from eliminating the most expensive operations: subagent
launches (which create expensive cache contexts) and speculative file reads. The
agent no longer needs to guess where code lives — it knows.

- **2x faster discovery** — the agent doesn't waste turns on dead-end searches
- **2x fewer tokens** — the agent reads only relevant files instead of scanning
  entire directories
- **Comparable result quality** — the same correct answer, just reached faster
  and cheaper

**The savings scale with codebase size.** On a 155K LOC codebase, semantic
search reduced token consumption by 97%. On larger codebases (1M+ LOC, deep
nesting, sprawling domains), the gap widens further — grep-based exploration
becomes exponentially more expensive as the agent searches through more
directories, while semantic search remains constant: one query, immediate
answer, regardless of project size.

> **Research:**
> [grepai: Benchmark grepai vs grep on Claude Code](https://yoanbernabeu.github.io/grepai/blog/benchmark-grepai-vs-grep-claude-code/)
> (detailed token/cost breakdown) |
> [Zilliz: Why I'm Against Claude Code's Grep-Only Retrieval](https://zilliz.com/blog/why-im-against-claude-codes-grep-only-retrieval-it-just-burns-too-many-tokens)
> (40%+ token reduction, qualitative analysis)

### Agent on Semantic Search vs Agent on TeaRAGs

Plain semantic search finds code that **looks like** your query. That's a
massive improvement over grep — but the agent still has no idea whether the code
it found is _good_. It copies the first match, blind to quality.

TeaRAGs adds a
**[trajectory enrichment layer](/introduction/core-concepts/tea)**: every search
result carries [20+ signals](/usage/advanced/git-enrichments) from git and
static-analysis providers — churn, stability, authorship, bug-fix rates, code
age, imports, path risk — at **function-level granularity**. The agent doesn't
just find code faster. It finds **better code**.

| Capability                         | Semantic Search       | TeaRAGs                             |
| ---------------------------------- | --------------------- | ----------------------------------- |
| Find code by meaning               | ✅                    | ✅                                  |
| Hybrid search (BM25 + vector)      | ⚠️ some tools         | ✅ RRF fusion                       |
| Know if code is stable or volatile | ❌                    | ✅ `churnVolatility`, `commitCount` |
| Know who owns the code             | ❌                    | ✅ `dominantAuthor`, `authors[]`    |
| Know if code is buggy              | ❌                    | ✅ `bugFixRate` per function        |
| Know when code was last touched    | ❌                    | ✅ `ageDays`, `lastModifiedAt`      |
| Link code to JIRA/GitHub tickets   | ❌                    | ✅ `taskIds[]`                      |
| Find stable templates to copy      | ❌ guessing           | ✅ `rerank: "stable"`               |
| Avoid high-risk code               | ❌ guessing           | ✅ `rerank: "hotspots"`             |
| Match domain owner's style         | ❌                    | ✅ `rerank: "ownership"`            |
| Assess tech debt before modifying  | ❌                    | ✅ `rerank: "techDebt"`             |
| Function-level metrics             | ❌ file-level at best | ✅ per function/method              |

**The difference in practice:** a plain semantic search agent copies the first
match and hopes for the best. A TeaRAGs-powered agent finds code with a 0–20%
bug-fix rate, written by the domain owner, stable for 6+ months — and copies
_that_ instead.

> This is the shift from **"find similar code"** to
> **[agentic data-driven engineering](/agent-integration/agentic-data-driven-engineering)**
> — code generation decisions backed by empirical evidence.

## Who It's For

- **Enterprise developers** working in large, actively growing codebases (1M+
  LOC) where grep stops being effective and deep domain knowledge is scattered
  across teams and timezones. As a **privacy-first, local-first solution**,
  TeaRAGs runs entirely on your machine — your code never leaves the perimeter,
  no cloud APIs required
- **Developers exploring unfamiliar codebases** — engineers who need to
  understand architecture conceptually rather than search for specific
  implementations. Ask "how does the system handle X?" or "what are the core
  abstractions?" and build a mental model by asking questions about behavior,
  patterns, and responsibilities — not by reading file trees or grepping for
  class names
- **Projects with deep domain knowledge and naming challenges** — codebases
  where identifiers don't match their purpose (`Pipeline::StageClient` for
  authentication, `InfoRequest` for user data), where business logic is buried
  behind generic abstractions, or where the same concept has different names
  across modules. Semantic search cuts through naming inconsistency to find code
  by _what it does_, not what it's called
- **Large monorepo teams** where code ownership matters, patterns evolve across
  hundreds of contributors, and the cost of copying the wrong template is
  measured in production incidents
- **AI-assisted development enthusiasts** who want to push coding agents beyond
  naive context injection — using empirical signals to make agents genuinely
  smarter about code quality and risk

## Who It's Not For (For Now)

- **Small teams with small codebases** — if your project fits in a single
  developer's head and `grep` finds everything you need, the overhead of a
  vector database and embedding pipeline isn't justified yet. TeaRAGs shines
  when scale makes intuition unreliable.
- **Microservice architectures with many small repos** — TeaRAGs is optimized
  for monorepos and large codebases. If each service is 5–20K LOC in its own
  repository, the trajectory enrichment signals (churn, ownership, cross-file
  patterns) have less data to work with. That said, indexing multiple repos into
  separate collections is supported — it just won't deliver the same depth of
  insight as a monorepo with rich git history.

## Next Steps

- [Origin](/introduction/origin) — why TeaRAGs was created, the journey from
  frustration to a working tool
- [Comparison](/introduction/comparison) — TeaRAGs vs claude-context, grepai,
  serena, and others
- [Core Concepts](/introduction/core-concepts) — how code vectorization,
  trajectory enrichment, and reranking work together
- [Use Cases](/usage/use-cases) — 5 real-world semantic search scenarios from an
  enterprise codebase
- [Non-Goals](/introduction/non-goals) — what TeaRAGs deliberately doesn't do
- [Quickstart](/quickstart/installation) — get up and running in 15 minutes

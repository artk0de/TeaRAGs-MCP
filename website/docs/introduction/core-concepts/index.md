---
title: Core Concepts
sidebar_position: 1
---

import MermaidTeaRAGs from '@site/src/components/MermaidTeaRAGs';

TeaRAGs transforms source code into searchable vector embeddings enriched with
development history signals. Understanding these five layers is key to getting
the most out of the system.

## 1. [Code Vectorization](./code-vectorization)

How source code becomes searchable. The indexing pipeline scans your project,
splits code into semantic chunks using AST-aware parsers (tree-sitter), converts
chunks into vector embeddings, and stores them in Qdrant. Incremental reindexing
detects changes and updates only affected chunks.

## 2. [Semantic Search](./semantic-search)

The foundation: finding code by intent and meaning, not exact keywords. Ask "how
does authentication work?" and get the actual implementation, even if it's
called `Pipeline::StageClient`. Supports hybrid search (semantic + BM25) for
combining meaning-based and keyword-based retrieval.

## 3. [Trajectory Enrichment Awareness](./tea)

What makes TeaRAGs different from standard code RAG. Each chunk is augmented
with **20+ signals from two trajectory providers** — git (churn, authorship,
volatility, bug-fix rates, task traceability) and static (imports/blast radius,
documentation weight, heading relevance, path risk). Signals are attached at
both file and chunk (function/method) granularity. This metadata enables
quality-aware retrieval: find code that is not just similar, but also stable,
well-owned, or risky.

## 4. [Reranking](./reranking)

How trajectory signals are used at search time. Results from vector similarity
are re-scored using composable weight presets (`hotspots`, `ownership`,
`techDebt`, `securityAudit`, etc.) or custom weight configurations.

## 5. Agentic Data-Driven Engineering

Trajectory enrichment + reranking together enable a new paradigm: **AI agents
making code decisions backed by empirical evidence**, not pattern matching
intuition. Instead of copying the first search hit, an agent can:

- **Find stable templates** (`rerank: "stable"`) — low-bug, battle-tested code
- **Avoid anti-patterns** (`rerank: "hotspots"`) — high-churn, bug-prone code
- **Match domain owner's style** (`rerank: "ownership"`) — consistent
  conventions
- **Understand context** via `taskIds` — why the code exists
- **Assess risk** (`rerank: "techDebt"`) — defensive patterns for legacy code

> _This transforms code generation from artistic guesswork into data-driven
> engineering._

👉
**[Agentic Data-Driven Engineering](/agent-integration/agentic-data-driven-engineering)**
— full strategies, workflows, and the transformation table.

## How It All Fits Together

<MermaidTeaRAGs>
{`
flowchart TB
    subgraph INPUT["Source Code"]
        files["Project Files"]
        git["Git History"]
    end

    subgraph VECTORIZE["1. Code Vectorization"]
        scan["File Discovery<br/>.gitignore · .contextignore"]
        chunk["AST-Aware Chunking<br/>tree-sitter: functions, classes, methods"]
        embed["Vector Embedding<br/>Ollama · OpenAI · Cohere · Voyage"]
    end

    subgraph ENRICH["3. Trajectory Enrichment Awareness"]
        fmeta["File-Level Signals<br/>commitCount · authors · bugFixRate<br/>churnVolatility · taskIds"]
        cmeta["Chunk-Level Overlay<br/>chunkCommitCount · chunkBugFixRate<br/>chunkAgeDays per function"]
    end

    subgraph STORE["Qdrant"]
        vectors["Dense Vectors"]
        sparse["Sparse Vectors · BM25"]
        payload["Payload: git + static signals"]
    end

    subgraph SEARCH["2. Semantic Search"]
        qembed["Query Embedding"]
        similarity["Cosine Similarity<br/>Semantic / Hybrid (RRF)"]
        results["Ranked Results"]
    end

    subgraph RERANK["4. Reranking"]
        rerank["Reranking Presets<br/>hotspots · ownership · techDebt<br/>securityAudit · stable · codeReview"]
        final["Final Scores"]
    end

    subgraph AGENT["5. Agentic Data-Driven Engineering"]
        strategies["Find stable templates · Avoid anti-patterns<br/>Match owner style · Assess risk"]
        output["Evidence-backed<br/>code generation"]
    end

    files --> scan --> chunk --> embed
    git --> fmeta --> cmeta

    embed --> vectors
    embed --> sparse
    cmeta --> payload

    qembed --> similarity
    vectors --> similarity
    sparse --> similarity
    similarity --> results

    results --> rerank
    payload --> rerank
    rerank --> final

    final --> strategies --> output

`} </MermaidTeaRAGs>

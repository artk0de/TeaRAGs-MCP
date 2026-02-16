---
title: 'TEA: Trajectory Enrichment Awareness'
sidebar_position: 4
---

Standard code RAG systems embed source code as text and retrieve by semantic similarity alone. This works for "find code that looks like X" but ignores the history of how code evolved.

**Trajectory enrichment** attaches signals about code evolution to each chunk at index time — **at the chunk level** (individual functions/methods/classes), not just the file level. TeaRAGs implements **git trajectory enrichment** (derived from version control history) and plans **topological trajectory enrichment** (derived from code structure and dependencies).

## Git Trajectory Signals

These signals describe _how_ the code was developed over time:

| Signal Category | Examples | What It Captures |
|----------------|----------|-----------------|
| **Temporal** | `ageDays`, `lastModifiedAt`, `firstCreatedAt` | When code was written and last changed |
| **Churn** | `commitCount`, `relativeChurn`, `changeDensity`, `churnVolatility` | How frequently and erratically code changes |
| **Authorship** | `dominantAuthor`, `contributorCount`, `dominantAuthorPct` | Who owns the code and how concentrated ownership is |
| **Quality** | `bugFixRate`, `chunkBugFixRate` | How often changes are bug fixes |
| **Traceability** | `taskIds` | Which tickets/issues drove the changes |

### Two Granularity Levels

- **File-level**: all chunks from a file share the same git metadata (e.g., `dominantAuthor`, `contributorCount`, `commitCount`)
- **Chunk-level**: commits are mapped to specific line ranges via diff hunk analysis, giving **per-function/method** churn, bug-fix rate, and age (e.g., `chunkCommitCount`, `chunkBugFixRate`, `chunkAgeDays`) — distinguishes hot functions from stable ones within the same file

### Confidence Dampening

Statistical signals (`ownership`, `bugFixRate`, `volatility`) are confidence-dampened when commit counts are low, preventing noisy data from dominating results. A function with 1 commit and 100% bugFixRate is treated differently from one with 20 commits and 100% bugFixRate.

## How This Differs from Standard Code RAG

| Aspect | Standard Code RAG | Trajectory-Enriched RAG |
|--------|-------------------|------------------------|
| **Index time** | Embed code text as vectors | Embed code text + attach git trajectory metadata per chunk |
| **Retrieval** | Rank by cosine similarity | Rank by similarity, then rerank using trajectory signals |
| **"Find risky code"** | Not possible (no risk signals) | `rerank: "hotspots"` — boost high-churn, high-bugfix chunks |
| **"Who owns this?"** | Not possible | `rerank: "ownership"` — surface single-author knowledge silos |
| **"What changed for ticket X?"** | Not possible | `taskId: "TD-1234"` — trace code to requirements |
| **"Find stable examples"** | Return whatever is most similar | `rerank: "stable"` — boost low-churn, well-established code |
| **Chunk granularity** | Same score for all chunks in a file | Per-chunk churn overlay — each function/method tracked independently |

The trajectory layer is **opt-in**. Without `CODE_ENABLE_GIT_METADATA=true`, the system operates as a standard semantic code search with AST-aware chunking and hybrid (BM25 + vector) retrieval.

## Agentic Data-Driven Engineering

Trajectory enrichment opens the path to **agentic data-driven engineering** — a paradigm where AI coding agents make engineering decisions backed by empirical evidence from version control history, not pattern matching intuition.

Standard code RAG retrieves by semantic similarity: "find code that looks like X." An agent copies the first match without knowing if that code is stable, bug-prone, or written by an intern on their first day. With trajectory-enriched retrieval, every search result carries quality signals. An agent can reason about **what to copy, what to avoid, and why code exists** — before writing a single line.

**5 core strategies:**

1. **Stable Pattern Recognition** (`rerank: "stable"`) — find battle-tested, low-bug code as templates (low churn, low bugFixRate, survived production)
2. **Anti-Pattern Avoidance** (`rerank: "hotspots"`) — identify high-churn, bug-prone code to avoid (high bugFixRate, high churnVolatility)
3. **Style Consistency** (`rerank: "ownership"`) — match the dominant author's patterns for a code area
4. **Historical Context** (`taskIds`, `metaOnly: true`) — understand feature intent through ticket references
5. **Risk Assessment** (`rerank: "techDebt"`) — identify legacy code requiring defensive modification

> *This transforms code generation from artistic guesswork into data-driven engineering.*

👉 **[Full explanation with examples](/agent-integration/agentic-data-driven-engineering)**

## Planned: Topological Trajectory Enrichment

In addition to git trajectory signals, a planned extension adds **topological trajectory enrichment** derived from code structure analysis:

- **Symbol dependency graph** — which functions/classes call or depend on each other
- **Cross-file coupling** — files that frequently change together (logical coupling from commit co-occurrence)
- **Blast radius** — number of transitive dependents affected by changing a symbol

These signals would feed the same reranking layer, enabling queries like "find high-impact code with many dependents" or "find tightly coupled modules."

👉 **[Code Quality Metrics: Theory & Research](/knowledge-base/code-quality-metrics)**

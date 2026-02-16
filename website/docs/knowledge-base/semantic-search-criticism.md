---
title: Semantic Search — Criticism and Responses
sidebar_position: 6
---

# Semantic Search: Criticism and Responses

Semantic code search is not without critics. Understanding the real limitations — and the established counter-arguments — helps teams make informed adoption decisions and use the tool correctly.

## Criticism 1: RAG Results Are Incomplete or False

### What's Actually Being Criticized

**"Embedding-only RAG doesn't understand code"** — The criticism targets using vector similarity as the primary relevance criterion. For code, similarity shows "looks like this textually" but not "participates in this execution path." An agent may find semantically correct but unused or secondary code fragments.

**"RAG creates false confidence"** — When a model cites retrieved chunks, the answer looks "grounded" even if retrieval was incomplete or irrelevant. This is especially dangerous in code generation and refactoring: errors look convincing and are rarely questioned.

**"Single-vector embeddings are fundamentally limited"** — One embedding per chunk poorly encodes combinatorial and multi-hop queries ("all places where A and B under condition C"). This is a mathematical limitation, not a model quality issue.

**"Code is a graph, not a document"** — Semantic search over chunks ignores relationships: who calls whom, in what order, under what conditions. For understanding system behavior, this is critical — and why RAG over "text" is seen as insufficient.

### Counter-Arguments

1. **Semantic search is for discovery, not for answers.** After semantic search, there's always verification through code search (grep, symbols, call-sites). Best practice: treat RAG as a **candidate zone generator**, not as proof.

2. **Mandatory verification step.** The workflow is: RAG → hypothesis → code search → confirmation. The agent is prohibited from drawing conclusions without confirmed call-sites or side-effects. RAG becomes a "lead," not an "argument."

3. **Hybrid retrieval.** Dense (semantic) + sparse (keyword/rg) + structural signals. Embeddings remain the first filter; precision is added through symbols, grep, and graphs.

4. **Semantic search is the entry point to the graph, not its analysis.** Real understanding is built through call-sites, symbols, and execution paths obtained via code search.

> **TeaRAGs approach:** Hybrid search (BM25 + vector via RRF) combined with git trajectory signals. Results are not just "similar" — they carry empirical quality indicators (stability, churn, ownership) that help the agent assess confidence.

## Criticism 2: Semantic Search Is Worse Than Planning Mode

### What's Actually Being Criticized

Planning mode is compared to RAG as an alternative because it better controls context and reduces noise. In this comparison, RAG is presented as a static, imprecise mechanism that "serves up similar stuff" rather than conducting research. This typically applies to "naive RAG" that's called automatically and always — context is added "just in case."

### Counter-Arguments

1. **Planning and semantic search serve different roles.** Planning manages steps; semantic search accelerates discovery. 2025/2026 best practice: planning decides *when* to call RAG, not replaces it.

2. **Planning mode doesn't solve discovery problems.** It works poorly when entry points are unknown, the project has significant legacy, and naming is inconsistent.

3. **Cursor explicitly positions semantic search as a discovery tool** for large codebases.

> **TeaRAGs approach:** TeaRAGs is designed to be called by an agent as part of a planned workflow — not as a naive context injection layer. The agent decides when semantic search adds value, uses appropriate rerank presets for the task at hand, and verifies results through complementary tools.

## The Bottom Line

Semantic code search is not a silver bullet. It's a **discovery accelerator** that works best when:

1. Combined with verification tools (grep, symbols, call-sites)
2. Used as part of a structured agent workflow, not as automatic context injection
3. Enriched with quality signals (git metrics, reranking) to reduce false confidence
4. Applied to the right problems (large codebases, unfamiliar code, pattern discovery)

The criticisms are valid for naive, embedding-only RAG. TeaRAGs addresses them through hybrid search, trajectory enrichment, and composable reranking — moving from "find similar text" to "find the right code to learn from."

### These Principles in Practice

The verification workflow and multi-tool cascade are implemented as concrete agent instructions across the documentation:

- [Exact-Match Verification](/agent-integration/agentic-data-driven-engineering/generation-modes#exact-match-verification) — the mandatory ripgrep step after code generation, with failure examples and correct workflow
- [The Three-Tool Cascade](/agent-integration/search-strategies/multi-tool-cascade) — TeaRAGs (meaning) → tree-sitter (structure) → ripgrep (exact text), with anti-patterns
- [Semantic Search is NOT a Grep Replacement](/introduction/core-concepts/semantic-search#not-grep-replacement) — the core verification principle with Mermaid workflow diagram

## Calibrating Reranking Weights Per Codebase {#calibrating-weights}

Preset reranking uses hardcoded normalization bounds (e.g., `maxCommitCount = 50`, `maxAgeDays = 365`, `maxBugFixRate = 100`). These defaults work for many codebases, but every codebase has a unique profile: a young startup repo where `commitCount = 10` is high churn looks very different from a 10-year enterprise monorepo where `commitCount = 200` is normal.

**The problem:** If your codebase's median `commitCount` is 3, the `hotspots` preset will barely distinguish between files — everything is "low churn" relative to the normalization ceiling of 50. Conversely, if your codebase's median `commitCount` is 80, the signal saturates and everything looks like a hotspot.

**The solution:** Sample your codebase's metadata distribution, then adjust custom weights and interpretation thresholds accordingly.

### Discovery prompt

Use this prompt with your AI agent to profile your codebase's metric distribution. The agent will sample metadata from your index and compute meaningful percentiles:

```text
Profile the codebase for reranking calibration.

Step 1: Get a metadata sample.
Run semantic_search with:
  - query: "core business logic"
  - metaOnly: true
  - limit: 100 (or as high as practical)
Repeat with 2-3 different broad queries ("data processing", "API handlers",
"utility functions") to get a representative sample.

Step 2: From the collected git metadata, compute for each signal:
  - Minimum, maximum, median, P75, P95 values for:
    commitCount, ageDays, bugFixRate, relativeChurn, churnVolatility,
    contributorCount, dominantAuthorPct
  - If chunk-level data is available:
    chunkCommitCount, chunkChurnRatio, chunkBugFixRate, chunkAgeDays

Step 3: Report findings as a table:
  | Signal | Min | Median | P75 | P95 | Max |
  with interpretation notes for this specific codebase.

Step 4: Recommend adjusted thresholds:
  - What counts as "high churn" in THIS codebase? (P75 of commitCount)
  - What counts as "old code"? (P75 of ageDays)
  - What counts as "buggy"? (P75 of bugFixRate)
  - Are chunk-level metrics available and meaningful?

Step 5: Suggest custom rerank weights optimized for this codebase:
  - A "hotspots" variant using codebase-specific signal distribution
  - A "stable template" variant for finding the best code to copy
  - Which signals have too little variance to be useful (skip them)
```

### What to look for

| Codebase profile | Typical signals | Calibration advice |
|-----------------|----------------|-------------------|
| **Young repo** (< 1 year, < 50K LOC) | Low commitCount across the board, few contributors | `chunkChurn` and `bugFix` are the most useful discriminators. `age` is uninformative — everything is young. Focus custom weights on `bugFix` + `volatility`. |
| **Mature monorepo** (5+ years, 500K+ LOC) | Wide distribution in all signals, many outliers | All signals are useful. Set custom thresholds at P75 rather than hardcoded values. `relativeChurn` is the strongest defect predictor — use it over raw `commitCount`. |
| **High-velocity team** (daily deploys, CI/CD) | Low `churnVolatility`, high `changeDensity` | `volatility` is uninformative — everyone commits regularly. Focus on `bugFix` + `chunkChurnRatio` for quality signals. |
| **Legacy codebase** (infrequent changes) | High `ageDays`, low `commitCount` | `recency` and `burstActivity` become the key discriminators — any recent change is significant. Use custom weights with `burstActivity: 0.4, bugFix: 0.3, pathRisk: 0.3`. |

### Example: Calibrated vs default

A 3-year enterprise monorepo with `commitCount` median = 45:

```json
// Default "hotspots" preset — poor discrimination
// (maxCommitCount = 50, so everything above 50 saturates)

// Calibrated custom weights for this codebase:
{
  "rerank": {
    "custom": {
      "chunkChurn": 0.25,
      "bugFix": 0.3,
      "volatility": 0.25,
      "chunkRelativeChurn": 0.2
    }
  }
}
```

By shifting from absolute `churn` (which saturates at P50 in this codebase) to `chunkRelativeChurn` (which measures the chunk's share of file churn, always 0-1) and `volatility` (which captures erratic patterns regardless of scale), the search produces meaningful differentiation even when raw commit counts are uniformly high.

## References

- [Cursor: Semantic Search Documentation](https://cursor.com/docs/context/semantic-search)
- [Cursor: Agent Best Practices](https://cursor.com/blog/agent-best-practices)
- [Reddit: RAG Is Dead?](https://www.reddit.com/r/CLine/comments/1n88mxs/rag_is_dead/)
- [23 RAG Pitfalls and How to Fix Them](https://www.nb-data.com/p/23-rag-pitfalls-and-how-to-fix-them)
- [Legal RAG Hallucinations (Stanford)](https://dho.stanford.edu/wp-content/uploads/Legal_RAG_Hallucinations.pdf)
- [OpenReview: Planning vs RAG](https://openreview.net/forum?id=cUuOKnjVQJ)

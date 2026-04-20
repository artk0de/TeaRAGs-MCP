---
title: "Mental Model"
sidebar_position: 1
---

# How to Think with TeaRAGs

TeaRAGs is not a search engine with extra metadata. It's a system that changes **how coding agents should reason about which code to trust**. This page explains the shift.

## Why This Page Exists

Most developers and agents treat code retrieval as a similarity problem: "find code that looks like my query." TeaRAGs adds a second dimension — **code evolution** — and this requires a different mental model. Without it, you'll use TeaRAGs as a fancy grep and miss the point entirely.

## Traditional RAG Mindset

In standard code RAG, the retrieval loop is:

1. Embed the query
2. Find the most similar chunks
3. Inject them into context
4. Generate code

The optimization target is **relevance**: how closely does the retrieved code match the query? The implicit assumption is that similar code is useful code.

This works until it doesn't. The first search hit might be:
- A prototype someone abandoned
- A pattern that was reverted three times
- Code written by an intern, rewritten by a senior, then rewritten again
- A function that technically does what you want but breaks every sprint

Similarity tells you nothing about any of this.

## Trajectory-Aware Mindset

TeaRAGs shifts the optimization target from **"find similar code"** to **"find code that improves the agent's decision quality."**

Every retrieved chunk carries 20+ signals — 23 raw git signals (13 file-level + 10 chunk-level) plus 14 derived git signals covering churn, stability, authorship, bug-fix rates, code age, task references; and 7 static structural signals (imports fan-out, documentation weight, path risk, chunk density). These signals encode **how code has evolved and how it's structured**, not just what it looks like right now.

The thinking patterns change:

| Traditional RAG | Trajectory-Aware RAG |
|----------------|---------------------|
| "Find code that looks like X" | "Find code that looks like X **and has survived production**" |
| "Copy the first match" | "Copy the match with the lowest bug-fix rate" |
| "Any example will do" | "Find the domain owner's implementation" |
| "This code is relevant" | "This code is relevant **and stable** — or relevant **and volatile** (which is a signal too)" |
| "Ignore code history" | "High churn = treat as anti-pattern, not template" |

The key insight: **volatile code is not noise to be filtered out — it's a signal.** A function with 12 commits and a 60% bug-fix rate tells the agent something important: don't copy this, don't extend this without understanding why it keeps breaking.

## How Agents Should Reason

An agent using TeaRAGs effectively follows three steps:

### 1. Explore Context

Search semantically to understand the landscape. Use `rerank: "relevance"` first — find what exists.

### 2. Evaluate Signals

Before using any result, check the trajectory signals:
- **Low churn + old age** → stable pattern, safe to copy
- **High churn + high bug-fix rate** → anti-pattern, study but don't replicate
- **Single dominant author** → domain expert's style, match it
- **Multiple task IDs** → code evolved through many requirements, understand them before modifying
- **Recent + high commit count** → active development area, coordinate with the team

### 3. Select for Decision Quality

Choose context that leads to better decisions, not just more context. Three chunks of battle-tested code are more valuable than twenty chunks of relevant-but-unknown-quality code.

## Decision Hierarchy

When an agent receives search results, signals should be evaluated in this order:

```
1. Similarity     — is this code relevant to my task?
2. Trajectory     — is this code stable, owned, and low-risk?
3. Impact         — if I base my code on this, what's the blast radius?
```

Similarity is the entry filter. Trajectory signals determine trust. Impact determines caution.

A result that scores high on similarity but low on stability is a **warning**, not a template. A result that scores moderately on similarity but high on stability and clear ownership is often the better choice.

## Git Data Depth

TeaRAGs collects git history at two different granularities, each with its own time window:

| Level | Variable | Default | What It Controls |
|-------|----------|---------|-----------------|
| **File-level** | `GIT_LOG_MAX_AGE_MONTHS` | 12 months | `git log` analysis: commit counts, authors, task IDs per file |
| **Chunk-level** | `GIT_CHUNK_MAX_AGE_MONTHS` | 6 months | `git blame` analysis: per-function churn, volatility, bug-fix rates |

The defaults are deliberately generous. Research on code churn and defect prediction consistently shows that **shorter windows (2–6 months) capture the most actionable signals**, while longer windows add historical context at the cost of noise from resolved issues.

- **Nagappan & Ball (2005)** demonstrated that relative code churn measures — especially when normalized by time — are strong predictors of defect density. Their "weeks of churn / file count" metric highlights the importance of temporal extent in churn analysis. ([IEEE ICSE 2005](https://ieeexplore.ieee.org/document/1553571/))
- **Adam Tornhill** ("Your Code as a Crime Scene", "Software Design X-Rays") recommends **2–3 month windows** as a practical heuristic for hotspot and temporal coupling analysis — old data from resolved issues can interfere with current analysis. ([adamtornhill.com](https://www.adamtornhill.com/articles/crimescene/codeascrimescene.htm), [Pragmatic Bookshelf](https://pragprog.com/titles/atcrime2/your-code-as-a-crime-scene-second-edition/))
- **GitClear (2024–2025)** analyzed 211M changed lines and found that code revised within two weeks of commit is a reliable quality signal — supporting the idea that shorter, focused windows detect instability better than full-history analysis. ([GitClear Research](https://www.gitclear.com/ai_assistant_code_quality_2025_research))

### Why File-Level Metrics Matter for Tech Debt

The 12-month file-level window (`GIT_LOG_MAX_AGE_MONTHS`) serves a different purpose than chunk-level churn. While chunk-level signals tell you which *functions* are unstable, file-level signals reveal **structural tech debt** — the kind that accumulates silently and surfaces as friction during development.

TeaRAGs computes these file-level metrics from `git log`:

| Metric | What It Reveals |
|--------|----------------|
| `commitCount` | How often the file changes — high values indicate a coordination bottleneck |
| `relativeChurn` | (linesAdded + linesDeleted) / currentLines — how much of the file has been rewritten |
| `changeDensity` | commits / months — average change frequency over the analysis window |
| `churnVolatility` | stddev(days between commits) — erratic patterns suggest reactive patching |
| `bugFixRate` | % of commits with fix/bug/hotfix keywords — direct measure of defect density |
| `contributorCount` | Number of unique authors — high counts + high churn = coordination cost |
| `dominantAuthorPct` | How concentrated ownership is — low % on a high-churn file = no one owns the debt |
| `taskIds` | Ticket references from commits — traces debt back to business decisions |

The research behind this approach:

- **Tornhill's hotspot model** identifies tech debt as the *product* of complexity and change frequency — a complex file that rarely changes is low priority, but a complex file that changes weekly is the most expensive debt in your system. ([CodeScene: Technical Debt](https://codescene.io/docs/guides/technical/hotspots.html))
- **CodeScene's Code Health** metric (1–10 scale) combines behavioral signals (churn, coupling) with structural ones (complexity) to prioritize which debt to pay first — proving that file-level git metrics are sufficient for actionable debt ranking even without parsing the code. ([CodeScene: Code Health](https://codescene.com/product/code-health))
- **GitClear's tech debt model** tracks "recurrently active" files (modified 2+ times per month across multiple months) as the strongest file-level predictor of future defects — more reliable than raw churn alone. ([GitClear: Measuring Tech Debt](https://www.gitclear.com/measuring_tech_debt_a_guide_for_data_driven_technical_managers))
- **Gartner (2024)** recognized behavioral code analysis (churn + complexity product) as one of five tool categories for measuring and monitoring tech debt. ([Gartner Report via CodeScene](https://codescene.com/resources/gartner-report-measure-and-monitor-technical-debt-with-5-types-of-tools))

An agent using `rerank: "techDebt"` leverages these file-level signals to surface files where debt is highest. Combined with `metaOnly: true`, it can build a tech debt report without reading a single line of code — purely from evolution signals.

### Adjusting Thresholds

The defaults (6 months chunk / 12 months file) work well for most codebases. But agents can reason about whether to adjust:

- **Young codebase (&lt;1 year)** — defaults cover the entire history, no adjustment needed
- **Mature codebase (5+ years)** — defaults already filter out ancient history; if signals feel noisy, *reduce* `GIT_CHUNK_MAX_AGE_MONTHS` to 3
- **High-velocity team (daily deploys)** — consider reducing chunk window to 3 months for sharper hotspot detection
- **Legacy migration** — *increase* `GIT_LOG_MAX_AGE_MONTHS` to 24+ to capture the full migration arc

The reranker normalizes all signals relative to the analysis window. Changing the window doesn't break presets — it shifts what "old" and "high churn" mean within that window.

## The Common Mistake

The most common mistake is using TeaRAGs as plain semantic search — ignoring the enrichment signals and treating results as a flat ranked list.

If you're not using `rerank` presets, not reading `bugFixRate` or `commitCount` in results, not distinguishing between stable and volatile code — you're paying the cost of trajectory enrichment without getting the benefit. You'd get the same results from any vector search tool.

TeaRAGs becomes valuable when the agent **reasons about the signals**, not when it merely retrieves more context.

## Key Takeaway

Traditional RAG asks: *"What code looks like what I need?"*

TeaRAGs asks: *"What code looks like what I need, has proven itself in production, is owned by someone who knows the domain, and won't introduce the same bugs that have already been fixed three times?"*

The difference is not in retrieval quality. It's in **decision quality**.

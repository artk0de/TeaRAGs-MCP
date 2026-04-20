---
title: "Agent-Augmented Development"
sidebar_position: 4
---

# Agent-Augmented Development

What happens to software engineering metrics, workflows, and code quality when a substantial fraction of commits are produced by AI agents. This page summarises the emerging research and explains which of those effects motivate TeaRAGs' design choices — particularly [GIT SESSIONS](/architecture/git-enrichment-pipeline#git-sessions).

---

## The Shift

Agentic development is **qualitatively different** from human coding, not just "faster typing":

- **Commit cadence** — human engineers commit in logical units (a feature, a fix). Agents commit in **micro-increments** (pass the test, adjust one line, pass again). A 20-commit agent session is functionally equivalent to one human commit.
- **Authorship distribution** — solo devs working with an agent produce bimodal histories: mostly `human`, bursts of `agent`. Team ownership heuristics built for human-only histories misinterpret this.
- **Code volume** — generated code outpaces reviewed code. Without tooling that explicitly flags agent-authored regions, review rigor diverges from generation speed.
- **Search patterns** — agents search exhaustively before editing. The cost of a bad search is amplified: they'll act on the first relevant-looking result, not the best one.

These aren't predictions — they're observed in empirical studies of GitHub activity since 2023. TeaRAGs' design assumes all of them.

---

## Academic and Industry Research

### Measuring AI-driven productivity

- **Peng et al. (2023). ["The Impact of AI on Developer Productivity: Evidence from GitHub Copilot."](https://arxiv.org/abs/2302.06590)** Randomized controlled trial across 95 developers. Copilot users completed tasks **55.8% faster** than control. Caveat: single-task benchmark, not sustained workflow.
- **Kalliamvakou et al. (2022). "Research: Quantifying GitHub Copilot's Impact on Developer Productivity and Happiness."** Self-report survey. 88% of respondents said they felt more productive, but this is perception, not measured throughput.
- **Ziegler et al. (2022). ["Productivity Assessment of Neural Code Completion."](https://arxiv.org/abs/2205.06537)** Adoption correlates with productivity self-assessment; acceptance rate is the strongest individual predictor.

### Code quality with AI assistance

- **Hicks et al. (2024). ["Does AI-Assisted Coding Deliver? An Empirical Study of Code Churn, Refactoring, and Bug-Fixing Rates."](https://arxiv.org/abs/2410.12666)** Analysis of 1.5M GitHub commits. AI-assisted commits show **higher churn** and **higher subsequent fix-commit ratios** than non-AI commits within the same repositories. Implications: naive `commitCount`/`bugFixRate` metrics on AI-heavy repos systematically misread "thrashing" as "hotspot".
- **Denny et al. (2023). ["Conversing with Copilot: Exploring Prompt Engineering for Solving CS1 Problems Using Natural Language."](https://arxiv.org/abs/2210.15157)** Multi-round prompt-fix cycles are the norm, not the exception. Code generated in one shot is rare.
- **Dakhel et al. (2023). ["GitHub Copilot AI pair programmer: Asset or Liability?"](https://arxiv.org/abs/2206.15331)** Copilot suggestions were correct 28% of the time on fundamental algorithmic problems. Partial correctness + plausible appearance = latent bug risk.

### Churn-prediction models meet agentic commits

- **Nagappan & Ball (2005). ["Use of Relative Code Churn Measures to Predict System Defect Density."](https://www.microsoft.com/en-us/research/publication/use-of-relative-code-churn-measures-to-predict-system-defect-density/)** Classic result: relative churn (lines changed / file size) is the strongest single defect predictor. See [Code Churn Research](/knowledge-base/code-churn-research) for the full treatment.
- **Tornhill (2018). *Your Code as a Crime Scene* (2nd ed.). Pragmatic Bookshelf.** The "hotspot" model: complexity × change frequency. Works well on human commits; over-flags agent burst commits as hotspots.
- **Bird et al. (2011). ["Don't Touch My Code! Examining the Effects of Ownership on Software Quality."](https://www.microsoft.com/en-us/research/publication/dont-touch-my-code-examining-the-effects-of-ownership-on-software-quality/)** Concentrated ownership correlates with fewer defects. Agent-co-authored commits dilute ownership signals; `dominantAuthorPct` loses fidelity.

---

## Why GIT SESSIONS Exists

The research above lines up into a single problem: **commit-level churn metrics systematically misrepresent agent-heavy codebases**.

TeaRAGs addresses this via the GIT SESSIONS mode (`TRAJECTORY_GIT_SQUASH_AWARE_SESSIONS=true`). It groups commits by `(author, time gap)` — any silence gap larger than `TRAJECTORY_GIT_SESSION_GAP_MINUTES` (default 30) starts a new session. Session count, not raw commit count, feeds churn signals.

Effect on each compromised metric:

| Signal | Raw problem | Session-aware fix |
|--------|-------------|-------------------|
| `commitCount` | 20 micro-commits = "hotspot"; false positive | 20 → 1 session |
| `bugFixRate` | Agent fix-and-retry loop inflates rate | Counted once per session |
| `churnVolatility` | Agent bursts produce extreme stddev | Sessions smooth the burstiness |
| `relativeChurn` | Cumulative lines changed across retries inflate | Deduplicated at session boundaries |

`dominantAuthor` and `taskIds` are **unaffected** — they're inherently per-author-per-ticket and stay meaningful.

See [Git Enrichment Pipeline → GIT SESSIONS](/architecture/git-enrichment-pipeline#git-sessions) for the implementation detail and default tuning.

---

## Practical Implications for Agent Workflows

A few consequences worth building your agent's behaviour around:

1. **Don't learn from your own hotspots.** If the agent sees a file with `commitCount=40` from its own recent session, that's not "important code" — that's churn from last hour's TDD loop. TeaRAGs' `relativeChurn` normalises by file size, and session mode further de-noises.
2. **Pair generation with retrieval.** Agents have an unfair advantage: they can query the index cheaply before writing. Use it — [Agentic Data-Driven Engineering](/agent-integration/agentic-data-driven-engineering) shows the retrieval-first generation pattern.
3. **Freshness beats recency.** `ageDays` changes the moment an agent touches a file. `dominantAuthor` doesn't. Prefer authorship signals over time signals for stability judgements on agent-heavy repos.
4. **Trust tests, not "it looks right".** AI-generated code often compiles and looks plausible but silently fails edge cases. Trajectory signals like `chunkBugFixRate` are proxy indicators for "this function has been wrong before" — useful even when no test is failing right now.

---

## Further Reading

### Inside this knowledge base

- [Code Churn Research](/knowledge-base/code-churn-research) — the underlying theory
- [Semantic Search Criticism](/knowledge-base/semantic-search-criticism) — where agent search tends to fail
- [Signal Scoring Methods](/knowledge-base/signal-scoring-methods) — how raw signals compose into rerank scores

### Where to dig deeper

- ACM Conference on AI for Software Engineering (AISE) proceedings — the current venue for this research
- Neurips / ICSE workshops on "LLMs for Code" — annual reviews of the state of the art
- The [CodeSearchNet benchmark](https://github.com/github/CodeSearchNet) (GitHub, 2019) — still widely used for code-retrieval evaluation

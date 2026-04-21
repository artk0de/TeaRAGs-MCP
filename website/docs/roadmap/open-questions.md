---
title: "Open Questions"
sidebar_position: 3
---

# Open Questions

Design-level questions that aren't resolved yet. Unlike the items in [Architecture Evolution](/roadmap/architecture-evolution) or [Future Layers](/roadmap/future-layers), these are open in the sense that **we don't yet know the right answer** — not in the sense that someone just hasn't written the code.

---

## How should codegraph metrics weight into `techDebt`?

**Tracking**: `tea-rags-mcp-0li` · research, P3

The [Codegraph layer](/roadmap/future-layers#codegraph--dependency-analysis-and-graph-metrics) adds graph signals — in-degree, out-degree, betweenness centrality, cyclic-dependency flags, blast radius, change coupling (both static and temporal). The open question: **how do they compose into the existing tech-debt score?**

Concrete sub-questions:

- **Dominant signal?** Is betweenness (topological importance) a better predictor of debt than raw fan-in, or is it vice versa? No definitive paper on code specifically — we'd need to benchmark on our own corpus.
- **File vs chunk level?** Graph signals are inherently file-level. Does blending them into chunk-level scoring via alpha-dampening (the approach used for existing file/chunk signals) actually help, or does it just dilute the signal?
- **Temporal coupling weight?** Files that change together over time (Zimmermann-Zeller associations) are a classic debt indicator — but they're derived from commit history, and agent-heavy histories inflate them. Does [GIT SESSIONS](/architecture/git-enrichment-pipeline#git-sessions) need to be a hard prerequisite, or can we correct for noise differently?
- **Computational budget.** Betweenness is O(V·E). On a 1M-LOC monorepo with 50k files, that's minutes. Can we approximate cheaply enough, or does graph analysis need a separate batch job instead of running at index time?

The constraint: any design must be compatible with the existing [EnrichmentProvider](/extending/custom-enrichments) contract and survive incremental reindex.

---

## Can we detect harmful (negative-signal) knowledge?

**Tracking**: `tea-rags-mcp-lhtp` · research, P3

[EggVolution](/roadmap/future-layers#eggvolution--self-evolving-associative-memory) has a confident story for confirming knowledge helped — `cosine(egg, diff)` on a good commit increments the `viable` counter. The inverse signal (an egg was harmful) is fundamentally harder.

**The asymmetry:**

- TrueEgg (confirmed): egg → code change → cosine shows connection. Clear signal.
- TearEgg (harmful): egg → code change → …silence? rollback? or nothing at all?

**The DO/DON'T inversion:** an egg saying "don't use X" has inverted cosine semantics:

- `cosine(egg, diff)` high → the prohibited pattern was USED (bad)
- `cosine(egg, diff)` low → prohibition honoured OR the egg isn't relevant. Can't distinguish.

Three possible signal sources, in decreasing reliability:

1. **Explicit rollback** — commit message patterns ("revert", "undo", ticket reopened). Cheap but rare.
2. **Subsequent bug-fix commit** — if a change that matched an egg triggered a bug-fix commit soon after, the egg was probably wrong. Reliable only at statistical scale.
3. **Missing cosine signal over time** — an egg never gets cited; that's weak evidence it's either irrelevant or wrong. Hard to distinguish from "just not seen this code path yet".

The design question is whether any combination of these is strong enough to drive automatic fossilisation, or whether human review must stay in the loop for sterile-counter increments.

---

## Per-project benchmarks — what does "works" mean?

TeaRAGs ships no benchmark harness. Each team that adopts it runs one against their corpus, their query distribution, their labels. That's honest — there isn't one "right" benchmark — but it leaves adopters without a starting point.

Open question: do we ship a **minimal, opt-in evaluation kit** — a recipe that says "collect 20 real queries, record the result you used, compute MRR" — and if so, should it be a CLI subcommand, a skill, or a pure documentation page?

A harness would also let us measure rerank-preset trade-offs empirically instead of via intuition. Today the presets are curated by hand; we don't have data to say "`hotspots` preset is 12% better than `relevance` for query class X."

Tangent: the existing [`/optimize-skill` eval harness](/usage/skills/) in the plugin already measures skill-level effectiveness. Applying the same pattern to retrieval quality is a natural extension — but skill evals test instruction-following, not retrieval accuracy. The unit of measurement differs.

---

## Agent-authored commits — detection vs labelling

[GIT SESSIONS](/architecture/git-enrichment-pipeline#git-sessions) groups bursts of commits so raw `commitCount` doesn't misrepresent agent-heavy repos. It doesn't **label** which commits came from agents vs humans.

Open question: is distinguishing human vs agent authorship worth the complexity?

Pros:
- Enables per-authorship churn metrics ("this file is churny only from humans — genuine activity")
- Better `dominantAuthor` semantics when agent commits dilute the signal
- Research signal: are agent-authored regions actually more bug-prone? (See [Hicks et al. 2024](/knowledge-base/agent-augmented-development#code-quality-with-ai-assistance) — open question empirically.)

Cons:
- No reliable automatic detection (commit authorship is the human — the agent is a tool). Heuristics are error-prone (commit-message patterns, timing).
- Adds a signal we don't need for the common case. GIT SESSIONS already de-noises the primary problem.
- Privacy / attribution concerns if mislabelled.

Current answer: **no**. Revisit when labelling becomes reliable (e.g. `Co-Authored-By: Claude …` becomes ubiquitous and parseable).

---

## Sparse embeddings — SPLADE or stay with BM25?

Today hybrid search is dense + BM25. [SPLADE-style learned sparse](/knowledge-base/rag-fundamentals#dense-vs-sparse-vs-hybrid) has shown gains on general retrieval benchmarks — but we haven't seen code-specific evaluations that clearly favour it over classic BM25.

Open question: is the quality gap large enough on code retrieval specifically to justify the extra complexity (separate model, separate training data, larger sparse vectors)?

This is an empirical question. We'd need a code-retrieval benchmark (see "Per-project benchmarks" above), and the answer probably depends on query distribution — SPLADE might dominate on natural-language queries and tie or lose on bare-symbol queries where BM25's exact-match bias is a feature, not a bug.

---

## How to Contribute a Question

These pages track things we're thinking about. If you've hit a design question we haven't listed — or have evidence that should resolve one we have — open an issue at [github.com/artk0de/TeaRAGs-MCP/issues](https://github.com/artk0de/TeaRAGs-MCP/issues) tagged `design` or drop it into beads directly with `bd create --type=task --priority=3 --labels=research`.

---

## Related

- [Architecture Evolution](/roadmap/architecture-evolution) — structural changes with known targets
- [Future Layers](/roadmap/future-layers) — new capabilities being designed
- [Agent-Augmented Development](/knowledge-base/agent-augmented-development) — research context for several questions above

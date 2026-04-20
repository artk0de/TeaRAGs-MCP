---
title: "Code Search & Retrieval"
sidebar_position: 2
---

# Code Search & Retrieval

Retrieval research has a long history in general IR (document search, question answering). Code search inherits the machinery but differs in important ways. This page surveys the differences and explains which of them shaped TeaRAGs' design.

For the general RAG primer, see [RAG Fundamentals](/knowledge-base/rag-fundamentals). For known failure modes of semantic search on code specifically, see [Semantic Search Criticism](/knowledge-base/semantic-search-criticism).

---

## How Code Is Different from Prose

Code looks like text to a tokenizer but behaves differently for retrieval:

| Property | Prose | Code |
|----------|-------|------|
| Vocabulary | Open, but distribution follows Zipf | Highly skewed: a few identifiers dominate a file, many rare local names |
| Repetition | Paraphrasing is natural | Exact tokens (`UserService`, `processPayment`) carry strong signal |
| Structure | Paragraph-level | AST-level — a function is a unit, not "the next 300 words" |
| Semantics | Meaning from lexical surface + discourse | Meaning from lexical surface + control flow + data flow |
| Test of relevance | "Answers my question" | "Compiles / runs / passes tests" |

The practical consequence: **a retrieval system tuned for prose does worse on code than one that respects code structure**. AST-aware chunking (what TeaRAGs does) preserves function/class boundaries. Character-window splits — standard in general-purpose RAG — split functions in half and degrade every downstream step.

---

## Research on Code Search Quality

### Benchmarks

- **Husain et al. (2019). ["CodeSearchNet Challenge: Evaluating the State of Semantic Code Search."](https://arxiv.org/abs/1909.09436)** The first large-scale benchmark: 2M code-comment pairs across 6 languages. Still the de facto evaluation setup.
- **Huang et al. (2021). ["CoSQA: 20,000+ Web Queries for Code Search and Question Answering."](https://arxiv.org/abs/2105.13239)** Real-world web queries paired with code, scored by human annotators. Revealed that CodeSearchNet-style (comment→code) severely underestimates real query diversity.
- **Shi et al. (2023). ["CoCoSoDa: Effective Contrastive Learning for Code Search."](https://arxiv.org/abs/2204.03293)** Multiple contrastive negatives improve retrieval substantially over the single-positive-one-negative setup of earlier methods.

### Dense retrieval for code

- **Feng et al. (2020). ["CodeBERT: A Pre-Trained Model for Programming and Natural Languages."](https://arxiv.org/abs/2002.08155)** First high-impact bimodal (code+NL) transformer. Outperformed earlier shallow baselines.
- **Guo et al. (2021). ["GraphCodeBERT: Pre-training Code Representations with Data Flow."](https://arxiv.org/abs/2009.08366)** Adds data-flow edges as auxiliary supervision — meaningful gains on code-search benchmarks over CodeBERT.
- **Guo et al. (2022). ["UnixCoder: Unified Cross-Modal Pre-training for Code Representation."](https://arxiv.org/abs/2203.03850)** Unified encoder-decoder for both understanding and generation tasks.
- **Jina AI (2024). ["jina-embeddings-v2-base-code."](https://huggingface.co/jinaai/jina-embeddings-v2-base-code)** Current state of the art for open-source code-specialized embeddings. Default model in TeaRAGs' ONNX provider.

### Lexical and hybrid approaches

- **Robertson & Zaragoza (2009). ["The Probabilistic Relevance Framework: BM25 and Beyond."](https://www.nowpublishers.com/article/Details/INR-019)** The foundation for sparse retrieval. BM25 remains a strong baseline — and is often the only thing that reliably catches exact symbol names.
- **Formal et al. (2021). ["SPLADE: Sparse Lexical and Expansion Model for First Stage Ranking."](https://arxiv.org/abs/2107.05720)** Learned sparse expansion. Under-explored for code specifically.
- **Gao et al. (2022). ["Precise Zero-Shot Dense Retrieval without Relevance Labels (HyDE)."](https://arxiv.org/abs/2212.10496)** Generate a hypothetical answer, embed it, retrieve. Useful when the query is vague — less so for well-specified code queries.

### Evaluating on real tasks

- **Liu et al. (2024). ["RepoBench: Benchmarking Repository-Level Code Auto-Completion Systems."](https://arxiv.org/abs/2306.03091)** Retrieval-augmented generation in repo context. Retrieval quality directly predicts completion quality.
- **Wang et al. (2024). ["CodePlan: Repository-level Coding using LLMs and Planning."](https://arxiv.org/abs/2309.12499)** Shows retrieval errors propagate into multi-step plans more severely than single-step.

---

## Retrieval Pipeline — Code-Specific Considerations

### 1. Indexable units

Tree-sitter-parsed chunks at function/class granularity are the sweet spot for most languages. Exceptions:

- **Ruby-like DSL** — class bodies are often pure declarations (associations, validations). Raw AST chunking produces oversized "body" chunks. TeaRAGs addresses this with custom hooks (`class-body-chunker.ts`). See [RFC 0005](/rfc/0005-trajectory-enrichment-evolution).
- **Markdown** — heading hierarchy replaces AST. Each section is a chunk with a `headingPath`.
- **Data / config** — no semantic AST. Character chunker as fallback; ranking suffers but search still works.

### 2. What to embed

Three choices in the literature:

- **Code body only** — what most systems do. Implicit assumption: the embedding model learned code semantics.
- **Code + docstring** — concatenate. Works if the model was trained bimodally (CodeBERT et al.).
- **Natural-language description generated by an LLM** — hallucinate a description, embed that. Higher quality on some benchmarks, but brittle.

TeaRAGs embeds the code body. This is the fastest, cheapest, and most predictable option, and code-specialized embedders handle bare code well.

### 3. Beyond dense retrieval

Pure vector search has two known weaknesses on code:

- **Rare identifiers** — a query containing `parseSyntacticallyAwareUnicodeText` rarely surfaces its implementation via cosine because identifier names don't compose the way words do. BM25 handles this trivially.
- **Cross-file concepts** — "the auth flow" touches many files. Single-chunk retrieval fragments the picture. Mitigated by using `navigation` links in TeaRAGs payload to walk adjacent chunks after retrieval.

Hybrid retrieval (dense + BM25, fused via reciprocal rank) is the practical answer to the first. TeaRAGs enables hybrid by default for new collections.

### 4. Reranking

Cross-encoders (transformer scoring query+candidate jointly) deliver large quality gains on benchmarks (+5–10 nDCG@10), at 10–100× the latency. In practice, rare choice for interactive tools.

**Feature-based reranking** — weighted sum of signals — is the pragmatic alternative. Trades one big scoring model for many cheap features:

- Similarity (the original retriever's score)
- Lexical features (BM25 overlap with query)
- **Trajectory features** (churn, ownership, bug-fix rate) — TeaRAGs' contribution
- Structural features (function size, cyclomatic complexity when available)

Each feature gets a weight; presets are curated weight configurations (`techDebt`, `hotspots`, etc.). See [Reranking](/introduction/core-concepts/reranking) for the full model.

---

## Evaluation — How Do You Know Code Search Is Good?

Standard IR metrics apply (Recall@K, MRR, nDCG), but the ground truth is harder to obtain:

- **Doc-comment pairs** (CodeSearchNet) — cheap, but pretends comment writing is random. In practice, documented code is a biased sample.
- **Stack Overflow pairs** — query = SO question, answer = accepted code snippet. Closer to real user intent. Used in CoSQA.
- **Bug-fix pairs** — query = bug report, relevant = file touched by the fix. Good for "find the broken thing" queries specifically.
- **Downstream task performance** — run an agent on a task, measure task success conditional on retrieval quality. Expensive, but the most honest signal. What RepoBench does.

TeaRAGs doesn't ship a benchmark harness out of the box. For project-specific evaluation, the typical approach is:

1. Collect 20–50 real queries your team ran this week
2. Record which result they actually clicked / used
3. Compute MRR / nDCG against that small labelled set
4. Tune `rerank` presets to optimise that specific distribution

---

## Further Reading

### Inside this knowledge base

- [RAG Fundamentals](/knowledge-base/rag-fundamentals) — general retrieval primer
- [Semantic Search Criticism](/knowledge-base/semantic-search-criticism) — failure modes with concrete examples
- [Signal Scoring Methods](/knowledge-base/signal-scoring-methods) — the feature-based reranking model in detail
- [Code Churn Research](/knowledge-base/code-churn-research) — the trajectory signals reranking uses

### Landmark papers

- Husain et al. 2019 (CodeSearchNet) — the starting point for any code-search survey
- Feng et al. 2020 (CodeBERT) — the dense retrieval turning point for code
- Guo et al. 2021 (GraphCodeBERT) — the data-flow-aware refinement

### Venues

- ESEC/FSE, ICSE — primary software-engineering venues
- SIGIR — the information-retrieval side
- MSR (Mining Software Repositories) conference — overlap between retrieval and software evolution research

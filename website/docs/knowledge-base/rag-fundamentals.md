---
title: "RAG Fundamentals"
sidebar_position: 1
---

# RAG Fundamentals

Retrieval-Augmented Generation (RAG) was introduced by [Lewis et al. (2020)](https://arxiv.org/abs/2005.11401) as a way to combine a parametric model (a pretrained language model) with a non-parametric memory (a searchable corpus). Instead of asking a model to recall facts from its weights, RAG retrieves the relevant documents at query time and conditions the generation on them.

This page is a compact primer on the concepts — what they mean in general and how they map onto TeaRAGs specifically. For the practical side (indexing, filtering, reranking), see [Core Concepts](/introduction/core-concepts).

## The RAG Loop

A minimal RAG system has four phases:

1. **Ingestion** — documents are split into chunks, embedded into vectors, and stored in an index.
2. **Retrieval** — at query time, the query is embedded and the top-K nearest chunks are returned.
3. **Reranking** (optional) — retrieved chunks are re-ordered by a secondary model or rule set.
4. **Generation** — the chunks are injected into a prompt, and the LLM writes the answer grounded on them.

TeaRAGs is a **retrieval + reranking** system. It does not run the LLM — that's the agent's job. The value TeaRAGs adds over a plain vector DB is in steps 2 and 3: the trajectory signals attached at indexing time make reranking aware of code-quality context, not just semantic similarity.

## Why Chunking Matters

LLMs have finite context windows. Even if a file is relevant, you can't drop 2000 lines of it into a prompt. Chunking splits files into retrievable units — the trade-off:

- **Too small** → each chunk loses its surrounding context. "What does this function do?" answered by 5 lines that don't mention the class.
- **Too large** → chunks become unfocused. Embedding vectors blur multiple concerns together; ranking treats one-good-function-among-ten as equally relevant.

Naïve implementations split by character count or paragraph. TeaRAGs uses **AST-aware chunking** — tree-sitter parses the file, and per-language hooks choose the right granularity: functions and classes for code, headings for documentation. This preserves semantic boundaries automatically. See [Code Vectorization](/introduction/core-concepts/code-vectorization) for the per-language rules.

## Embedding Space and Semantic Similarity

Every chunk becomes a vector in a fixed-dimensional space (typically 384–1536 dimensions). Two chunks are "similar" when their vectors are close — usually measured by cosine similarity.

The key property: **the embedding model defines what "similar" means**. General-purpose models (OpenAI `text-embedding-3-*`, `bge-base`) treat code and prose the same way — OK for mixed corpora. Code-specialized models (`jina-embeddings-v2-base-code`, Voyage `voyage-code-2`) are trained on source + docs and capture programming-language semantics better. TeaRAGs defaults to code-specialized for this reason.

**Limitation semantic search alone doesn't solve:** similarity is a floor, not a ceiling. Two functions implementing retry logic will be similar — but if one was last touched by a contractor who left, had 12 bug-fix commits in a month, and lives in a 3000-line file that nobody else understands, you don't want to copy it. Semantic similarity can't see that. This is the gap TeaRAGs fills with [trajectory enrichment](/knowledge-base/code-churn-research).

## Dense vs Sparse vs Hybrid

There are three broad flavours of retrieval:

| Approach | Strength | Weakness |
|----------|----------|----------|
| **Dense** (vectors, e.g. cosine) | Captures meaning, robust to synonyms and rephrasing | Weak on exact tokens, rare names, numeric identifiers |
| **Sparse** (BM25, TF-IDF, SPLADE) | Great at exact symbols (`getUserById`, `TODO`, ticket IDs) | Blind to semantics — "retry logic" won't find `retryWithBackoff` |
| **Hybrid** | Combines both via reciprocal rank fusion (RRF) or weighted sum | Two indexes to maintain; tuning the fusion weight is non-trivial |

TeaRAGs supports dense-only and hybrid modes. Hybrid is enabled by default for new collections — BM25 catches the "I know the symbol name" cases while dense handles everything else. See [Query Modes](/usage/advanced/query-modes) for the practical picture.

## The Retrieval–Reranking Split

Retrieval is **fast but coarse** — it scores every indexed chunk against the query and returns the top-K. The scoring function has to run over millions of chunks, so it's kept simple (cosine / BM25).

Reranking is **slow but precise** — it takes the top-K and re-orders them using richer signals. Since it only runs on K chunks (typically 50–100), it can afford more expensive computation:

- Cross-encoder models (a transformer that reads query + chunk together)
- Heuristic composites (weighted sum of features)
- Trajectory signals (TeaRAGs' approach — git-derived quality scores)

The pipeline is **retrieve wide, rerank narrow**. TeaRAGs defaults to retrieving 100 and returning top-10 after rerank — adjustable per tool.

## Evaluation: How Do You Know RAG Works?

Standard metrics from information retrieval carry over:

- **Recall@K** — of the relevant chunks that exist, how many did retrieval return in the top K?
- **MRR (Mean Reciprocal Rank)** — on average, how high did the correct answer rank?
- **nDCG (normalized Discounted Cumulative Gain)** — weights earlier ranks more heavily

For code search, relevance is usually determined by human labelling (is this function actually what I wanted?) or proxy signals (did the agent need to read anything else to finish the task?). See the [Semantic Search Criticism](/knowledge-base/semantic-search-criticism) page for known failure modes.

## Common RAG Failure Modes

- **Hallucinated relevance** — embedding model finds something semantically close that isn't actually useful. Mitigated by hybrid search (BM25 floor) and trajectory reranking (promote stable, not just similar).
- **Chunk fragmentation** — query needs information split across several chunks. Mitigated by keeping `navigation` links (TeaRAGs stores `prevSymbolId`/`nextSymbolId` so agents can walk adjacent chunks) and by AST-aware chunking (function-level atomicity).
- **Stale index** — corpus changed but index didn't. Mitigated by incremental reindex (`reindex_changes`) and content-hash snapshots.
- **Out-of-distribution queries** — user phrases the question in a way no indexed document matches. Mitigated by hybrid search and by multi-turn expansion on the agent side.

## How TeaRAGs Maps to These Concepts

| RAG concept | TeaRAGs implementation |
|-------------|------------------------|
| Corpus | Your codebase |
| Chunks | AST-aware splits (function, class, markdown heading) |
| Embedding model | Pluggable: ONNX, Ollama, OpenAI, Cohere, Voyage |
| Vector store | Qdrant (embedded or external) |
| Retrieval | Dense (`semantic_search`) or hybrid (`hybrid_search`) |
| Reranking | Weighted sum over derived signals from trajectory providers |
| Relevance enrichment | Git-derived signals: churn, authorship, bug-fix rate, ownership |
| Chunk metadata | Full payload — see [Data Model](/architecture/data-model) |

TeaRAGs is intentionally **retrieval + rerank only** — no generation. The agent (Claude, GPT, whatever) does the generation; TeaRAGs gives it the right chunks with the right context. That separation makes the whole stack provider-agnostic and debuggable.

## Further Reading

### Foundational papers

- Lewis et al. (2020). ["Retrieval-Augmented Generation for Knowledge-Intensive NLP Tasks."](https://arxiv.org/abs/2005.11401) *NeurIPS*.
- Karpukhin et al. (2020). ["Dense Passage Retrieval for Open-Domain Question Answering."](https://arxiv.org/abs/2004.04906) *EMNLP*.
- Izacard & Grave (2021). ["Leveraging Passage Retrieval with Generative Models for Open Domain Question Answering."](https://arxiv.org/abs/2007.01282) *EACL*.

### Code retrieval specifically

- Feng et al. (2020). ["CodeBERT: A Pre-Trained Model for Programming and Natural Languages."](https://arxiv.org/abs/2002.08155) *EMNLP*.
- Guo et al. (2022). ["UnixCoder: Unified Cross-Modal Pre-training for Code Representation."](https://arxiv.org/abs/2203.03850) *ACL*.

### Hybrid retrieval

- Robertson & Zaragoza (2009). ["The Probabilistic Relevance Framework: BM25 and Beyond."](https://www.nowpublishers.com/article/Details/INR-019) *Foundations and Trends in IR*.
- Formal et al. (2021). ["SPLADE: Sparse Lexical and Expansion Model for First Stage Ranking."](https://arxiv.org/abs/2107.05720) *SIGIR*.

### Inside this knowledge base

- [Code Search & Retrieval](/knowledge-base/code-search-and-retrieval) — deeper dive specific to code
- [Semantic Search Criticism](/knowledge-base/semantic-search-criticism) — known failure modes
- [Code Churn Research](/knowledge-base/code-churn-research) — why git history is a useful quality signal
- [Signal Scoring Methods](/knowledge-base/signal-scoring-methods) — how raw signals become scores

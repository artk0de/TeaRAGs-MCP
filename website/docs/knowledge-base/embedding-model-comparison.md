---
title: "Embedding Model Comparison"
sidebar_position: 10
---

# Embedding Model Comparison

Fifteen GGUF configurations of eight embedding models, served by llama-server
on one GPU host, measured for throughput and for retrieval quality on three
code corpora (2026-10-03). The practical outcome — which model to index with —
is on [Embedding model choice](/config/embedding-model-choice). How
llama-server itself compares with Ollama on the same host is on
[llama-server vs Ollama: measured configurations](/config/providers/llama-server-benchmarks).

## Method

### Hardware

- **GPU host:** Windows 11 mini-PC (Intel Core Ultra 9 285H) with an AMD Radeon
  RX 7800M eGPU (12 GB) and an Intel Arc 140T iGPU. llama.cpp build 11222,
  Vulkan.
- **Layout "3 RX + 1 Arc":** three llama-server instances on the RX, one on the
  Arc, each `-np 4 -fa on`. The per-slot context is the model's training
  context: 8192 for jina v2 code, 2048 for CodeRankEmbed, 8192 for
  Muninn-small.

### Speed

Synthetic load from a LAN client: batches of 64 production chunks (about 670
characters on average), four requests in flight per server, about 45 s per
configuration. The figure is aggregate texts per second. Every model was
measured in the same session.

### Quality

Known-item retrieval. For each corpus an LLM wrote 200 natural-language queries,
each from one sampled chunk, describing its behaviour **without copying
identifiers**. The target of a query is that exact chunk among all chunks of
the corpus.

- **Metrics:** MRR and Recall@1, @5, @10.
- **dense** is cosine similarity only; **hybrid** is dense fused with BM25 by
  reciprocal rank fusion (k = 60).
- **Set B** (private Rails app only): 145 queries, each the source of a
  production Ruby method; the targets are the spec chunks that mention it.
  Metric: recall@10.

### Corpora

| Corpus | Language | Chunks | Files | Query |
| --- | --- | ---: | ---: | --- |
| Private Rails app | Ruby, RSpec tests | 1652 | 60 spec files | Paraphrased test scenario (set A); method source (set B) |
| mastodon | Ruby, production `app/` | 2543 | 414 | Behaviour description |
| TeaRAGs | TypeScript, production `src/`, tests excluded | 3130 | 353 | Behaviour description |

### Noise floor and caveats

- With 200 queries, one query is 0.5 percentage points. Differences below about
  3 pp of R@1 or 0.02 MRR are noise.
- For a few very long chunks the LLM read only the first 1.2–1.8k characters
  when writing their queries (5 on TeaRAGs, some on mastodon).
- mxbai-embed-large inputs were truncated to 510 tokens: 78 of the 1024 texts
  in the speed set, 68 of the 1652 RSpec chunks.

## Speed

Layout 3 RX + 1 Arc unless noted.

| Model | Params | GGUF | texts/s | vs jina |
| --- | ---: | ---: | ---: | ---: |
| jina-embeddings-v2-base-code f16 (current default) | 161M | 323 MB | 385 | 1.00× |
| jina v2 code Q8_0 | | 173 MB | 370 | 0.96× |
| jina v2 code Q4_K_M | | 109 MB | 324 | 0.84× |
| CodeRankEmbed f16 | 137M | 274 MB | 356 | 0.92× |
| CodeRankEmbed Q8_0 | | 146 MB | 359 | 0.93× |
| Muninn-small f16 | 47M | 97 MB | 914 | 2.37× |
| Muninn-small Q8_0 | | 52 MB | 844 | 2.19× |
| mxbai-embed-large f16 (510-token inputs) | 335M | 670 MB | 161 | 0.42× |
| mxbai-embed-large Q8_0 | | 357 MB | 164 | 0.43× |
| jina-code-embeddings-0.5b f16 / Q8_0 | 494M | 994 / 531 MB | 45 / 45 | 0.12× |
| BGE-Code-v1 Q8_0 / Q4_0 | 1.5B | 1646 / 935 MB | 22 / 21 | 0.06× |
| Qodo-Embed-1-1.5B Q8_0 | 1.5B | 1646 MB | 23 | 0.06× |
| Nomic Embed Code Q4_K_M (1 RX + 1 Arc; three instances do not fit) | 7B | 4377 MB | 3.3 | 0.009× |

### A real index

A full `--force` reindex of the TeaRAGs repository (41,990 chunks) from the GPU
host over the LAN:

| Model | Total | Embedding | Enrichment | chunks/s (embedding) |
| --- | ---: | ---: | ---: | ---: |
| jina v2 code | 230 s | 215 s | 14 s | 193 |
| Muninn-small f16 | 115 s | 101 s | 12 s | 417 |

The synthetic 2.37× shows up as 2.2× on embedding throughput in a real run.

## Quality

Dense retrieval. MRR is 0–1; R@k is in percent.

### TeaRAGs (TypeScript, production `src/`)

| Model | MRR | R@1 | R@5 | R@10 |
| --- | ---: | ---: | ---: | ---: |
| jina v2 code f16 | 0.850 | 76.0 | 97.0 | 99.5 |
| CodeRankEmbed Q8_0 | 0.918 | 85.5 | 99.5 | 100 |
| CodeRankEmbed f16 | 0.913 | 84.5 | 99.5 | 100 |
| Muninn-small f16 | 0.889 | 82.5 | 97.0 | 99.0 |
| Muninn-small f16 + card prefixes | 0.852 | 76.5 | 95.0 | 96.5 |
| BGE-Code-v1 Q8_0 | 0.917 | 86.0 | 98.0 | 99.0 |
| BGE-Code-v1 Q8_0 + instruction | 0.950 | 91.5 | 99.5 | 99.5 |

### mastodon (Ruby, production `app/`)

| Model | MRR | R@1 | R@5 | R@10 |
| --- | ---: | ---: | ---: | ---: |
| jina v2 code f16 | 0.832 | 76.5 | 90.5 | 93.5 |
| CodeRankEmbed f16 / Q8_0 | 0.891 / 0.890 | 82.5 | 97.0 | 99.0 / 98.5 |
| Muninn-small f16 | 0.786 | 69.0 | 88.5 | 94.5 |
| Muninn-small + card prefixes | 0.753 | 64.5 | 89.0 | 91.5 |
| BGE-Code-v1 Q8_0 | 0.896 | 83.5 | 98.0 | 98.0 |
| BGE-Code-v1 Q8_0 + instruction | 0.943 | 90.5 | 99.0 | 100 |

### Private Rails app (Ruby, RSpec tests)

Set A: natural-language scenario → the test. Set B: method source → its tests
(recall@10).

| Model | A MRR | A R@1 | A R@10 | B recall@10 |
| --- | ---: | ---: | ---: | ---: |
| jina v2 code f16 | 0.683 | 55.5 | 95.5 | 82.4 |
| jina Q8_0 / Q4_K_M | 0.682 / 0.692 | 55.0 / 56.0 | 95.5 / 95.0 | 82.3 / 83.5 |
| CodeRankEmbed f16 / Q8_0 | 0.865 / 0.870 | 79.0 / 79.5 | 98.5 | 86.2 / 86.5 |
| Muninn-small f16 | 0.765 | 64.0 | 98.0 | 82.1 |
| Muninn-small + card prefixes | 0.805 | 71.0 | 97.5 | 79.6 |
| mxbai-embed-large f16 / Q8_0 | 0.768 / 0.777 | 64.5 / 66.0 | 97.0 | 80.1 / 80.3 |
| jina-code-embeddings-0.5b f16 + prefixes | 0.783 | 68.0 | 98.0 | 88.1 |
| BGE-Code-v1 Q8_0 + instruction | 0.900 | 85.0 | 99.0 | 86.7 |
| Qodo-Embed-1-1.5B Q8_0 + instruction | 0.886 | 82.0 | 100 | 85.9 |
| Nomic Embed Code 7B Q4_K_M + prefix | 0.933 | 89.0 | 99.5 | 88.1 |

Among the models within 0.92–2.37× of jina's speed, CodeRankEmbed is first on
all three corpora: +0.068 MRR over jina on TypeScript, +0.058 on mastodon,
+0.187 on the RSpec corpus.

## Findings

### Query prefixes

Several model cards ask for a query prefix. CodeRankEmbed's prefix changed MRR
by at most ±0.01 on every corpus. Muninn-small's card prefixes moved it by
+0.04 on the RSpec corpus, −0.03 on mastodon and −0.04 on TypeScript — no
consistent gain, so they are not used. TeaRAGs sends no prefixes.

### Quantization

Quantization never sped a model up on this GPU: jina Q8_0 and Q4_K_M ran at
0.96× and 0.84× of f16, Muninn-small Q8_0 at 0.92× of f16, CodeRankEmbed Q8_0
level with f16. Under Vulkan, dequantizing the weights costs more than the
weight reads it saves. Quality did not move either (jina f16 / Q8_0 / Q4_K_M:
0.683 / 0.682 / 0.692 MRR on the RSpec corpus). Quantize only to save disk or
VRAM.

### Decoder embedders inside llama-server

The decoder-based embedders (Qwen2 architecture) run about 4× below their raw
GPU speed inside llama-server. llama-bench `pp512` of jina-code-embeddings-0.5b
reaches 22.5k tokens/s on the RX; the server delivers about 5k tokens/s. The
gap does not depend on the backend (Vulkan or ROCm), the context, the slot
count or a unified KV cache.

### Hybrid search on identifier-free queries

Hybrid (dense fused with BM25) scored far below dense for every model on these
queries — jina on mastodon 0.594 against 0.832, CodeRankEmbed on TypeScript
0.657 against 0.918. This is a property of the benchmark: the queries
deliberately contain no identifiers, so BM25 adds mostly noise. BM25 helped only
set B, where the query is code. Do not read these numbers as a verdict on
hybrid search with real agent queries, which usually do carry identifiers.

## Why strong embedding models pay off little for an LLM agent

The largest models — BGE-Code-v1, Qodo-Embed-1-1.5B, Nomic Embed Code 7B — are
the most accurate in the tables above. For an LLM agent that calls the search,
the evidence says they buy little:

- **R@10 converges.** On TeaRAGs every model reaches 99–100% R@10; on mastodon
  93.5–100%. The difference between models is almost entirely in R@1 — the
  order inside the top 10. An agent reads the whole top-10 page and picks the
  hit itself.
- **The big models' largest gain is the instruction prefix.** BGE-Code-v1 goes
  from 0.917 to 0.950 MRR on TypeScript and from 0.896 to 0.943 on mastodon
  with it. Without it, the 1.5B BGE-Code-v1 ranks like the 137M CodeRankEmbed:
  0.917 against 0.918 on TypeScript, 0.896 against 0.891 on mastodon. An
  instruction is a reformulation of the query — what an agent already does when
  it rewrites a query, retries with other words, or navigates from a hit with
  `find_symbol`, callers or similar-code search.
- **The cost is 15–110× in throughput.** 22, 23 and 3.3 texts/s against
  356–385. A full reindex of a 180k-chunk project would take about 2.3 h with
  BGE-Code-v1 and about 15 h with Nomic Embed Code 7B, against minutes with
  CodeRankEmbed. Their vectors are also 2–4.7× wider (1536–3584 dimensions
  against 768), which costs index size and search latency.

**What we did not measure.** The agent loop itself: how often an agent rewrites
a query, and whether it finishes a task more often with one model than with
another. The argument above rests on R@10 parity and on the instruction effect,
not on an agent benchmark.

## Models not covered

CodeSage-small-v2 could not be measured: it uses a custom architecture with no
GGUF converter, so llama-server cannot run it.

## Related

- [Embedding model choice](/config/embedding-model-choice) — which model to
  pick, how to run it, how to switch.
- [llama-server vs Ollama: measured configurations](/config/providers/llama-server-benchmarks)
  — server layouts and their throughput with the default model.
- [Running llama-server as several processes](/config/providers/llama-server-multi-gpu)
  — instance layouts, Apple Silicon, several models on one host.

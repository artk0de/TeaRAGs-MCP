---
title: Embedding model choice
sidebar_position: 3.5
---

# Embedding model choice

Which embedding model to index a project with. Three models are worth
considering; the [provider](./providers/) decides which of them you can run.

| Model | Role | Provider | Speed vs jina | Dims | Context per slot |
| --- | --- | --- | ---: | ---: | ---: |
| [CodeRankEmbed](#coderankembed) (Q8_0) | Recommended for llama-server | llama-server | 0.93× | 768 | 2048 |
| [jina v2 code](#jina-v2-code) (f16) | Ollama default, the baseline | Ollama, llama-server | 1.00× | 768 | 8192 |
| [Muninn-small](#muninn-small) (f16) | Fast option | llama-server | 2.37× | 384 | 8192 |

Every number on this page comes from
[Embedding model comparison](/knowledge-base/embedding-model-comparison): the
hardware, corpora, query construction, the full tables and the caveats are
there. Speed is texts per second on one GPU host (three llama-server instances
on an RX 7800M plus one on an Arc 140T iGPU); quality is known-item retrieval
MRR over 200 natural-language queries per corpus. Differences below about 0.02
MRR are noise.

## Candidates

### CodeRankEmbed

[`nomic-ai/CodeRankEmbed`](https://huggingface.co/nomic-ai/CodeRankEmbed),
137M parameters. **The recommended model when you run
[llama-server](./providers/llama-server).**

**When to pick it.** Any project you index through llama-server, and Ruby
projects in particular. It was the best of the fast models on all three
corpora we measured.

**Trained languages** (model card): Python, Java, JavaScript, Go, PHP, Ruby
(the CoRNStack dataset). TypeScript is not on the list.

**Measured here** (dense MRR, Q8_0; jina v2 code in brackets):

| Corpus | CodeRankEmbed | jina v2 code |
| --- | ---: | ---: |
| TypeScript, TeaRAGs `src/` | 0.918 | 0.850 |
| Ruby, mastodon `app/` | 0.890 | 0.832 |
| Ruby, private Rails app, RSpec tests | 0.870 | 0.683 |
| Ruby, method source → its specs (recall@10) | 86.5 | 82.4 |

TypeScript works although it is not in the training list. The query prefix
from the model card changed MRR by at most ±0.01 on every corpus; TeaRAGs sends
no prefix.

**Speed.** 359 texts/s against 385 for jina (0.93×). f16 runs at 356 texts/s
with the same quality, so Q8_0 is the smaller file at no cost.

|                       |                                     |
| --------------------- | ----------------------------------- |
| **Dimensions**        | 768                                 |
| **Context per slot**  | 2048 tokens (the model's training context) |
| **License**           | MIT                                 |
| **GGUF**              | 146 MB (Q8_0), 274 MB (f16)         |

**How to run it.** CodeRankEmbed is not in the Ollama library. Take the
community GGUF from
[handwoven8588/CodeRankEmbed-GGUF](https://huggingface.co/handwoven8588/CodeRankEmbed-GGUF),
or convert `nomic-ai/CodeRankEmbed` yourself with llama.cpp's
`convert_hf_to_gguf.py`. Print the launch lines with
`tea-rags llama-server command --model <path to the GGUF on the host>`, then
replace the printed `-c 32768 -b 8192 -ub 8192` with the values for its 2048-token
context — four slots of 2048:

```bash
llama-server -m CodeRankEmbed-Q8_0.gguf --embedding -ngl 999 -fa on \
  -np 4 -c 8192 -b 2048 -ub 2048 --host 0.0.0.0 --port 8081
```

```bash
export EMBEDDING_PROVIDER=llama-server
export EMBEDDING_MODEL=nomic-ai/CodeRankEmbed
export EMBEDDING_BASE_URL=http://192.168.1.71:8081,8082,8083,8084
```

TeaRAGs knows the 768-dimension width from its model table and derives the
chunk size from the 2048-token per-slot window, so chunks are smaller than with
jina. Keep `CodeRankEmbed` in the GGUF file name: the served-model check retires
an endpoint whose file does not look like `EMBEDDING_MODEL`.

### jina v2 code

[`jinaai/jina-embeddings-v2-base-code`](https://huggingface.co/jinaai/jina-embeddings-v2-base-code),
161M parameters, served as `unclemusclez/jina-embeddings-v2-base-code:latest`.
**The default for Ollama and llama-server, and the baseline every other model
here is compared against.**

**When to pick it.** You run [Ollama](./providers/ollama): of the three, it is
the only one in the Ollama library. Also when the project's languages are
outside both other models' training lists.

**Trained languages** (model card): 30 programming languages.

**Measured here** (dense MRR, f16): 0.850 on TypeScript, 0.832 on mastodon,
0.683 on the RSpec corpus, 82.4 recall@10 on method → specs. It is the weakest
of the three on every corpus except mastodon, where Muninn-small is lower.

**Speed.** 385 texts/s on the GPU host — the reference for the 1.00× column.
Q8_0 (370) and Q4_K_M (324) were slower than f16, with the same quality.

|                       |                                    |
| --------------------- | ---------------------------------- |
| **Dimensions**        | 768                                |
| **Context per slot**  | 8192 tokens                        |
| **License**           | Apache-2.0                         |
| **GGUF**              | 323 MB (f16)                       |

**How to run it.** Ollama pulls it on first use. For llama-server,
`tea-rags llama-server command` prints the download and the launch lines with
`-np 4 -c 32768 -b 8192 -ub 8192` as they are; see
[llama-server](./providers/llama-server#setup).

### Muninn-small

[`brokkai/Muninn-small`](https://huggingface.co/brokkai/Muninn-small), 47M
parameters. **The fast option: 2.37× jina's throughput.** TeaRAGs indexes its
own repository with it.

**When to pick it.** TypeScript- or Python-heavy projects without Ruby, a small
GPU host, or when full reindex time matters more than the last points of
ranking quality. A full `--force` reindex of the TeaRAGs repository (41,990
chunks) took 115 s with Muninn-small against 230 s with jina; embedding alone
101 s against 215 s.

**Trained languages** (model card): C, C++, C#, Go, Java, JavaScript,
TypeScript, PHP, Python, Rust, Scala. **No Ruby.**

**Measured here** (dense MRR, f16):

| Corpus | Muninn-small | jina v2 code |
| --- | ---: | ---: |
| TypeScript, TeaRAGs `src/` | 0.889 | 0.850 |
| Ruby, mastodon `app/` | 0.786 | 0.832 |
| Ruby, private Rails app, RSpec tests | 0.765 | 0.683 |
| Ruby, method source → its specs (recall@10) | 82.1 | 82.4 |

Ruby is mixed — better than jina on one corpus, worse on another — so do not
use it for Ruby. The model card's query and document prefixes moved MRR by
+0.04, −0.03 and −0.04 on the three corpora; TeaRAGs sends no prefixes.

**Speed.** 914 texts/s against 385 for jina. Q8_0 was slower (844 texts/s);
use f16.

|                       |                                    |
| --------------------- | ---------------------------------- |
| **Dimensions**        | 384                                |
| **Context per slot**  | 8192 tokens                        |
| **License**           | Apache-2.0                         |
| **GGUF**              | 97 MB (f16)                        |

**How to run it.** There is no public GGUF. Convert it with llama.cpp:

```bash
git clone https://huggingface.co/brokkai/Muninn-small
python llama.cpp/convert_hf_to_gguf.py Muninn-small \
  --outtype f16 --outfile Muninn-small-f16.gguf
```

With an older `transformers` the conversion fails on the tokenizer: the
model's `tokenizer_config.json` declares `"tokenizer_class": "TokenizersBackend"`.
Change it to `"PreTrainedTokenizerFast"` and run the conversion again.

The printed launch lines fit as they are — four slots of 8192:

```bash
llama-server -m Muninn-small-f16.gguf --embedding -ngl 999 -fa on \
  -np 4 -c 32768 -b 8192 -ub 8192 --host 0.0.0.0 --port 8081
```

```bash
export EMBEDDING_PROVIDER=llama-server
export EMBEDDING_MODEL=brokkai/Muninn-small
```

## Decision table

| Project languages | Ollama only | llama-server, GPU host | llama-server, small host or reindex time first |
| --- | --- | --- | --- |
| Ruby, or Ruby mixed with others | jina v2 code | CodeRankEmbed | CodeRankEmbed |
| TypeScript, JavaScript, Python | jina v2 code | CodeRankEmbed | Muninn-small |
| Go, Java, PHP | jina v2 code | CodeRankEmbed (not measured) | Muninn-small (not measured) |
| C, C++, C#, Rust, Scala | jina v2 code | Muninn-small (not measured) | Muninn-small (not measured) |
| Other languages | jina v2 code | jina v2 code (not measured) | jina v2 code (not measured) |

"Not measured" rows follow the training lists on the model cards; we measured
only TypeScript and Ruby.

## Switching models

- **A model switch needs a full `--force` reindex** of the project. The vectors
  change, the width may change (768 → 384 for Muninn-small), and the per-slot
  context changes the chunk size. The collection's embedding model guard
  refuses to mix vectors of two models.
- **One model per llama-server process group.** A llama-server process serves
  the model it loaded. To serve two models on one host, run a separate group of
  instances on its own port range for each; see
  [several models on one host](./providers/llama-server-multi-gpu#several-models-on-one-host).
- **The fallback serves the same model.** `EMBEDDING_FALLBACK_URL` must point at
  a llama-server with the same GGUF as the peers. The
  [served-model check](./providers/llama-server#how-it-works) compares every
  endpoint's GGUF file name with `EMBEDDING_MODEL` and takes an endpoint on
  another model out of the run; when none serving the configured model is left,
  indexing fails with `INFRA_LLAMA_SERVER_MODEL_MISMATCH` instead of writing
  vectors of the wrong model.
- **Current limitation: one model per MCP server configuration.** Search embeds
  queries with the MCP server's `EMBEDDING_MODEL`, not with the model a project
  was indexed with. A project indexed with a different model than the server's
  environment fails with `INFRA_EMBEDDING_MODEL_MISMATCH`. Index all projects
  served by one MCP server configuration with the same model.

## Models we measured and do not recommend

Full numbers are in the [comparison](/knowledge-base/embedding-model-comparison).

- **mxbai-embed-large** — 2.4× slower than jina and a 512-token context; strong
  on natural language, behind CodeRankEmbed on code.
- **jina-code-embeddings-0.5b** — 8.5× slower than jina, and its CC-BY-NC
  license rules out commercial use.
- **BGE-Code-v1, Qodo-Embed-1-1.5B** — 1.5B parameters, 22–23 texts/s (0.06×
  jina); without an instruction prefix BGE-Code-v1 ranks like CodeRankEmbed.
- **Nomic Embed Code** — 7B parameters, 3.3 texts/s (0.009× jina); three
  instances do not fit on a 12 GB GPU.
- **CodeSage-small-v2** — cannot run on llama-server: custom architecture with
  no GGUF converter.

Why the large models buy little for an agent:
[Why strong embedding models pay off little for an LLM agent](/knowledge-base/embedding-model-comparison#why-strong-embedding-models-pay-off-little-for-an-llm-agent).

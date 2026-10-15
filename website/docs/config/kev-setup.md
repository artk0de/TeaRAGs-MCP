---
title: "Kev: Model-Assisted Call Resolution"
sidebar_position: 5
---

# Kev: Model-Assisted Call Resolution

:::caution Experimental
Residual resolution with Kev is experimental. The feature ships — the
`--resolve-residual` flag, the `resolve-codegraph-residual` command and the
`CODEGRAPH_RESIDUAL_*` variables — but flags and defaults may change.
:::

Codegraph resolves most calls statically. Some it cannot: a call whose receiver
type has several candidates (`ambiguous`), or one whose receiver is dynamic — in
Ruby, `target.client_has_read_write_access?` on a parameter could be any class
that defines the method. Static resolution leaves those calls without an edge,
so `get_callers`, `trace_path` and the graph metrics miss them.

Residual resolution asks a model which candidate each such call reaches.
tea-rags sends the enclosing method's source and the candidate menu; the model
picks a class and reports its confidence. Picks at or above the threshold become
call edges marked `origin: "model"`. Every verdict is cached per project, so a
later run only asks about call sites that are new or whose candidates changed.

Use it on Ruby projects (and other dynamic code) where callers of a widely
shared method name matter for review or impact analysis. A static-only graph
stays correct without it; residual resolution adds recall.

The first supported model is **Kev** (`jaredpalmer/kev-4b`), a 4B classifier on a
Qwen3.5 hybrid backbone (Gated DeltaNet + attention), served over HTTP. tea-rags
ships no Kev launcher: install and run Kev separately on a GPU host, then point
tea-rags at its URL. Everything runs locally; no tokens leave your network.

## Performance

Measured on the [reference host](#reference-host-windows-11--rocm): one AMD
Radeon RX 7800M (12 GB, eGPU over Thunderbolt, Windows 11, ROCm), residual
questions from a large Rails monolith, 48–96 client requests in flight. Other
hardware lands elsewhere; see
[Tuning for other hardware](#tuning-for-other-hardware).

| Serving setup                                                                         | Questions/s | Notes                                            |
| ------------------------------------------------------------------------------------- | ----------- | ------------------------------------------------ |
| Kev's stock server, fp32 load straight to the GPU                                     | 1.0–1.9     | weights spilled to system memory                 |
| Load on the host, bf16, small CUDA-graph buffers                                      | 8.5–13      | embedding servers sharing the GPU cost ~35%      |
| GPU to Kev alone, token-embedding table in host memory                                | 13.3        | +43% over the same setup with the table in VRAM  |
| **Packed fixed-size passes, shared states, tuned GEMMs** (the setup below)            | **17.2–18** | 17.2 at 48 clients, 18.0 at 96                   |

Every step above keeps Kev's answers: against the stock path, picks agree on
557–559 of 559 questions, and probabilities differ by at most 0.014 (bf16
rounding from different pass shapes). Run-to-run bf16 noise alone reaches
0.0154, so a parity gate against the stock path should allow up to 0.02.

Accuracy on the 91-site Ruby fixture (`tests/fixtures/residual-eval`): **0.934**
overall (85/91), **0.806** where the parameter name does not name the class
(25/31), **1.0** where it does (60/60). The most confident wrong pick had
p = 0.503, so the default threshold of 0.7 keeps every wrong pick out of the
graph: the 70 picks at or above it are all correct. For a sense of scale, Claude Haiku 4.5 scores
0.989 / 0.968 on the same set, but the full residual of a ~30k-file project is
~13k questions and 20–40M input tokens.

A rough budget: ~13k residual questions take 12–13 minutes at 18 questions/s.

## Reference host: Windows 11 + ROCm

Everything in this section is one specific setup: Windows 11, an AMD RDNA3 GPU
(gfx110x, 12 GB) and TheRock's nightly ROCm build of torch. It is the setup the
performance table was measured on, not a generic recipe. The package versions,
the `torch.distributed` shim, the `clang-cl` toolchain and the WDDM memory
behaviour are all specific to Windows + ROCm. On other hardware, read it as a
worked example and take the techniques from
[Tuning for other hardware](#tuning-for-other-hardware).

The serving wrapper in step 3 is a set of runtime patches over `kev.serve`
written for this host. It ships with neither Kev nor tea-rags.

### 1. Kev and its Python stack

```powershell
git clone --depth 1 https://github.com/jaredpalmer/kev.git D:\kev
cd D:\kev
uv sync --extra serve
```

Then replace the torch and kernel stack with versions that run on the GPU:

- **torch**: TheRock nightly `torch 2.9.1+rocm7.13` for gfx110x, plus
  `rocm[devel]` for the ROCm headers and compiler
  (`--index https://rocm.nightlies.amd.com/v2/gfx110X-all/`).
- **triton**: `triton-windows 3.6.0.post26`. Do not use 3.5.x — it fails an
  `isUIntN` assertion on AMD.
- **flash-linear-attention**: `flash-linear-attention==0.5.2` and
  `fla-core==0.5.2` (`--no-deps`). Kev's fused Qwen3.5 kernels pin this version.

**Windows only:** the Windows torch build has no `torch.distributed`, which
flash-linear-attention imports at load time. Put a small shim module in the
virtualenv's `site-packages` with a `.pth` file that imports it; the shim
registers stub `torch.distributed.tensor` / `device_mesh` modules with the few
names the package reads. Single-GPU serving never calls them.

### 2. Toolchain environment

Triton compiles kernels at first use, so the serving process needs a working
`clang-cl` toolchain:

```bat
call "C:\Program Files (x86)\Microsoft Visual Studio\2022\BuildTools\VC\Auxiliary\Build\vcvars64.bat"
set ROCM_HOME=D:\kev\.venv\Lib\site-packages\_rocm_sdk_devel
set PATH=%ROCM_HOME%\lib\llvm\bin;%ROCM_HOME%\bin;%PATH%
set CC=clang-cl
set CXX=clang-cl
set DISTUTILS_USE_SDK=1
```

### 3. Serving wrapper

Kev's stock `kev.serve` is tuned for datacenter GPUs. On a 12 GB consumer card
the wrapper around it decides the throughput. These are the pieces, in the order
they paid off:

1. **Load on the host, then move.** Load the base model, merge the LoRA and cast
   to bf16 in host memory, then move the finished model to the GPU. Loading fp32
   straight onto a 12 GB card peaks above VRAM, and under Windows WDDM part of the
   weights stays in shared system memory for good — read over the link at
   ~4 GB/s instead of ~430 GB/s.
2. **Re-home check.** After loading, time a small GEMM over every large weight.
   One that reads below ~50 GB/s lives in system memory: copy it again into a
   fresh VRAM allocation. With step 1 in place this finds nothing; keep it as a
   guard.
3. **Token-embedding table in host memory.** The input embedding table is
   1.18 GB (248k tokens × 2560) and a pass reads ~5 KB per token of it. Keep it
   pinned in host memory, gather the rows on the CPU and upload `[tokens, 2560]`
   per pass. The values are the same bf16 rows, so outputs are bit-identical; the
   freed VRAM is what keeps everything else on the card (+43%).
4. **Packed fixed-size passes instead of padded buckets.** The stock server pads
   every pass to a shape bucket and captures one CUDA graph per bucket. On mixed
   residual traffic 17–36% of tokens were padding, ~70% of passes never reached a
   captured graph, and the average pass was ~325 tokens — where this GPU runs at
   less than half its rate. Instead, pack questions back to back into passes of
   2048 tokens: Gated DeltaNet layers take the sequence boundaries as
   `cu_seqlens` (flash-linear-attention varlen kernels), attention layers a
   block-diagonal causal mask. Passes fill to ~0.9.
5. **Share a method's state only when it pays.** A question runs as its own
   causal sequence (method slice + question). Requests where sharing saves at
   least 256 tokens (`(questions − 1) × state tokens`) run in two passes instead:
   a packed state pass that keeps each state's final DeltaNet states and attention
   keys/values, then packed question passes that start from them. Each kept
   DeltaNet state costs ~48 MB, so groups are capped at 4 states and question
   passes at 8 sequences — larger groups pushed VRAM over the edge and throughput
   fell 10×.
6. **Tune the GEMMs once, offline.** With fixed pass sizes (512–2048 tokens in
   steps of 512) the backbone has only 24 GEMM shapes. Tune them once with
   PyTorch TunableOp (~3 minutes), write the results to a file, and serve with
   lookups only: 2741 → ~3700 tokens/s per 2048-token pass. Do not enable TunableOp's online
   tuning on a server with variable shapes — every new shape costs 20+ seconds.
7. **AOTriton attention.** Set `TORCH_ROCM_AOTRITON_ENABLE_EXPERIMENTAL=1`. Without
   it, SDPA on RDNA3 falls back to the math path, which collapses above ~2k
   tokens per pass (4.1 s instead of 0.5 s for 2 × 1024 tokens).

The measured ceiling for reference: bf16 GEMM peaks at ~47 TFLOP/s on this card
(~6600 tokens/s for Kev-4B); the packed setup runs at ~3600 tokens/s.

### 4. Share the GPU with embedding servers

Kev needs the whole card. Embedding servers (llama-server, Ollama) on the same
GPU keep 300–550 MB each even when idle, and with six of them Kev lost ~5 GB of
its memory to system RAM. Check it with the Windows GPU counters:

```powershell
(Get-Counter '\GPU Process Memory(*)\Shared Usage').CounterSamples |
  ? { $_.CookedValue -gt 100MB } | % { $_.InstanceName, [int]($_.CookedValue/1MB) }
```

Anything beyond the pinned embedding table (~1.2 GB) in Kev's shared usage means
it is spilling.

Run embeddings and Kev one after the other on the same card: tea-rags runs the
residual pass after embeddings and codegraph enrichment finish, so they never
need the GPU at the same time. The GPU session broker on the Kev host
(kev-rocm-serving `broker/`, port 8008) does the switch: set
`CODEGRAPH_RESIDUAL_KEV_SESSION_URL` and a pass that has questions to ask leases
Kev from it — the broker waits for the embedding servers to go quiet, stops
them, starts Kev, and starts them again when the pass releases the lease. The
lease call blocks about 75 s; the progress line reads "acquiring GPU session".
A pass answered entirely from cached verdicts never takes the GPU.

- **Busy broker.** Another lease, a switch in progress, or an embedding run
  still in flight on the card ends the pass `skipped` with the broker's reason
  (`gpu-session-busy: …` / `gpu-session-unavailable: …`); indexing still
  succeeds and the cached verdicts are applied.
- **Other indexing runs.** An index run started while Kev holds the card gets
  connection errors from those embedders; its retry and `EMBEDDING_FALLBACK_URL`
  path applies.
- **Interrupted pass.** The lease is released on completion, on failure and on
  Ctrl-C / SIGTERM. A killed process stops heartbeating, and the broker expires
  the lease after its ttl (120 s) and restores the embedders.

Without the broker, switch by hand: stop the embedding servers on the Kev GPU
(and their supervisor, or it restarts them), start Kev, and after the pass stop
Kev and start the embedding servers again. Servers on a second GPU (an
integrated Intel Arc, for instance) can keep running.

## Tuning for other hardware

Kev-4B is ~7.9 GB of bf16 weights, and the work is a prefill of a few hundred
tokens per question with no generation. Throughput comes down to two things:
whether everything stays in VRAM, and how full each pass is. The techniques from
the reference host, sorted by how far they carry:

| Technique | Where it applies | Notes |
| --- | --- | --- |
| Packed fixed-size passes (`cu_seqlens` varlen) | Any GPU that runs flash-linear-attention's Triton kernels (CUDA, ROCm) | The largest win on mixed residual traffic; independent of vendor |
| Shared method state, gated by tokens saved | Same | Size the group cap to free VRAM: ~48 MB per kept DeltaNet state |
| Offline GEMM tuning (TunableOp) over the fixed pass sizes | ROCm (hipBLASLt) — +35% here; CUDA (cuBLASLt) supported | Expect a smaller gain on NVIDIA, where default heuristics are better tuned |
| Concurrency 96 instead of 48 | Any | More questions waiting means fuller passes |
| Token-embedding table in host memory | GPUs with less than ~16 GB | On 24 GB and up, keep it in VRAM and skip the per-pass upload |
| Load on the host, re-home check, shared-memory diagnostic | Windows (WDDM) only | Linux has no silent spill to system memory; an overcommitted card fails with an out-of-memory error instead |
| `TORCH_ROCM_AOTRITON_ENABLE_EXPERIMENTAL=1` | ROCm on consumer RDNA | CUDA and datacenter AMD GPUs have flash attention in SDPA already |
| `torch.distributed` shim, `clang-cl` toolchain | Windows only | Linux torch builds ship `torch.distributed`, and Triton uses the system compiler |

Per platform:

- **NVIDIA (CUDA), Linux or Windows.** Closest to what Kev's stock server was
  built for. Start with the stock server; add packing and shared states if the
  traffic is mixed. CUDA graphs pay off more there than on AMD, where they gave
  ~2% and cannot be reused across packed layouts.
- **AMD on Linux (ROCm).** Use the official ROCm torch wheels; no shim, no
  `clang-cl`. Everything from step 3 except items 1–2 applies.
- **24 GB or more.** Keep the embedding table on the GPU and raise the
  state-group cap. 4096-token passes were slower on the reference host
  (0.917x of the 2048 rate), so measure before moving off 2048.
- **Less than 10 GB.** The bf16 weights alone do not fit. Weight-only int8
  quantization would halve them, but Kev's accuracy under int8 is unmeasured —
  run the [accuracy check](#check-accuracy) before using it. On
  `torch 2.9.1+rocm7.13` for gfx110x, `torch._int_mm` crashes, so int8 matmul
  is not available there.
- **Integrated GPUs sharing system memory** (Intel Arc 140T measured). No help:
  their memory bandwidth is a fraction of a discrete card's, and moving the
  embedding table or the embedding servers there was slower overall.
- **Apple Silicon (MPS).** Untested. flash-linear-attention's Triton kernels do
  not run on MPS, so the DeltaNet layers fall back to a much slower path.
- **Several hosts.** Put every Kev URL in `CODEGRAPH_RESIDUAL_KEV_URL`,
  comma-separated; tea-rags spreads the requests across them.

What did not pay on the reference host: online TunableOp (each new shape stalls
serving for 20+ seconds), larger CUDA-graph buffers on a 12 GB card (they spilled
to system memory), and smaller 512-token buckets (more padding, not less).

## API tea-rags uses

- `GET /v1/models` — health check; `models[0].run` is the model revision
  (`jaredpalmer/kev-4b@v1.0`). A new revision invalidates cached verdicts.
- `POST /v1/systemone` — one request per enclosing method, one `choice` question
  per call site.

## Configure tea-rags

| Variable                                    | Default | Meaning                                                    |
| ------------------------------------------- | ------- | ---------------------------------------------------------- |
| `CODEGRAPH_RESIDUAL_KEV_URL`                | —       | Kev base URL; comma-separate several hosts for round-robin |
| `CODEGRAPH_RESIDUAL_KEV_THRESHOLD`          | `0.7`   | Minimum confidence for a pick to become an edge            |
| `CODEGRAPH_RESIDUAL_CONCURRENCY`            | `16`    | Requests in flight (one per method); Kev packs a few states per pass, so more only queue |
| `CODEGRAPH_RESIDUAL_MENU_LIMIT`             | `40`    | Call sites with more candidates are not asked              |
| `CODEGRAPH_RESIDUAL_MIN_MENU`               | `4`     | Call sites with fewer candidates are neither asked nor given an edge, even from a stored verdict |
| `CODEGRAPH_RESIDUAL_VERDICT_RETENTION_DAYS` | `180`   | Cached verdicts unseen this long are dropped               |
| `CODEGRAPH_RESIDUAL_KEV_SESSION_URL`        | —       | GPU session broker; set, Kev is leased per pass and asked at the URL the lease names (`CODEGRAPH_RESIDUAL_KEV_URL` is then not needed) |
| `CODEGRAPH_RESIDUAL_KEV_SESSION_TOKEN`      | —       | Broker `X-Broker-Token`; a secret, never stored with the project |

Codegraph must be on (it is by default; `CODEGRAPH_ENABLED=false` turns it
off, and the residual pass then does nothing).

Store the URL with the project so every run picks it up:

```bash
tea-rags projects set-env --name my-app CODEGRAPH_RESIDUAL_KEV_URL=http://gpu-host:8009
```

## Run it

During indexing — the pass runs after embeddings and codegraph enrichment have
finished:

```bash
tea-rags index-codebase --project my-app --resolve-residual kev
```

Without the flag, an index run asks nothing. If the project already has a verdict
file, the run re-applies the stored verdicts with no model call (`cacheOnly`), so
model edges survive a reindex. With codegraph off the run does no residual work.

Against the current index, without reindexing:

```bash
tea-rags resolve-codegraph-residual --model kev --project my-app
```

Add `--cache-only` to re-apply stored verdicts without contacting Kev, and
`--json` to print the report as JSON. The command prints a report: call sites
found, menu overflow, menu too small, cache hits, groups, asked, answered, too
long, failed groups, below threshold, sites edged, edges applied, the state of the
derived metrics, and timings. It exits 0 when the pass completed and 1 when it
was skipped.

`sites edged` counts call sites whose pick reached the threshold; `edges applied`
counts the distinct edges stored, so two sites making the same call to the same
method in one method body count once. When the stored model edges changed, the
pass recomputes cycles and PageRank before it returns (`derived metrics:
recomputed`); a failed recompute leaves them marked stale (`stale`) and the next
index run recomputes them.

Small menus are skipped on purpose. On a 1–3 entry menu the true target is
usually a framework or gem method the graph does not hold, and Kev's
probability, normalised over the menu, is close to 1.0 whatever it picks.

A method whose source is too long for Kev (the server answers HTTP 422) is not an
error: its sites are counted under `too long` and left without an edge.

If Kev is unreachable, the pass ends `skipped` with the reason and indexing
still succeeds. The graph keeps its static edges. An interrupted pass resumes on
the next run: verdicts are stored as each method's answer arrives.

Verdicts live in `<data dir>/residual-verdicts/<collection>.duckdb`. They
survive `--force` and `--force-enrichments` and are removed with the project's
index.

## Check accuracy

The repository carries a 91-site Ruby fixture with known answers. Run it against
your Kev host before trusting a new model revision:

```bash
npx tsx scripts/residual-eval.ts --kev-url http://gpu-host:8009 \
  --sites tests/fixtures/residual-eval/sites40.jsonl --gate
```

It prints accuracy overall, on sites where the parameter name does not name the
class (naming-miss), and where it does (naming-hit), plus coverage and precision
at confidence 0.5, 0.7 and 0.9. With `--gate` it exits non-zero below the
baseline: 0.93 overall, 0.80 naming-miss. `--kev-url` takes several
comma-separated hosts; `--concurrency <n>` sets the requests in flight.

## Model edges in the graph

`get_callers` and `get_callees` mark an edge that came from a verdict with
`origin: "model"`, plus `model` (for example `kev`) and `p`, the model's
confidence. Static edges carry no `origin`. Treat a model edge as probabilistic,
not as compiler truth: `p` is at or above the confidence threshold. `trace_path`
steps do not carry `origin` yet.

# llama-server embedding provider — design

Date: 2026-10-03 · Status: approved in chat, pending spec review · Beads: epic
TBD (filed with the plan), measurements in `tea-rags-mcp-h6tmp`.

## Why

Ollama 0.35 runs embedding models through its own bundled `llama-server` with
`-np 1`, one batch per GPU pass. Batches above ~64 texts got slower and started
failing in recent releases. Measured on the nucbox host (RX 7800M, 1024 taxdome
chunks, 687k chars, `/v1/embeddings`):

| Server                                      | texts/s | vs Ollama |
| ------------------------------------------- | ------- | --------- |
| Ollama 0.35 (batch 64, conc 2)              | 99      | 1.00×     |
| llama-server ROCm `-np 4`                   | 191     | 1.92×     |
| llama-server Vulkan RX 7800M `-np 4 -fa on` | 218     | 2.20×     |
| llama-server Vulkan Arc 140T iGPU `-np 4`   | 48      | 0.48×     |

On an M3 Pro, standalone llama-server with `-np 2..4` gave +14–17% over `-np 1`.
Its embeddings match Ollama's exactly (cosine 1.00000, same GGUF blob). A
standalone llama-server per GPU, driven by a client that keeps every slot busy,
is roughly twice as fast as Ollama on the same hardware.

Ollama stays the default provider because it is simpler to set up. llama-server
becomes the recommended provider for large projects (3M+ indexed lines).

## Scope

1. `llama-server` embedding provider.
2. A peer-endpoint pool with fallback, failover and failback.
3. Throughput-weighted batch fan-out across peers inside the provider. The
   pipeline does not change.
4. The throughput tuner probes concurrency instead of hard-coding loopback = 1.
5. Model provisioning: Ollama auto-pull; GGUF fetch for llama-server.
6. `tea-rags llama-server serve` on the GPU host: detect devices, run one tuned
   instance per GPU, optionally install an autostart service.
7. Docs: provider page, multi-GPU deployment guide, 3M+ LOC recommendation,
   comparison of embedding models and the providers that serve them.
8. `tea-rags-setup` plugin: the setup flow can choose llama-server and tune its
   flags.

Out of scope:

- Migrating `OllamaEmbeddings` onto the new endpoint pool. `ollama.ts` is the
  hotspot of the area (bugFixRate 56%, 45 commits), so the migration gets its
  own bead.
- Quantized-model quality and other-model retrieval benchmarks, tracked in
  h6tmp.

## 1. Provider: `LlamaServerEmbeddings`

Location: `src/core/adapters/embeddings/llama-server/`. Selected with
`EMBEDDING_PROVIDER=llama-server`.

- Embeds through `POST /v1/embeddings` with `{ input: string[] }` and reads
  `data[i].embedding` in `index` order. When `model` is configured it is sent
  too; llama-server ignores it and the mock server in tests checks it.
- `/health` is the liveness probe. `/props` gives
  `default_generation_settings.n_ctx`, `total_slots` and `model_path`.
  `resolveModelInfo()` derives the context length and dimensions from them and
  from the dimension registry, falling back to a single probe embed.
- Implements the full `EmbeddingProvider` contract: `getBaseUrl`,
  `getPrimaryBaseUrl`, `getFallbackBaseUrl`, `checkHealth`,
  `checkPrimaryHealth`, `checkFallbackHealth`, and `observeServerBatchFailures`,
  which feeds the tuner's sticky downshift. The provider never keeps a run-long
  batch ceiling of its own.
- Error classification reuses `adapters/embeddings/errors.ts`. A size failure
  (HTTP 500 with "input is too large" / context overflow, or an aborted socket
  on an oversized batch) is a server batch failure, retried in halves. It is
  never an endpoint failure.
- Model check at startup: if `/props.model_path` exists and its file name does
  not match the configured model's GGUF digest or name, the provider logs a
  warning. The warning names the remedy:
  `tea-rags llama-server fetch-model <model>` plus the `serve` command. It does
  not refuse, because a renamed GGUF of the same model is legitimate. Dimension
  mismatch against the collection is already caught by the existing model-mixing
  guard.

## 2. `EmbeddingEndpointPool`

Location: `src/core/adapters/embeddings/endpoint-pool.ts`. It is
provider-agnostic, and Ollama will move onto it later.

- Config: `EMBEDDING_BASE_URL` is a comma-separated list of PEER endpoints
  serving the same model, for example `http://gpu:8081,http://gpu:8082`.
  `EMBEDDING_FALLBACK_URL` is a single URL or a comma-separated list of FALLBACK
  endpoints. A single URL behaves exactly as today. No new env variables are
  needed for endpoints.
- Endpoint state: `healthy | failed`, consecutive-failure counter, and an EWMA
  throughput in chars/s.
- Failover: an endpoint fails after
  `EMBEDDING_TUNE_FAILOVER_CONSECUTIVE_FAILURES` consecutive endpoint failures,
  or immediately on a refused connection. The rule is the same as Ollama's. When
  every peer has failed, the pool serves from the fallback set.
- Failback: a background probe, using the same probe interval as Ollama,
  re-admits a failed peer on `/health` OK. Once any peer is healthy again, the
  fallback set is left.
- `getBaseUrl()` returns the first healthy peer (or fallback), so infraHealth
  and the tuner keep a single active identity. `getPrimaryBaseUrl()` returns the
  configured peer list joined with commas.
- `unavailableRetryMaxWaitMs` applies when NO endpoint is healthy: the pool
  waits and backs off instead of aborting a long index.

## 3. Fan-out inside `embedBatch`

`embedBatch(texts)` splits one pipeline batch across the healthy endpoints of
the active set (peers, or fallbacks during failover):

1. Weight per endpoint = EWMA chars/s. An endpoint with no measurement yet gets
   the mean of the measured ones, or 1 when none is measured.
2. Texts are assigned contiguously by cumulative character share, so every
   endpoint's sub-batch finishes at about the same time. Order is preserved:
   results are reassembled by original index.
3. Each endpoint's share is cut again into `slots` sub-requests, where `slots`
   is `/props.total_slots`, default 1. All sub-requests are sent in parallel.
   This keeps every `-np` slot busy without raising pipeline concurrency.
4. When a sub-request hits an endpoint failure, that endpoint is marked and its
   texts are re-split across the remaining healthy endpoints in the same call.
   The pipeline only sees a failure when no endpoint is left and the unavailable
   wait has run out.
5. Each sub-request updates its endpoint's EWMA (α = 0.3) from its own chars and
   duration.

The pipeline still forms batches and the tuner still owns the batch size. A
batch of 256 across two GPUs with `-np 4` becomes 8 parallel requests of about
32 texts.

## 4. Tuner: concurrency hill-climb

`EmbeddingThroughputTuner` stops deciding concurrency from locality:

- Start: seed from the stored optimum for the endpoint, else
  `INGEST_PIPELINE_CONCURRENCY`, clamped to `[1, INGEST_PIPELINE_CONCURRENCY]`.
- After the batch size settles, probe concurrency ×½ and ×2 within the bounds
  over `samplesPerSize` FULL-batch windows. Measure aggregate chars/s, which is
  total input chars over wall time across in-flight batches, and not per-call
  rate. Accept a move at a ≥5% gain, otherwise settle. Re-probe together with
  the batch size.
- Persist `{ batchSize, concurrency }` per endpoint and model in
  `CollectionEntry.embeddingThroughputOptima`. The field is additive, and older
  entries without `concurrency` seed from config.
- `EMBEDDING_TUNE_STATIC` still pins both values.
- Adaptation reasons: replace `endpoint-local` / `endpoint-remote` with
  `concurrency-probe` / `concurrency-settle` / `seed`.

Ollama on loopback converges to 1 by measurement, as the M3 Pro tests showed.
llama-server with `-np 4` converges higher.

## 5. Model provisioning

- Ollama: on `checkHealth`/startup, when `/api/show` reports the model missing,
  run `/api/pull` with progress logged, then continue. Opt out with
  `EMBEDDING_AUTO_PULL=false`, default true.
- llama-server: `tea-rags llama-server fetch-model [model]` resolves an Ollama
  registry reference (default: the configured model,
  `unclemusclez/jina-embeddings-v2-base-code:latest`). It reads the manifest
  from `https://registry.ollama.ai/v2/<name>/manifests/<tag>`, downloads the
  `application/vnd.ollama.image.model` layer blob, verifies sha256, and stores
  it as `~/.tea-rags/models/gguf/<name>@<tag>.gguf`. A file already present with
  a matching digest is a no-op. Any model in the Ollama library works, not only
  jina.

## 6. `tea-rags llama-server serve` (GPU host)

Runs where the GPUs are (requires Node + `npm i -g tea-rags`).

- Locates `llama-server` from `--bin`, `LLAMA_SERVER_BIN`, or PATH. It does not
  download binaries, because platform and backend choice (Vulkan / ROCm / CUDA /
  Metal) belong to the operator.
- `--list-devices` parsing gives one instance per discrete or integrated GPU
  (`--device <id>`). `--devices` selects a subset.
- Flags per instance:
  `--embedding -ngl 999 -fa on -np <slots> -c <slots*8192> -b 8192 -ub 8192 --host <bind> --port <base+i>`.
  The default `slots` is 4, from the measured optimum on RX 7800M and M3 Pro.
  Override with `--slots`.
- Supervises the children and restarts them on exit with backoff. It prints the
  `EMBEDDING_BASE_URL` value to use, the comma-joined endpoint list.
- `--install-service` writes and enables an autostart unit that runs `serve`:
  Windows Task Scheduler (at startup, highest privileges, restart on failure),
  Linux systemd user unit, or macOS launchd agent. `--uninstall-service` removes
  it.
- `--bench` runs a short throughput sweep (`-np` 1/2/4/8) per device and writes
  the best slots to the service config. This is the "tea-rags picks optimal
  settings" requirement.

## 7. Documentation (website/docs)

- `config/providers/llama-server.md`: setup, env, peer list and fallback,
  fan-out, measured numbers, troubleshooting (Windows Smart App Control blocks
  unsigned llama.cpp builds, incomplete ROCm builds without `hipblas.dll`, host
  sleep).
- `config/providers/index.md`: provider matrix plus the **embedding model
  comparison**: model, providers that serve it, dimensions, context window,
  code-specialised or general, and notes. Data comes from the model cards plus
  our own retrieval numbers where measured.
- Multi-GPU deployment guide: one instance per device, `serve`,
  `--install-service`, client config, and how fan-out weights uneven GPUs.
- 3M+ LOC recommendation: in the provider index, performance tuning, and the
  large-project sections. Ollama remains the default everywhere.
- Performance tuning: concurrency is now measured, not derived from locality.

## 8. tea-rags-setup plugin

- `install` skill: provider choice adds llama-server, recommended when the
  project is ≥3M lines. It runs `fetch-model` and prints the `serve` command for
  the GPU host.
- `tune` skill: for llama-server, runs `tea-rags llama-server serve --bench` on
  the host, or locally, and records the endpoint list.

## Testing

- Unit tests for the pool: failover after N failures, refused connection,
  failback via probe, fallback set used only when all peers have failed,
  unavailable wait.
- Unit tests for fan-out: weight split by chars, order preservation, slot
  sub-split, mid-call endpoint loss re-split, EWMA update. These use a fake
  fetch with per-endpoint rates.
- Provider tests against a mock `/v1/embeddings` + `/props` + `/health` server:
  size failure gives halves plus an observer event, plus the model check
  warning.
- Tuner tests: concurrency climb converges to the fake server's optimum, seeds
  from the stored optimum, static pin.
- CLI tests for `fetch-model` (mock registry, digest mismatch rejected) and for
  `serve` (device parsing, flag building, service file rendering per OS),
  without spawning real binaries.
- Live (user-gated): taxdome `--force` with llama-server on nucbox, compared
  with the 7600 s localhost run and with an Ollama run on the same host.

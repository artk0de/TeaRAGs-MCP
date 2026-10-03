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
6. `tea-rags llama-server command`: prints the tuned launch command per GPU and
   the OS autostart command for one llama-server build. tea-rags never launches
   or supervises the server.
7. Docs: provider page, multi-GPU deployment guide, 3M+ LOC recommendation,
   comparison of embedding models and the providers that serve them.
8. `tea-rags-setup` plugin: the setup flow can choose llama-server and tune its
   flags.

Out of scope:

- Migrating `OllamaEmbeddings` onto the new endpoint pool. `ollama.ts` is the
  hotspot of the area (bugFixRate 56%, 45 commits), so the migration gets its
  own bead.
- Quantized-model quality and the mxbai-embed-large vs jina speed/quality
  benchmark, tracked in h6tmp.
- Launching, supervising or installing llama-server. tea-rags only prints the
  commands (§6).

## 1. Provider: `LlamaServerEmbeddings`

Location: `src/core/adapters/embeddings/llama-server/`. Selected with
`EMBEDDING_PROVIDER=llama-server`.

- Primary deployment target is a REMOTE GPU host on the LAN. Localhost is the
  fallback tier (§2), not the main case.
- When `EMBEDDING_API_KEY` is set, it is sent as `Authorization: Bearer <key>`
  to every endpoint. This matches llama-server `--api-key`, which a server bound
  to the LAN should use.
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
  `tea-rags llama-server fetch-model <model>` plus
  `tea-rags llama-server command`. It does not refuse, because a renamed GGUF of
  the same model is legitimate. Dimension mismatch against the collection is
  already caught by the existing model-mixing guard.

## 2. `EmbeddingEndpointPool`

Location: `src/core/adapters/embeddings/endpoint-pool.ts`. It is
provider-agnostic, and Ollama will move onto it later.

- Config: `EMBEDDING_BASE_URL` is a comma-separated list of PEER endpoints
  serving the same model, for example `http://gpu:8081,http://gpu:8082`.
  `EMBEDDING_FALLBACK_URL` is a single URL or a comma-separated list of FALLBACK
  endpoints. A single URL behaves exactly as today. No new env variables are
  needed for endpoints.
- Topology: the PEERS are remote llama-server instances, one per GPU on the GPU
  host. The FALLBACK is a llama-server on the client machine,
  `http://127.0.0.1:<port>`, serving the SAME GGUF from `fetch-model`. Every
  endpoint in the pool is llama-server; Ollama is never a fallback for this
  provider, because Ollama may not serve the model chosen for llama-server. The
  fallback list may also hold another remote host.
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

- Bounds: the climb runs inside `[1, ceiling]`. An explicit
  `INGEST_PIPELINE_CONCURRENCY` (either spelling, even `1`) is the hard ceiling.
  Unset, the ceiling is `IMPLICIT_EMBEDDING_CONCURRENCY_CEILING` (8), while
  every other consumer of the value — the worker pool's initial size, the upsert
  queue bound, sync concurrency, `EMBEDDING_TUNE_STATIC` — stays at 1. Config
  parsing marks the explicit case with `flags.userSetPipelineConcurrency`; a
  registry pin replays as explicit, and an unset run pins nothing.
- Start: seed from the stored optimum for the endpoint, clamped to
  `[1, ceiling]`, else the explicit `INGEST_PIPELINE_CONCURRENCY`, or 1 when it
  is unset.
- After the batch size settles, probe concurrency ×½ and ×2 within the bounds
  over `samplesPerSize` FULL-batch windows. Measure aggregate chars/s, which is
  total input chars over wall time across in-flight batches, and not per-call
  rate. Accept a move at a ≥5% gain, otherwise settle. Re-probe together with
  the batch size.
- Persist `{ batchSize, concurrency }` per endpoint and model in
  `CollectionEntry.embeddingThroughputOptima`. The field is additive, and older
  entries without `concurrency` seed from config.
- `EMBEDDING_TUNE_STATIC` still pins both values (concurrency 1 when unset).
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

## 6. `tea-rags llama-server command` (commands only)

Different GPUs need different llama-server builds (ROCm for AMD, Vulkan for an
Intel iGPU, CUDA for NVIDIA, Metal on macOS), so one supervisor that runs a
single binary across every device is the wrong model. tea-rags prints commands;
the operator runs them, once per build.

- `tea-rags llama-server command --bin <path> [--device <id>...] [--port <n>] [--slots <n>] [--host <addr>] [--model <gguf>]`
  starts NO process: it never runs the binary, not even `--list-devices`. It
  prints one launch line per `--device` given:
  `<bin> -m <gguf> --embedding -ngl 999 -fa on -np <slots> -c <slots*8192> -b 8192 -ub 8192 --device <id> --host <host> --port <port+i>`.
  Without `--device` it prints a single all-default launch line and the hint
  `<bin> --list-devices`, so the operator can pick device ids and re-run.
  `--slots` defaults to 4, the measured optimum on RX 7800M and M3 Pro.
  `--model` defaults to the GGUF from `fetch-model`.
- The commands target the REMOTE GPU host, so `--os windows|linux|macos`
  (default: the current platform) selects path syntax, shell and autostart
  flavour. The output is copy-paste ready for that OS.
- Model on the remote host: the first printed step downloads the GGUF straight
  from the Ollama registry blob URL and verifies its sha256. On Windows this is
  PowerShell `Invoke-WebRequest` + `Get-FileHash`; on Linux and macOS it is
  `curl -L` + `sha256sum` / `shasum -a 256`. The GPU host needs no Node and no
  tea-rags. tea-rags resolves the manifest itself, so the printed URL and digest
  are exact. `fetch-model` stays the local equivalent for the fallback tier.
- LAN exposure: `--host` defaults to `0.0.0.0`. `--advertise <lan-ip-or-name>`
  is the address the client uses and goes into the printed `EMBEDDING_BASE_URL`.
  `--api-key <key>` is added to every launch line and printed as
  `EMBEDDING_API_KEY` for the client.
- Host hygiene printed alongside: an inbound firewall rule for the port range
  (`netsh advfirewall firewall add rule` / `ufw allow`), and keeping the host
  awake while serving (`powercfg /change standby-timeout-ac 0`, a
  `systemd-inhibit` wrapper, or `caffeinate -s`). A sleeping GPU host is the
  failure we hit on 2026-10-02.
- Fallback tier:
  `tea-rags llama-server command --os macos --host 127.0.0.1 --bin <local llama-server>`
  prints the local launch line. Its URL goes into `EMBEDDING_FALLBACK_URL`.
- With `--autostart`, it also prints the command that registers that line to
  start at boot: `schtasks /Create … /SC ONSTART /RL HIGHEST` on Windows, a
  systemd user unit plus `systemctl --user enable --now` on Linux, or a launchd
  plist plus `launchctl bootstrap` on macOS. It prints and does not execute.
- It ends with the `EMBEDDING_BASE_URL` value for the client: the comma-joined
  endpoint list across everything printed.
- Run it once per build, for example the ROCm build for the RX 7800M and the
  Vulkan build for the Arc iGPU. Then join the two endpoint lists by hand. The
  docs show this exact case.

## 7. Documentation (website/docs)

- `config/providers/llama-server.md`: setup, env, peer list and fallback,
  fan-out, measured numbers, troubleshooting (Windows Smart App Control blocks
  unsigned llama.cpp builds, incomplete ROCm builds without `hipblas.dll`, host
  sleep).
- `config/providers/index.md`: provider matrix plus the **embedding model
  comparison**: model, providers that serve it, dimensions, context window,
  code-specialised or general, and notes. Data comes from the model cards plus
  our own retrieval numbers where measured.
- Multi-GPU deployment guide: one instance per device, possibly from different
  builds; `llama-server command --autostart` per build; client config; and how
  fan-out weights uneven GPUs.
- 3M+ LOC recommendation: in the provider index, performance tuning, and the
  large-project sections. Ollama remains the default everywhere.
- Performance tuning: concurrency is now measured, not derived from locality.

## 8. tea-rags-setup plugin

- `install` skill: provider choice adds llama-server, recommended when the
  project is ≥3M lines. It runs `fetch-model` and `llama-server command` for the
  GPU host and hands the operator the printed commands.
- `tune` skill: for llama-server, benchmarks `-np` 1/2/4/8 on the running
  instances and re-prints the commands with the best `--slots`. Client-side
  concurrency is left to the tuner (§4).

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
  `command` (flag building per device, the no-device hint, autostart command
  rendering per OS). The command must spawn nothing: assert no child process.
- Live (user-gated): taxdome `--force` with llama-server on nucbox, compared
  with the 7600 s localhost run and with an Ollama run on the same host.

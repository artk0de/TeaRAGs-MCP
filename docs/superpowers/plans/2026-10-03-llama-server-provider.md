# llama-server Embedding Provider Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use dinopowers:executing-plans
> (wraps superpowers:executing-plans) or superpowers:subagent-driven-development
> to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for
> tracking. TDD is mandatory: write the failing test, watch it fail, then
> implement.

**Goal:** Add an `EMBEDDING_PROVIDER=llama-server` provider for remote GPU
hosts. It fans each batch out across one llama-server per GPU, weighted by
measured throughput, and falls back to a local llama-server. Alongside it come a
measured tuner concurrency, model provisioning, print-only deployment commands,
docs, and setup-plugin support.

**Architecture:** A provider-agnostic `EmbeddingEndpointPool` owns peer and
fallback endpoint health. A pure `splitEmbeddingBatchAcrossEndpoints` decides
the per-endpoint and per-slot split. `LlamaServerEmbeddings` composes the two
behind the existing `EmbeddingProvider` contract, so the ingest pipeline does
not change. The throughput tuner hill-climbs concurrency instead of deriving it
from locality. CLI commands only PRINT what an operator runs on the GPU host.

**Tech Stack:** TypeScript (ESM, Node 24), vitest, yargs (CLI), zod (config
schema).

**Spec:** `docs/superpowers/specs/2026-10-03-llama-server-provider-design.md`

## Global Constraints

- Ollama remains the default provider: `schemas.ts` default stays `"ollama"`.
- Do NOT modify `src/core/domains/ingest/pipeline/chunk-pipeline.ts`
  (transitiveImpact 70). Tuner decisions already reach it through
  `ChunkPipeline#applyThroughputDecision`.
- `src/core/adapters/embeddings/errors.ts` is a hub (fanIn 8): additions only,
  with no change to existing exports or signatures.
- `src/core/adapters/embeddings/ollama.ts` is the area hotspot (bugFixRate 56%).
  Touch it ONLY in Task 5 (auto-pull), minimally.
- `EMBEDDING_BASE_URL` / `EMBEDDING_FALLBACK_URL` accept comma-separated lists.
  A single URL must behave exactly as before for every provider.
- The llama-server fallback tier is a LOCAL llama-server, never Ollama.
- `tea-rags llama-server command` spawns NO process. It prints only.
- Naming rule (`.claude/rules/naming.md`): exported names are domain-qualified
  (`EmbeddingEndpointPool`, not `EndpointPool`).
- Commit format: `type(scope): subject`, header ≤100 chars. Scopes: `embedding`
  (provider/pool), `pipeline` (tuner), `config`, `cli`, `website` (docs), plugin
  changes use `dx`-style `chore(plugin)` per repo history. End every message
  with `Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>`.
- Agent worktrees: run `npx husky` once before the first commit so hooks run.
  Never `--no-verify`.
- Per-task gate: targeted vitest files + `npx tsc --noEmit` +
  `npx eslint <changed files>`. The full `npm run test:coverage` runs ONCE on
  main after merge (epic-completion-gate).

## File Structure

| File                                                                | Responsibility                                                                                 |
| ------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| `src/core/adapters/embeddings/endpoint-pool.ts` (new)               | Peer/fallback endpoint health, failover, failback probe, EWMA throughput per endpoint          |
| `src/core/adapters/embeddings/batch-fanout.ts` (new)                | Pure split of a batch across endpoints by throughput share, then by slots; order-preserving    |
| `src/core/adapters/embeddings/llama-server/provider.ts` (new)       | `LlamaServerEmbeddings`: `/v1/embeddings`, `/props`, `/health`, size-failure halving, observer |
| `src/core/adapters/embeddings/llama-server/props.ts` (new)          | Parse `/props` into `{ nCtx, totalSlots, modelPath }`                                          |
| `src/core/adapters/embeddings/factory.ts`                           | `case "llama-server"`                                                                          |
| `src/core/contracts/types/config.ts`                                | provider union + `apiKey?`, `autoPull`                                                         |
| `src/bootstrap/config/{schemas,parse}.ts`                           | enum value, `EMBEDDING_API_KEY`, `EMBEDDING_AUTO_PULL`                                         |
| `src/core/domains/maintenance/registry/env-groups.ts`               | register new env vars                                                                          |
| `src/core/domains/ingest/pipeline/embedding-throughput-tuner.ts`    | concurrency hill-climb                                                                         |
| `src/core/adapters/embeddings/ollama/model-pull.ts` (new)           | `/api/show` → `/api/pull` when missing                                                         |
| `src/core/adapters/embeddings/ollama-registry/gguf-source.ts` (new) | Resolve an Ollama registry reference to `{ blobUrl, sha256, size }`; download + verify         |
| `src/cli/commands/llama-server.ts` (new)                            | `llama-server fetch-model` and `llama-server command` subcommands                              |
| `src/cli/commands/llama-server-command-format.ts` (new)             | Pure renderer of per-OS launch / model-download / autostart / firewall / keep-awake lines      |
| `src/cli/create-cli.ts`                                             | register the command                                                                           |
| `website/docs/config/providers/llama-server.md` (new) + others      | docs (Task 8)                                                                                  |
| `.claude-plugin/tea-rags-setup/skills/{install,tune}/SKILL.md`      | plugin (Task 9)                                                                                |

Tests mirror sources under `tests/core/adapters/embeddings/…`,
`tests/core/domains/ingest/pipeline/…`, `tests/cli/commands/…`.

## Waves

- **Wave A (parallel):** Task 1, Task 2, Task 4, Task 5, Task 6.
- **Wave B (after A):** Task 3 (needs 1+2), Task 7 (needs 6).
- **Wave C (after B):** Task 8, Task 9.

---

### Task 1: `EmbeddingEndpointPool`

**Files:**

- Create: `src/core/adapters/embeddings/endpoint-pool.ts`
- Test: `tests/core/adapters/embeddings/endpoint-pool.test.ts`

**Interfaces — Produces:**

```ts
export type EmbeddingEndpointTier = "peer" | "fallback";
export interface EmbeddingEndpointState {
  url: string;
  tier: EmbeddingEndpointTier;
  healthy: boolean;
  consecutiveFailures: number;
  charsPerSecond?: number; // EWMA
}
export interface EmbeddingEndpointPoolConfig {
  peers: string[];
  fallbacks: string[];
  failoverConsecutiveFailures: number; // 0 disables count-based failover
  probeIntervalMs: number;
  probe: (url: string) => Promise<boolean>; // injected (/health)
  now?: () => number;
  ewmaAlpha?: number; // default 0.3
}
export class EmbeddingEndpointPool {
  constructor(config: EmbeddingEndpointPoolConfig);
  /** Healthy endpoints of the active tier: peers if any healthy, else fallbacks. */
  activeEndpoints(): EmbeddingEndpointState[];
  activeTier(): EmbeddingEndpointTier | undefined; // undefined: none healthy
  primaryUrl(): string; // first healthy active endpoint, else peers[0]
  configuredPeersLabel(): string; // peers.join(",")
  configuredFallbacksLabel(): string | undefined;
  recordSuccess(url: string, chars: number, durationMs: number): void;
  recordEndpointFailure(url: string, kind: "refused" | "transient"): void;
  /** Re-probe failed endpoints; re-admit on probe OK. Called by a timer the provider owns. */
  probeFailed(): Promise<void>;
  checkPeersHealth(): Promise<boolean>;
  checkFallbacksHealth(): Promise<boolean | undefined>;
  snapshot(): EmbeddingEndpointState[];
}
export function parseEmbeddingEndpointList(value: string | undefined): string[]; // split ",", trim, drop empty, strip trailing "/"
```

**Test cases (write first, each its own `it`):**

- [ ] `parseEmbeddingEndpointList`: `"http://a:1, http://b:2/"` →
      `["http://a:1","http://b:2"]`; `undefined` → `[]`; single URL → one
      element.
- [ ] Fresh pool: `activeTier()==="peer"`, `activeEndpoints()` = all peers.
- [ ] `recordEndpointFailure(url,"refused")` marks the endpoint unhealthy
      immediately.
- [ ] `"transient"` failures mark it unhealthy only after
      `failoverConsecutiveFailures`. A success in between resets the counter.
      With `failoverConsecutiveFailures: 0`, transient failures never mark it.
- [ ] All peers unhealthy → `activeTier()==="fallback"`, and `activeEndpoints()`
      returns the healthy fallbacks.
- [ ] All unhealthy, including fallbacks → `activeTier()` is `undefined` and
      `activeEndpoints()` is `[]`.
- [ ] `probeFailed()` with a probe returning true for one peer re-admits it, and
      the active tier flips back to `"peer"`.
- [ ] `recordSuccess` EWMA: the first sample sets the rate; the second gives
      `0.3*new + 0.7*old`.
- [ ] `primaryUrl()` is the first healthy active endpoint, and `peers[0]` when
      none is healthy.
- [ ] Steps: write tests → run
      `npx vitest run tests/core/adapters/embeddings/endpoint-pool.test.ts`
      (FAIL) → implement → PASS → tsc + eslint → commit
      `feat(embedding): endpoint pool with peer/fallback tiers and EWMA throughput`.

### Task 2: `splitEmbeddingBatchAcrossEndpoints`

**Files:**

- Create: `src/core/adapters/embeddings/batch-fanout.ts`
- Test: `tests/core/adapters/embeddings/batch-fanout.test.ts`

**Interfaces — Produces:**

```ts
export interface EmbeddingFanoutEndpoint {
  url: string;
  charsPerSecond?: number;
  slots: number;
}
export interface EmbeddingFanoutRequest {
  url: string;
  indices: number[];
} // indices into texts, ascending
export function splitEmbeddingBatchAcrossEndpoints(
  texts: readonly string[],
  endpoints: readonly EmbeddingFanoutEndpoint[],
): EmbeddingFanoutRequest[];
```

Rules:

1. Weight = `charsPerSecond`. An unmeasured endpoint gets the mean of the
   measured ones, or 1 when none is measured.
2. Contiguous assignment by cumulative CHAR share: endpoint i takes texts until
   its char share ≥ weight_i / Σweights of the total chars. Every endpoint with
   weight > 0 gets ≥1 text while there are texts to give.
3. Each endpoint's run is cut into `min(slots, run.length)` contiguous
   sub-requests of near-equal char size.
4. Union of indices = 0..n-1, no duplicates, each request's indices ascending.
5. Empty texts → `[]`. One endpoint, one slot → one request with all indices.

**Test cases:** rules 1–5 each; two endpoints with rates 220 and 48 on 100 equal
texts → ~82/18 split (±2 texts); slots 4 on 32 texts → 4 requests of 8; uneven
text lengths are split by chars, not count.

- [ ] TDD cycle → commit
      `feat(embedding): throughput-weighted batch fan-out across endpoints and slots`.

### Task 3: `LlamaServerEmbeddings` + wiring

**Files:**

- Create: `src/core/adapters/embeddings/llama-server/provider.ts`,
  `src/core/adapters/embeddings/llama-server/props.ts`
- Modify: `src/core/adapters/embeddings/factory.ts` (new case),
  `src/core/contracts/types/config.ts` (`provider` union adds `"llama-server"`,
  `apiKey?: string`), `src/bootstrap/config/schemas.ts` (enum,
  `EMBEDDING_API_KEY`), `src/bootstrap/config/parse.ts`,
  `src/core/domains/maintenance/registry/env-groups.ts`,
  `src/core/adapters/embeddings/errors.ts` (ADD-only, if a new error class is
  needed)
- Test: `tests/core/adapters/embeddings/llama-server/provider.test.ts`,
  `…/props.test.ts`, `tests/core/adapters/embeddings/factory.test.ts` (add a
  case), the config parse test that covers `EMBEDDING_*` (add cases)

**Interfaces — Consumes:** Task 1 `EmbeddingEndpointPool`,
`parseEmbeddingEndpointList`; Task 2 `splitEmbeddingBatchAcrossEndpoints`.

**Produces:** `class LlamaServerEmbeddings implements EmbeddingProvider`,
constructor
`(model: string, dimensions: number | undefined, rateLimit: RateLimitConfig, baseUrls: string, fallbackUrls?: string, apiKey?: string, deps?: { fetch?: typeof fetch; now?: () => number })`.
`getProviderName()` returns `"llama-server"`.

Behaviour (spec §1–§3):

- `embedBatch`: pool.activeEndpoints() → `/props` slots per endpoint (cached;
  default 1 when `/props` 404) → split (Task 2) → parallel
  `POST <url>/v1/embeddings` `{input, model?}` with Bearer key when set →
  reassemble by index → `pool.recordSuccess` per request.
- Endpoint failure (refused / 5xx not size-related / timeout):
  `pool.recordEndpointFailure`, then re-split ONLY the failed request's texts
  across the remaining active endpoints in the same call. When none is left,
  wait with exponential backoff up to `unavailableRetryMaxWaitMs`, probing via
  `pool.probeFailed()`, then throw the existing unavailable error type from
  `errors.ts`.
- Size failure (HTTP 500 / 400 whose body matches
  `/too large|exceeds|context|n_ubatch|batch size/i`, or a socket reset on a
  request of >1 text): split that request in halves and retry. Notify
  `observeServerBatchFailures` observers
  `{ failedSize, retrySize, endpointUrl }`. Never mark the endpoint failed.
- `getBaseUrl()` = `pool.primaryUrl()`; `getPrimaryBaseUrl()` = peers label;
  `getFallbackBaseUrl()` = fallbacks label;
  `checkHealth/checkPrimaryHealth/checkFallbackHealth` via pool.
- Startup model check: `/props.model_path` basename vs the configured model.
  Accept when it contains the GGUF digest prefix (first 12 hex) or the model
  name slug. On mismatch log ONE warning naming
  `tea-rags llama-server fetch-model` and `tea-rags llama-server command`.
- `resolveModelInfo()`: `contextLength` = `/props` n_ctx per slot
  (`n_ctx/total_slots`), `dimensions` from `getModelDimensions(model)` else a
  one-text probe embed.
- The failback probe timer runs at `probeIntervalMs` (reuse Ollama's constant)
  and is `unref()`-ed.

**Test cases** (fake `fetch` keyed by URL; no network):

- [ ] two peers with fake rates → both receive requests, results in order
- [ ] Bearer header present iff apiKey set
- [ ] peer refused mid-call → its texts re-split to the other peer, call
      succeeds, peer marked unhealthy
- [ ] all peers down → fallback tier serves; peer probe OK → back to peers
- [ ] size failure → halves retried, observer event, endpoint stays healthy
- [ ] no endpoint for longer than the wait budget → throws the unavailable error
- [ ] `/props` 404 → slots 1, still works
- [ ] model-path mismatch → exactly one warning containing `fetch-model`
- [ ] factory `"llama-server"` returns `LlamaServerEmbeddings`; config parses
      `EMBEDDING_API_KEY` and the `llama-server` provider; a single
      `EMBEDDING_BASE_URL` for ollama is unchanged (regression)
- [ ] TDD cycle → commit
      `feat(embedding): llama-server provider with multi-GPU fan-out and local fallback`.

### Task 4: Tuner concurrency hill-climb

**Files:**

- Modify: `src/core/domains/ingest/pipeline/embedding-throughput-tuner.ts`
- Test: `tests/core/domains/ingest/pipeline/embedding-throughput-tuner.test.ts`
  (extend; do NOT rewrite existing business-logic cases except those asserting
  the removed loopback rule, which are replaced by measured-climb equivalents,
  called out in the commit body)

Behaviour (spec §4):

- Remove `concurrencyFor`'s loopback rule. Start concurrency = seeded optimum's
  `concurrency` (registry already stores it), else `configuredConcurrency`,
  clamped to `[1, configuredConcurrency]`.
- After the batch size settles, probe concurrency ×½ and ×2 inside the bounds.
  Each probe measures AGGREGATE chars/s, which is Σ inputChars of observations
  completed while the probe is active divided by the wall-clock span from the
  probe's first observation start to its last end. Observations need `startedAt`
  (add an optional field to `EmbeddingBatchObservation`; when absent, derive it
  as `now() - durationMs`). Accept a move at a ≥ `minImprovement` gain,
  otherwise settle. Re-probe with the size re-probe.
- New adaptation reasons `"concurrency-probe" | "concurrency-settle"`. Remove
  `"endpoint-local" | "endpoint-remote"`. Keep `isLoopbackEmbeddingEndpoint`
  exported only if still referenced; delete it otherwise.
- `EMBEDDING_TUNE_STATIC` pins both values (existing behaviour, keep test).
- The settled optimum persists `concurrency` (field exists in
  `EmbeddingThroughputOptimum`).

**Test cases:** fake server whose aggregate rate peaks at concurrency 4 with
configured 8 → converges to 4; peak at 1 (serialising local server) → converges
to 1; seed concurrency 2 → starts at 2; static pin → never changes; endpoint
switch re-seeds that endpoint's own concurrency.

- [ ] TDD cycle → commit
      `improve(pipeline): measured concurrency hill-climb replaces loopback rule (7ju66 follow-up)`.

### Task 5: Ollama auto-pull

**Files:**

- Create: `src/core/adapters/embeddings/ollama/model-pull.ts`
- Modify: `src/core/adapters/embeddings/ollama.ts`: ONE call site in the
  startup/model-info path. Modify `config.ts`, `schemas.ts`, `parse.ts` and
  `env-groups.ts` for `EMBEDDING_AUTO_PULL` (default `true`).
- Test: `tests/core/adapters/embeddings/ollama/model-pull.test.ts`

**Produces:**
`ensureOllamaModelPresent(baseUrl: string, model: string, deps: { fetch; log }): Promise<"present" | "pulled">`.
It calls `POST /api/show` with `{model}`. On 404 it streams
`POST /api/pull {model, stream:true}`, logs progress lines at most once per 10%
and returns `"pulled"`. A failed pull throws a clear error naming
`ollama pull <model>`.

**Test cases:** present → no pull; 404 → pull called, `"pulled"`; pull error →
throws with the remedy; `EMBEDDING_AUTO_PULL=false` → never called (at the
ollama.ts call site, via a constructor flag).

- [ ] TDD cycle → commit
      `feat(embedding): auto-pull missing Ollama model (EMBEDDING_AUTO_PULL)`.

### Task 6: Ollama-registry GGUF source + `fetch-model`

**Files:**

- Create: `src/core/adapters/embeddings/ollama-registry/gguf-source.ts`,
  `src/cli/commands/llama-server.ts` (yargs `llama-server` command with the
  `fetch-model` subcommand; Task 7 adds `command`)
- Modify: `src/cli/create-cli.ts` (register)
- Test: `tests/core/adapters/embeddings/ollama-registry/gguf-source.test.ts`,
  `tests/cli/commands/llama-server-fetch-model.test.ts`

**Produces:**

```ts
export interface OllamaRegistryGgufSource {
  reference: string;
  blobUrl: string;
  sha256: string;
  size: number;
  fileName: string;
}
export function parseOllamaModelReference(ref: string): {
  namespace: string;
  name: string;
  tag: string;
}; // "unclemusclez/jina-embeddings-v2-base-code:latest"; bare "nomic-embed-text" → namespace "library", tag "latest"
export async function resolveOllamaRegistryGguf(
  ref: string,
  deps: { fetch },
): Promise<OllamaRegistryGgufSource>;
// GET https://registry.ollama.ai/v2/<ns>/<name>/manifests/<tag>
//   Accept: application/vnd.docker.distribution.manifest.v2+json
// layer mediaType "application/vnd.ollama.image.model" → digest/size
// blobUrl = https://registry.ollama.ai/v2/<ns>/<name>/blobs/<digest>
// fileName = "<name>@<tag>-<first12hex>.gguf"
export async function downloadVerifiedGguf(
  src: OllamaRegistryGgufSource,
  destDir: string,
  deps: { fetch },
): Promise<string>; // writes .partial, sha256 stream-verify, rename; existing file with matching digest → no-op
```

CLI: `tea-rags llama-server fetch-model [model] [--dir <path>]`. The default
model is the configured `EMBEDDING_MODEL` or the jina default. The default dir
is `~/.tea-rags/models/gguf` (respects `TEA_RAGS_DATA_DIR`). It prints the final
path.

**Test cases:** reference parsing, including the bare library name; manifest →
source (use the real manifest JSON captured 2026-10-03: digest
`sha256:33a8a1b6a1cbba662f292d32bb55f8d109c0e6cb02de2d243a1b70705ea20986`, size
322997312); digest mismatch → throws and leaves no file; existing verified file
→ no download; CLI prints the path.

- [ ] TDD cycle → commit
      `feat(cli): llama-server fetch-model downloads GGUF from the Ollama registry`.

### Task 7: `tea-rags llama-server command` (print-only)

**Files:**

- Create: `src/cli/commands/llama-server-command-format.ts` (pure)
- Modify: `src/cli/commands/llama-server.ts` (add the `command` subcommand)
- Test: `tests/cli/commands/llama-server-command-format.test.ts`,
  `tests/cli/commands/llama-server-command.test.ts`

**Interfaces — Consumes:** Task 6 `resolveOllamaRegistryGguf` for the URL and
digest of the remote download step.

**Produces:**

```ts
export type LlamaServerTargetOs = "windows" | "linux" | "macos";
export interface LlamaServerCommandOptions {
  os: LlamaServerTargetOs;
  bin: string;
  devices: string[];
  host: string; // default "0.0.0.0"
  port: number;
  /* default 8081 */ slots: number;
  /* default 4 */ modelPath: string;
  advertise?: string;
  apiKey?: string;
  autostart: boolean;
  gguf?: OllamaRegistryGgufSource; // when set, print the download step
}
export interface LlamaServerCommandSheet {
  sections: { title: string; lines: string[] }[];
  clientEnv: Record<string, string>;
}
export function renderLlamaServerCommands(
  o: LlamaServerCommandOptions,
): LlamaServerCommandSheet;
```

The sheet contains, in order:

1. Model download (when `gguf`): Windows
   `Invoke-WebRequest -Uri <blobUrl> -OutFile <modelPath>` +
   `(Get-FileHash <modelPath> -Algorithm SHA256).Hash -eq '<SHA>'`; Linux/macOS
   `curl -L -o`
   - `sha256sum` / `shasum -a 256`.
2. One launch line per device (or one default line plus the
   `<bin> --list-devices` hint when `devices` is empty):
   `<bin> -m <modelPath> --embedding -ngl 999 -fa on -np <slots> -c <slots*8192> -b 8192 -ub 8192 --device <id> --host <host> --port <port+i> [--api-key <key>]`.
   Quote paths with spaces per OS.
3. Firewall:
   `netsh advfirewall firewall add rule name="tea-rags llama-server <port>" dir=in action=allow protocol=TCP localport=<ports>`
   / `sudo ufw allow <a>:<b>/tcp` / none on macOS (a note line).
4. Keep-awake: `powercfg /change standby-timeout-ac 0` /
   `systemd-inhibit --what=sleep` wrapper note / `caffeinate -s` note.
5. Autostart (when `autostart`), one per launch line: Windows
   `schtasks /Create /TN "tea-rags llama-server <port>" /SC ONSTART /RL HIGHEST /RU SYSTEM /TR "<launch line>"`;
   Linux systemd user unit text plus `systemctl --user enable --now`; macOS
   launchd plist plus `launchctl bootstrap gui/$(id -u) <plist>`.

`clientEnv` maps `EMBEDDING_PROVIDER` to `"llama-server"`, and
`EMBEDDING_BASE_URL` to the comma-joined `http://<advertise ?? host>:<port+i>`
list. `EMBEDDING_API_KEY` is included when one is set.

CLI flags:
`--os --bin --device (array) --host --port --slots --model --advertise --api-key --autostart`.
When `--model` is not a path, resolve it via Task 6 to get the URL and digest.
The default `modelPath` per OS is `C:\llama-models\<fileName>` or
`~/llama-models/<fileName>`.

**Test cases:** per-OS snapshot of a two-device sheet (RX 7800M + Arc example);
no-device hint; `0.0.0.0` with `--advertise 192.168.1.71` puts the advertise
address in `clientEnv`; api key in launch lines and clientEnv; quoting of a
Windows path with spaces; **spawns nothing**
(`vi.spyOn(child_process, "spawn")`, `execFile` and `exec` are never called).

- [ ] TDD cycle → commit
      `feat(cli): llama-server command prints per-OS launch, model, autostart lines`.

### Task 8: Documentation (website/docs)

**Files:**

- Create: `website/docs/config/providers/llama-server.md`; a multi-GPU guide
  page under `website/docs/config/providers/` (`llama-server-multi-gpu.md`)
- Modify: `website/docs/config/providers/index.md` (provider matrix +
  **embedding model comparison table**), `config/performance-tuning.md`
  (concurrency now measured; llama-server for 3M+ LOC),
  `config/environment-variables.md` (`EMBEDDING_PROVIDER=llama-server`, URL
  lists, `EMBEDDING_API_KEY`, `EMBEDDING_AUTO_PULL`), `README.md` (one line in
  the providers list, only if a providers list exists)

Content requirements:

- Provider page: when to use (remote GPU host, 3M+ indexed lines; Ollama stays
  default), measured table from the spec, env, peers + local llama-server
  fallback, how fan-out weights uneven GPUs, `fetch-model`, `command`, and
  troubleshooting (Windows Smart App Control blocks unsigned llama.cpp builds →
  turning SAC off is irreversible; incomplete ROCm build missing
  `hipblas.dll`/`rocblas.dll`; host sleep; firewall).
- Multi-GPU guide: worked example of nucbox (RX 7800M via ROCm or Vulkan build
  - Arc 140T via Vulkan build): run `command` once per build, join the endpoint
    lists, local fallback on the Mac.
- Model comparison table: every model in
  `src/core/adapters/embeddings/utils/model-dimensions.ts`, with providers that
  serve it (Ollama / llama-server via Ollama-registry GGUF / ONNX / OpenAI /
  Cohere / Voyage), dimensions, context window, code-specialised vs general.
  Context windows come from model cards; mark any value not verified from a card
  with "—" rather than guessing.
- `docusaurus build` must pass (`cd website && npm run build`); prettier on
  changed md.
- [ ] commit
      `docs(website): llama-server provider, multi-GPU guide, embedding model comparison`.

### Task 9: tea-rags-setup plugin

**Files:**

- Modify: `.claude-plugin/tea-rags-setup/skills/install/SKILL.md`,
  `.claude-plugin/tea-rags-setup/skills/tune/SKILL.md`; plugin version bump in
  `.claude-plugin/tea-rags-setup/.claude-plugin/plugin.json` (minor: new
  feature) and `.claude-plugin/marketplace.json` if it pins versions.

Content:

- install: provider choice adds llama-server. Recommend it when the project is
  ≥3M indexed lines AND a GPU host is available; otherwise Ollama, which stays
  the default. Flow: ask for the GPU host OS and the llama-server binary per
  build, then run
  `tea-rags llama-server command --os … --bin … --device … --advertise … --autostart`.
  Hand the printed commands to the user to run on the host. Run `fetch-model` +
  `command --os <local> --host 127.0.0.1` for the local fallback. Write
  `EMBEDDING_PROVIDER/BASE_URL/FALLBACK_URL/API_KEY` into the project config the
  existing way.
- tune: for llama-server, benchmark `-np` 1/2/4/8 against the RUNNING instances
  (the operator restarts each with the printed line), then re-print with the
  best `--slots`. Client concurrency is the tuner's job; do not tune it here.
- [ ] commit
      `chore(plugin): tea-rags-setup supports llama-server install and tune`.

---

## Self-review

- Spec §1–§3 → Task 3 (+1, 2); §4 → Task 4; §5 → Tasks 5, 6; §6 → Task 7; §7 →
  Task 8; §8 → Task 9; remote-first + local fallback → Tasks 3, 7, 8, 9.
- Names are consistent across tasks: `EmbeddingEndpointPool`,
  `splitEmbeddingBatchAcrossEndpoints`, `LlamaServerEmbeddings`,
  `resolveOllamaRegistryGguf`, `renderLlamaServerCommands`.
- Live validation (user-gated) after merge: taxdome `--force` with llama-server
  on nucbox, together with the h6tmp measurements, only on the user's command.

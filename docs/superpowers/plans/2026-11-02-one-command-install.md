# One-command Install Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use dinopowers:executing-plans
> (or superpowers:subagent-driven-development) to implement this plan
> task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Production
> edits follow tea-rags:data-driven-generation (RED before GREEN,
> `review_changes` gate from your own build).

**Goal:** A user invokes the install skill in Claude Code, Cursor or Codex,
confirms one plan, and ends with llama-server pools running, the project
registered and indexed, and the MCP server working.

**Architecture:** The CLI gains binary installers (llama.cpp, rustc driver), an
HF-backed embedding-model catalog and a llama-server pool manager. The install
skill becomes one step driven by three Node helper scripts plus the harness's
own plugin and MCP commands.

**Tech Stack:** TypeScript (Node ≥ 24), yargs CLI, vitest, GitHub Actions, Node
`.mjs` skill scripts.

**Spec:** `docs/superpowers/specs/2026-11-02-one-command-install-design.md`

## Global Constraints

- Ports: random free ports in 20000–29999, bound to `127.0.0.1`.
- Provider: llama-server only; never offer or configure Ollama.
- `EMBEDDING_MODEL` is always the HF id (`nomic-ai/CodeRankEmbed`,
  `brokkai/Muninn-small`, `jinaai/jina-embeddings-v2-base-code`).
- `-c = np × window`, `-b = -ub = window`; window from the catalog.
- Everything installed lives under the data dir (`TEA_RAGS_DATA_DIR`, default
  `~/.tea-rags`).
- Every download is sha256-verified and published atomically (`.partial` /
  staging dir, then rename).
- Platforms: darwin arm64/x64, linux x64/arm64, win32 x64 (arm64 CPU only).
- MCP configs carry no `env`; the registry is the env source of truth.
- Naming (lexicon-checked): `downloadVerifiedFile`, `downloadNativeAsset`,
  `downloadRustcDriverRelease`, `LlamaServerPools`, `LlamaServerPoolRecord`,
  `EmbeddingModelCatalogEntry`, `selectEmbeddingModelForLanguages`. Naming:
  MISFIT → plan uses the lexicon suggestion; NEW_TERM → project term (topTerms /
  concept.terms) if same meaning, else one-line justification in the Task.
- Commit scopes per `.claude/rules/commit-rules.md`; the help-text default-host
  flip in Task 4 carries a `BREAKING CHANGE:` footer.

## Impact enrichment

`semantic_search(rerank: blastRadius, metaOnly)` over the affected files:

| File                                                    | dominantAuthor | commitCount | ageDays | bugFixRate | taskIds                                  |
| ------------------------------------------------------- | -------------- | ----------- | ------- | ---------- | ---------------------------------------- |
| `src/core/adapters/embeddings/llama-server/provider.ts` | artk0de (100%) | 9           | 0       | —          | sm1ow, 0xw12, w1bz7, 1xnmd, y1ynz, 4ygqi |
| `src/core/adapters/embeddings/endpoint-pool.ts`         | artk0de (100%) | 9           | 0       | —          | sm1ow, o4p5l, 1xnmd, y1ynz               |
| `src/core/adapters/qdrant/embedded/download.ts`         | artk0de (100%) | 10          | 2       | —          | 2wu2h                                    |
| `src/core/adapters/rustc-driver/executable.ts`          | artk0de (100%) | 4           | 3       | —          | —                                        |
| `src/core/adapters/rustc-driver/callsite-runner.ts`     | artk0de (100%) | 9           | 0       | —          | rw6ul                                    |
| `src/cli/create-cli.ts`                                 | artk0de (100%) | 17          | 4       | —          | 8vy3o                                    |

**Coordinated change candidates:** sm1ow / 1xnmd / y1ynz → `provider.ts`,
`endpoint-pool.ts` — Task 6 touches both together.

**High blast radius:** `download.ts` (transitiveImpact 121, regional) — used as
a pattern only, not modified. `executable.ts` (fanIn popular) — Task 7 adds a
tier input, not a tier. `callsite-runner.ts` carries god-method chunks — Task 8
adds a seam, not more branches inside them.

---

### Task 1: Shared verified download and archive publish

**Files:**

- Create: `src/core/adapters/native-assets/verified-download.ts`
- Create: `src/core/adapters/native-assets/archive-publish.ts`
- Create: `src/core/adapters/native-assets/index.ts`
- Modify: `src/core/adapters/embeddings/ollama-registry/gguf-source.ts`
  (`downloadVerifiedGguf` delegates to `downloadVerifiedFile`)
- Test: `tests/core/adapters/native-assets/verified-download.test.ts`,
  `tests/core/adapters/native-assets/archive-publish.test.ts`

**Interfaces — Produces:**

```ts
export interface VerifiedFileSource {
  url: string;
  sha256: string; // lowercase hex
  fileName: string;
}
export interface NativeAssetDeps {
  fetch: (input: string, init?: RequestInit) => Promise<Response>;
}
/** Stream url → `<destDir>/<fileName>.partial`, hash while streaming, rename on match. Skips when the final file already hashes to sha256. */
export function downloadVerifiedFile(
  src: VerifiedFileSource,
  destDir: string,
  deps: NativeAssetDeps,
): Promise<string>;

/** Extract `archivePath` (.tar.gz or .zip, via `tar -xf`, which handles zip on Windows 10+) into `<targetDir>.staging`, run `verify(stagingDir)`, then rename staging → targetDir. Existing targetDir → returned untouched. */
export function publishArchive(
  archivePath: string,
  targetDir: string,
  verify: (stagingDir: string) => Promise<void>,
  deps: { run: (cmd: string, args: string[]) => Promise<void> },
): Promise<string>;
```

- [ ] **Step 1: RED.** `verified-download.test.ts` against a local `node:http`
      fixture server: (a) downloads and returns the path; (b) sha mismatch
      throws `sha256 mismatch` and leaves neither the final file nor the
      `.partial`; (c) a second call with the file present makes zero requests;
      (d) HTTP 404 throws naming the URL. `archive-publish.test.ts`: (a) a
      tar.gz made in the test publishes into `targetDir`; (b) `verify` throwing
      leaves no `targetDir` and no `.staging`; (c) existing `targetDir` → `run`
      never called. Run `npx vitest run tests/core/adapters/native-assets` →
      FAIL (module missing is not red: create the files exporting stubs that
      throw first).
- [ ] **Step 2: GREEN.** Implement by lifting the body of `downloadVerifiedGguf`
      into `downloadVerifiedFile`; `downloadVerifiedGguf` becomes
      `downloadVerifiedFile({ url: src.blobUrl, sha256: src.sha256, fileName: src.fileName }, destDir, deps)`
      with its error message prefix kept (`gguf-source.test.ts` stays untouched
      and green).
- [ ] **Step 3:**
      `npx vitest run tests/core/adapters/native-assets tests/core/adapters/embeddings/ollama-registry`
      → PASS; `npx tsc --noEmit`.
- [ ] **Step 4: Commit**
      `feat(adapters): sha256-verified download and atomic archive publish`.

### Task 2: llama.cpp binary install and discovery

**Files:**

- Create: `scripts/gen-llama-cpp-manifest.ts` (reads
  `https://api.github.com/repos/ggml-org/llama.cpp/releases/tags/<build>`,
  writes the generated table; asset `digest` field = sha256)
- Create:
  `src/core/adapters/llama-server/install/llama-cpp-manifest.generated.ts`
- Create: `src/core/adapters/llama-server/install/llama-cpp-assets.ts`
- Create: `src/core/adapters/llama-server/install/gpu-backend.ts`
- Create: `src/core/adapters/llama-server/install/install.ts`
- Create: `src/core/adapters/llama-server/binary.ts`
- Modify: `src/cli/commands/llama-server.ts` (add `install` subcommand)
- Test: `tests/core/adapters/llama-server/install/*.test.ts`,
  `tests/core/adapters/llama-server/binary.test.ts`

**Interfaces — Produces:**

```ts
export type LlamaServerBackend = "metal" | "cpu" | "cuda" | "vulkan" | "rocm";
export const LLAMA_CPP_BUILD = "b12032";
/** Asset names (+ the cudart companion for cuda) for one platform triple; throws ConfigValueInvalidError on an unmapped triple. */
export function llamaCppAssetsFor(
  platform: NodeJS.Platform,
  arch: string,
  backend: LlamaServerBackend,
): {
  asset: string;
  sha256: string;
  companion?: { asset: string; sha256: string };
};
/** darwin-arm64 → metal; else probe nvidia-smi → cuda, rocminfo → rocm, vulkaninfo → vulkan; nothing → cpu. */
export function detectLlamaServerBackend(
  platform: NodeJS.Platform,
  arch: string,
  deps: { which: (cmd: string) => boolean },
): LlamaServerBackend;
/** Installs into `<dataDir>/llama.cpp/<build>-<backend>/`; returns the llama-server path. */
export function downloadLlamaServer(
  opts: {
    dataDir: string;
    platform: NodeJS.Platform;
    arch: string;
    backend: LlamaServerBackend;
  },
  deps: NativeAssetDeps & {
    run: (cmd: string, args: string[]) => Promise<void>;
  },
): Promise<string>;
/** LLAMA_SERVER_PATH → newest managed install under `<dataDir>/llama.cpp/` → PATH; null when none. */
export function resolveLlamaServerBinary(deps: {
  env: Record<string, string | undefined>;
  dataDir: string;
  exists: (p: string) => boolean;
  listDir: (p: string) => string[];
  which: (cmd: string) => string | null;
}): string | null;
```

Asset table (b12032, values come from the generator, not typed by hand):
`macos-arm64` (metal), `macos-x64` (cpu), `ubuntu-x64`, `ubuntu-arm64`,
`ubuntu-vulkan-{x64,arm64}`, `ubuntu-cuda-13.4-{x64,arm64}` (+
`cudart-llama-b12032-bin-ubuntu-cuda-13.4-<arch>.tar.gz`),
`ubuntu-rocm-10.0-x64`, `win-cpu-{x64,arm64}`, `win-vulkan-x64`,
`win-cuda-13.4-x64` (+ `cudart-llama-bin-win-cuda-13.4-x64.zip`),
`win-rocm-10.0-x64`. Unix archives hold `llama-b12032/llama-server`; the Windows
zip holds `llama-server.exe` at its root — the installer locates the binary by
name one level deep after extraction, and the companion archive is extracted
into the same staging dir.

- [ ] **Step 1: RED.** Tests: every supported triple maps to an asset whose name
      contains the platform token; `win32-arm64` + `cuda` throws; cuda triples
      carry a companion; backend detection order with a fake `which`;
      `downloadLlamaServer` against the Task 1 fixture server with a tiny tar.gz
      holding `llama-b12032/llama-server` publishes and returns that path;
      discovery order env → managed → PATH, and managed picks the directory
      whose name starts with `LLAMA_CPP_BUILD`.
- [ ] **Step 2: GREEN.** Run `npx tsx scripts/gen-llama-cpp-manifest.ts` to
      write the generated table; implement the modules; add
      `tea-rags llama-server install [--backend auto|metal|cpu|cuda|vulkan|rocm]`
      printing the installed path.
- [ ] **Step 3:** targeted vitest + `tsc`; one real run
      `node build/cli/index.js llama-server install` on this Mac (after
      `npm run build`) with `TEA_RAGS_DATA_DIR` pointed at a job tmp dir — the
      binary must answer `--version`.
- [ ] **Step 4: Commit**
      `feat(embedding): install llama-server from llama.cpp release binaries`.

### Task 3: Embedding model catalog, language choice, HF fetch-model

**Files:**

- Create: `src/core/adapters/embeddings/model-catalog.ts`
- Create: `src/core/adapters/embeddings/model-choice.ts`
- Modify: `src/cli/commands/llama-server.ts` (`fetch-model` resolves catalog ids
  first, Ollama references second)
- Test: `tests/core/adapters/embeddings/model-catalog.test.ts`,
  `tests/core/adapters/embeddings/model-choice.test.ts`

**Interfaces — Produces:**

```ts
export interface EmbeddingModelCatalogEntry {
  id: string;
  gguf: {
    repo: string;
    file: string;
    revision: string;
    sha256: string;
    bytes: number;
  } | null; // null = not published
  dimensions: number;
  window: number;
  trainedLanguages: readonly string[];
}
export const EMBEDDING_MODEL_CATALOG: readonly EmbeddingModelCatalogEntry[];
export function catalogEntryFor(
  id: string,
): EmbeddingModelCatalogEntry | undefined;
/** shares: language → fraction of code LOC (sums to ≤ 1). Rules in spec order; a rule whose model has gguf === null falls through to CodeRankEmbed. */
export function selectEmbeddingModelForLanguages(
  shares: Readonly<Record<string, number>>,
): { model: EmbeddingModelCatalogEntry; rule: string };
export const RUBY_SHARE_THRESHOLD = 0.05;
export const SWIFT_SHARE_THRESHOLD = 0.05;
export const MUNINN_COVERAGE_THRESHOLD = 0.8;
```

Catalog values:

| id                                    | repo                                              | file                                     | revision                                   | sha256                                                             | bytes     | dims | window |
| ------------------------------------- | ------------------------------------------------- | ---------------------------------------- | ------------------------------------------ | ------------------------------------------------------------------ | --------- | ---- | ------ |
| `jinaai/jina-embeddings-v2-base-code` | `ggml-org/jina-embeddings-v2-base-code-Q8_0-GGUF` | `jina-embeddings-v2-base-code-q8_0.gguf` | `05e79e9a6c8b99491e92ebb28d753268f8601e3c` | `3bd1722f09350209aa3ada93df55882666c58194bfbbbe81c30545d731cb4e7a` | 172869280 | 768  | 8192   |
| `nomic-ai/CodeRankEmbed`              | `brandtcormorant/CodeRankEmbed-Q8_0-GGUF`         | `coderankembed-q8_0.gguf`                | `33bd774d16ed49b07e79e89c192751d11f47fec0` | `666db8df27c88570cdc07adca28646260038b8ca65354911d57b936ebf56efaa` | 146029792 | 768  | 2048   |
| `brokkai/Muninn-small`                | `null` until published                            |                                          |                                            |                                                                    |           | 384  | 8192   |

Trained languages: CodeRankEmbed python, java, javascript, go, php, ruby; Muninn
c, cpp, csharp, go, java, javascript, typescript, php, python, rust, scala; jina
— the 30 languages of its card (store what the card lists). Download URL:
`https://huggingface.co/<repo>/resolve/<revision>/<file>`.

- [ ] **Step 1: RED.** Catalog: every entry's `dimensions` equals
      `MODEL_DIMENSIONS[id]` (import from `utils/model-dimensions.ts`; add the
      jina HF id there if absent). Choice: `{ruby: .06, typescript: .94}` →
      CodeRankEmbed; `{swift: .5, python: .5}` → CodeRankEmbed;
      `{typescript: .9, python: .1}` with Muninn unpublished → CodeRankEmbed
      with rule naming the fall-through, and with a test catalog where Muninn is
      published → Muninn; `{elixir: .7, typescript: .3}` → jina.
      `fetch-model nomic-ai/CodeRankEmbed` with a fake fetch downloads from the
      resolve URL into `<dataDir>/models/`.
- [ ] **Step 2: GREEN.** Implement; `fetch-model` uses `downloadVerifiedFile`.
      Add `tea-rags llama-server choose-model --shares '<json>'` printing
      `{ model, rule, window, dimensions }` — the install skill's only entry
      into the language table (test: the four share fixtures above through the
      CLI).
- [ ] **Step 3:** targeted vitest + `tsc`.
- [ ] **Step 4: Commit**
      `feat(embedding): HF model catalog and language-based model choice`.

### Task 4: llama-server pools — start, stop, status

**Files:**

- Create: `src/core/adapters/llama-server/pools/pool-registry.ts`
  (`LlamaServerPoolRecord`, read/write `<dataDir>/llama-server/pools.json`)
- Create: `src/core/adapters/llama-server/pools/ports.ts`
- Create: `src/core/adapters/llama-server/pools/llama-server-pools.ts`
- Modify: `src/cli/commands/llama-server.ts` (`start`, `stop`, `status`)
- Modify: `src/cli/commands/llama-server-command-format.ts` (default host
  `127.0.0.1`)
- Test: `tests/core/adapters/llama-server/pools/*.test.ts`

**Interfaces — Produces:**

```ts
export interface LlamaServerPoolRecord {
  model: string; // catalog id
  ggufPath: string;
  binary: string;
  instances: { pid: number; port: number; logPath: string }[];
  args: string[]; // shared launch args without --port
  startedAt: string;
}
export function pickFreePorts(
  count: number,
  deps: { isFree: (port: number) => Promise<boolean>; random: () => number },
): Promise<number[]>; // 20000–29999, distinct
export function buildPoolLaunchArgs(o: {
  ggufPath: string;
  window: number;
  slots: number;
  gpuLayers: number;
  flashAttention: boolean;
}): string[];
// ["-m", ggufPath, "--embedding", "--host", "127.0.0.1", "-ngl", String(gpuLayers), "-fa", flashAttention ? "on" : "off", "-np", String(slots), "-c", String(slots * window), "-b", String(window), "-ub", String(window)]
export class LlamaServerPools {
  constructor(deps: LlamaServerPoolsDeps);
  start(o: {
    model: string;
    instances: number;
    slots: number;
    gpuLayers: number;
    flashAttention: boolean;
  }): Promise<LlamaServerPoolRecord>; // spawn detached, wait /health, verify /props served model, persist
  stop(model?: string): Promise<void>;
  status(): Promise<
    {
      model: string;
      instances: { port: number; pid: number; alive: boolean }[];
    }[]
  >;
  endpointsFor(record: LlamaServerPoolRecord): string[]; // http://127.0.0.1:<port>
}
```

`LlamaServerPoolsDeps` injects `spawn`, `fetch`, `kill`, `isAlive(pid)`, fs,
clock and `dataDir` so tests run a fake `llama-server` (a Node script serving
`/health` and `/props` on the `--port` it receives).

- [ ] **Step 1: RED.** Ports in range, distinct, skip busy ones; launch args
      exactly as above for CodeRankEmbed (window 2048, 4 slots → `-c 8192`);
      `start` with the fake binary records 2 instances and both answer
      `/health`; `/props` reporting another model → `start` stops what it
      spawned and throws; `stop` kills and removes the record; `status` marks a
      dead pid `alive: false`; `pools.json` survives a round trip. Command-sheet
      test: default host is `127.0.0.1` (update the pin that asserts `0.0.0.0` —
      `PIN-UPDATED`, spec line "default host becomes 127.0.0.1").
- [ ] **Step 2: GREEN.** Implement; served-model check reuses
      `servedModelMatches` from the llama-server provider module.
- [ ] **Step 3:** targeted vitest + `tsc`.
- [ ] **Step 4: Commit**
      `feat(embedding)!: managed llama-server pools on loopback ports` with
      footer
      `BREAKING CHANGE: llama-server command sheets default to --host 127.0.0.1; pass --host 0.0.0.0 to serve a LAN.`

### Task 5: Throughput bench and `--instances auto`

**Files:**

- Create: `src/core/adapters/llama-server/pools/pool-bench.ts`
- Modify: `src/cli/commands/llama-server.ts` (`bench`, `start --instances auto`)
- Test: `tests/core/adapters/llama-server/pools/pool-bench.test.ts`

**Interfaces — Produces:**

```ts
export function benchPoolThroughput(
  o: {
    model: string;
    maxInstances: number;
    slots: number;
    gpuLayers: number;
    flashAttention: boolean;
  },
  deps: {
    pools: LlamaServerPools;
    embed: (endpoints: string[], texts: string[]) => Promise<void>;
    now: () => number;
  },
): Promise<{ instances: number; textsPerSecond: number }[]>;
/** Smallest count within 5% of the best, never below 2. */
export function chooseInstanceCount(
  results: { instances: number; textsPerSecond: number }[],
): number;
export const BENCH_CORPUS_SIZE = 512; // synthetic code-like texts, ~600 chars each, deterministic
```

- [ ] **Step 1: RED.** `chooseInstanceCount([{1,100},{2,190},{3,198},{4,200}])`
      → 3; `[{1,100},{2,101}]` → 2; bench starts and stops a pool per count with
      a fake `embed` and fake clock.
- [ ] **Step 2: GREEN.** Implement; `maxInstances` default: 4 on Apple Silicon,
      else 3.
- [ ] **Step 3:** targeted vitest + `tsc`.
- [ ] **Step 4: Commit** `feat(embedding): llama-server pool throughput bench`.

### Task 6: Restart a managed pool on demand

**Files:**

- Modify: `src/core/adapters/embeddings/llama-server/provider.ts`
- Modify: `src/core/adapters/embeddings/endpoint-pool.ts`
- Modify: the bootstrap site that constructs `LlamaServerEmbeddings` (locate
  with `find_symbol` / `get_callers` on `LlamaServerEmbeddings#constructor`)
- Test: `tests/core/adapters/embeddings/llama-server/pool-revive.test.ts`

**Interfaces — Consumes:** `LlamaServerPools`, `LlamaServerPoolRecord`.
**Produces:** an optional
`reviveEndpoints?: (endpoints: string[]) => Promise<boolean>` dependency of
`LlamaServerEmbeddings`, called once per process when every endpoint fails its
first connection attempt; `true` → retry the batch once.

- [ ] **Step 1: RED.** With all endpoints refusing connections and a
      `reviveEndpoints` that returns `true` and makes them answer, `embedBatch`
      succeeds and `reviveEndpoints` ran once; with `false`, the original
      connection error surfaces unchanged; a second outage in the same process
      does not call it again.
- [ ] **Step 2: GREEN.** Bootstrap wires `reviveEndpoints` only when the
      project's endpoint list equals `endpointsFor(record)` of a record in
      `pools.json`; it restarts that pool on the recorded ports.
- [ ] **Step 3:** targeted vitest (provider + endpoint-pool suites) + `tsc`.
- [ ] **Step 4: Commit**
      `feat(embedding): restart a managed llama-server pool when its endpoints are down`.

### Task 7: rustc driver release artifacts and `rustc-driver install`

**Files:**

- Modify: `.github/workflows/release.yml` (matrix job: darwin-arm64, darwin-x64,
  linux-x64, linux-arm64, windows-x64; installs the pinned nightly with
  `rustc-dev,rust-src,llvm-tools-preview`, builds
  `native/tea-rags-rustc-driver`, archives the binary as
  `tea-rags-rustc-driver-<pin>-<sourceHash>-<platform>.tar.gz` (`.zip` on
  Windows), uploads archives plus `rustc-driver-manifest.json`
  `{ pin, sourceHash, assets: { <platform>: { asset, sha256 } } }` to the
  release; a smoke step runs the binary's `--version` on a clean runner with a
  `--profile minimal` toolchain)
- Create: `src/core/adapters/rustc-driver/release-download.ts`
- Create: `src/cli/commands/rustc-driver.ts`; Modify: `src/cli/create-cli.ts`
  (register the group — the one wiring edit in this plan)
- Modify: `scripts/postinstall.js` (best-effort driver download, never fails the
  install)
- Modify: `src/core/adapters/rustc-driver/executable.ts`
  (`rustcDriverInstallHint` names `tea-rags rustc-driver install`)
- Test: `tests/core/adapters/rustc-driver/release-download.test.ts`,
  `tests/cli/commands/rustc-driver.test.ts`

**Interfaces — Produces:**

```ts
/** Fetches rustc-driver-manifest.json from the release of `version`, downloads this platform's archive into `${dataDir}/rustc-driver/bin/<pin>-<sourceHash>/` via publishArchive; returns the binary path. Manifest pin/sourceHash ≠ RUSTC_DRIVER_TOOLCHAIN_PIN / computeRustcDriverSourceHash() → throws (stale release). */
export function downloadRustcDriverRelease(
  o: {
    version: string;
    dataDir: string;
    platform: NodeJS.Platform;
    arch: string;
  },
  deps: NativeAssetDeps & {
    run: (cmd: string, args: string[]) => Promise<void>;
  },
): Promise<string>;
/** rustup toolchain install <pin> --profile minimal with RUSTUP_HOME/CARGO_HOME under `${dataDir}/rust/`; rustup missing → installs rustup-init with --no-modify-path into the same home. */
export function installRustcDriverToolchain(
  o: { pin: string; dataDir: string },
  deps: {
    run: (
      cmd: string,
      args: string[],
      env: Record<string, string>,
    ) => Promise<void>;
    exists: (p: string) => boolean;
  },
): Promise<void>;
```

The driver runner must execute a cache-tier binary with the managed
`RUSTUP_HOME`/`CARGO_HOME` when `${dataDir}/rust/` exists, so the binary finds
`librustc_driver` of the pinned toolchain.

- [ ] **Step 1: RED.** Manifest mismatch throws naming both pins; matching
      manifest publishes into the exact `buildPaths` binDir (so
      `discoverRustcDriver` reports tier `cache`); toolchain install passes the
      managed env; runner env includes `RUSTUP_HOME` when the managed dir
      exists.
- [ ] **Step 2: GREEN.** Implement; CLI `tea-rags rustc-driver install`
      (download + toolchain) and `tea-rags rustc-driver status`.
- [ ] **Step 3:** targeted vitest + `tsc`; `actionlint` on `release.yml` if
      installed, else a YAML parse.
- [ ] **Step 4: Commit**
      `feat(adapters): prebuilt rustc driver from GitHub Releases` +
      `ci(release): build and publish rustc driver per platform`.

### Task 8: cargo check per workspace root

**Files:**

- Create: `src/core/adapters/rustc-driver/cargo-roots.ts`
- Modify: `src/core/adapters/rustc-driver/callsite-runner.ts` (iterate roots;
  add the loop as a seam around the existing per-root run, do not grow the
  god-method chunks)
- Test: `tests/core/adapters/rustc-driver/cargo-roots.test.ts`

**Interfaces — Produces:**
`findCargoRoots(projectRoot: string, files: readonly string[], readManifest: (p: string) => string): string[]`
— returns directories holding a `Cargo.toml` that declares `[workspace]`, plus
packages not covered by any workspace's members; repository-root-only projects
return `[projectRoot]`.

- [ ] **Step 1: RED.** Fixtures: root workspace → `[root]`; no root manifest,
      `backend/Cargo.toml` package → `[backend]`; root workspace with members
      `["crates/*"]` and a stray `tools/x/Cargo.toml` → `[root, tools/x]`.
      Runner test: two roots → two
      `cargo check --manifest-path <root>/Cargo.toml` runs, results merged.
- [ ] **Step 2: GREEN.** Implement; `Cargo.lock` / `cargo fetch` per root.
- [ ] **Step 3:** targeted vitest + `tsc`.
- [ ] **Step 4: Commit**
      `fix(adapters): run the rustc driver per cargo workspace root`.

### Task 9: Status defects — driver re-probe and aborted jobs

**Files:** located by the parent session's diagnosis before dispatch (the
status/prime driver line and the job-notification set).

- [ ] **Step 1: RED.** Driver: status rendered after the driver appears on disk
      reports it available without an index run. Jobs: an `aborted` job notifies
      once; the next status read no longer lists it.
- [ ] **Step 2: GREEN.** Driver availability is computed at read time via
      `discoverRustcDriver`; aborted jobs move out of the notification set after
      the first report.
- [ ] **Step 3:** targeted vitest + `tsc`.
- [ ] **Step 4: Commit**
      `fix(bootstrap): live rustc driver status and one-shot aborted-job notice`.

### Task 10: Install skill helper scripts

**Files:**

- Create: `plugins/tea-rags-setup/scripts/detect.mjs`,
  `plugins/tea-rags-setup/scripts/contextignore.mjs`,
  `plugins/tea-rags-setup/scripts/profile.mjs`
- Delete: `plugins/tea-rags-setup/scripts/setup/unix/*.sh`,
  `plugins/tea-rags-setup/scripts/setup/windows/*.ps1`
- Test: `tests/plugins/tea-rags-setup/{detect,contextignore,profile}.test.ts`
  with fixture repos under `tests/fixtures/setup/`

Contract (each script prints one JSON object to stdout, exit 0; errors → JSON
`{ "error": "..." }`, exit 1):

- `detect.mjs` →
  `{ os, arch, ramGb, gpuBackend, node: { version, ok }, teaRags: { version } | null, harness: "claude"|"cursor"|"codex"|"unknown", registered: { name } | null }`.
  Harness from env (`CLAUDECODE`, `CURSOR_AGENT`, `CODEX_HOME`/`CODEX_SANDBOX`).
- `contextignore.mjs <projectDir>` → writes/merges `.contextignore.local`,
  prints `{ added: string[], kept: number }`. Patterns per detected stack: Rust
  `target/`; Node `node_modules/`, `dist/`, `build/`, `coverage/`, `.next/`,
  `.nuxt/`, `.svelte-kit/`, `.turbo/`; Ruby `vendor/bundle/`, `public/assets/`,
  `public/packs/`, `tmp/`, `log/`; Python `.venv/`, `__pycache__/`,
  `*.egg-info/`; Swift `.build/`, `DerivedData/`, `Pods/`; Go `vendor/`; all
  stacks `*.min.js`, `*.min.css`, `*.map`, `*.lock`, `package-lock.json`,
  `*.generated.*`, `*.pb.go`, `*_pb2.py`. Existing user lines are never removed
  or reordered; added lines go under a `# tea-rags install` header.
- `profile.mjs <projectDir>` →
  `{ files, loc, languages: { <lang>: { files, loc, share } }, estimatedChunks }`
  over `git ls-files` minus `.gitignore`, `.contextignore`,
  `.contextignore.local`; language by extension through a table exported from
  the build (`tea-rags` CLI `languages --json` if present, else the table
  inlined in the script, kept in sync by a test against
  `src/core/domains/language` extensions).

- [ ] **Step 1: RED.** Fixtures: Rust repo with a committed-but-ignored-by-us
      `target/` file and a `backend/Cargo.toml`; SvelteKit repo with
      `.svelte-kit/`; Ruby + JS repo. Assert contextignore adds `target/` /
      `.svelte-kit/` and keeps a pre-existing user line; profile excludes those
      paths and reports the Ruby share; detect reports `harness: "codex"` when
      `CODEX_HOME` is set.
- [ ] **Step 2: GREEN.** Implement the three scripts; delete the shell twins.
- [ ] **Step 3:** targeted vitest.
- [ ] **Step 4: Commit**
      `improve(scripts): cross-platform Node helpers for the install skill`.

### Task 11: One-step install skill for all three harnesses

**Files:**

- Rewrite: `plugins/tea-rags-setup/skills/install/SKILL.md`
- Delete: `plugins/tea-rags-setup/skills/install/steps/*`,
  `plugins/tea-rags-setup/skills/install/reference.md` (fold the still-true
  parts into `SKILL.md`)
- Modify: `plugins/tea-rags-setup/skills/tune/SKILL.md` (re-tune only;
  llama-server pools via `tea-rags llama-server bench/start`)
- Modify: `scripts/gen-harness-cursor.ts`, `scripts/gen-harness-codex.ts` (emit
  the setup plugin), regenerate with `npm run gen:plugins`
- Test: existing `tests/hooks/skill-*.test.sh` budgets and resource refs pass;
  add `tests/scripts/gen-harness-setup.test.ts` asserting the setup plugin is
  generated for Cursor and Codex

SKILL.md flow (spec "Install skill" section, verbatim order): detect →
contextignore → profile → plan (model by `selectEmbeddingModelForLanguages` via
`tea-rags llama-server choose-model --shares <json>` from Task 3) → ONE
confirmation → apply (`npm i -g tea-rags@latest` when missing/older,
`llama-server install`, `fetch-model`, `llama-server start --instances auto`,
`rustc-driver install` when Rust present, `tea-rags projects register` with
endpoints + HF model id, plugin + MCP via the harness table,
`index-codebase --wait-enrichments --json`) → verify. No Ollama, no squash
question, git analytics on.

- [ ] **Step 1: RED.** Generator test fails (no setup plugin for Cursor/Codex).
- [ ] **Step 2: GREEN.** Rewrite the skill, extend generators, regenerate.
- [ ] **Step 3:** `npx vitest run tests/scripts/gen-harness-setup.test.ts`;
      `bash tests/hooks/skill-size-budgets.test.sh`; markdownlint on the skill.
- [ ] **Step 4: Commit**
      `improve(plugin): one-step install skill for Claude, Cursor and Codex`.

### Task 12: Docs

**Files:** `website/docs/config/providers/llama-server.md`,
`website/docs/config/embedding-model-choice.md`, the quickstart install page.

- [ ] Document `llama-server install|fetch-model|start|stop|status|bench`,
      `rustc-driver install`, the language → model table, loopback default.
- [ ] Commit
      `docs(website): one-command install and managed llama-server pools`.

## Execution order

Wave A (parallel): Tasks 1, 8, 10. Wave B: Tasks 2, 3 (need 1). Wave C: Tasks 4
→ 5, 7 (needs 1). Wave D: Task 6 (needs 4), Task 9. Wave E: Task 11 (needs 2–5,
7, 10), Task 12. Live validation (user-gated): clean install on this Mac into a
temporary data dir, then on a real project.

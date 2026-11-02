# One-command TeaRAGs install

Date: 2026-11-02. Status: approved in session (decisions below were made by the
user turn by turn; this document records them).

## Problem

A user installed TeaRAGs through Cursor with the `tea-rags-setup` wizard
(transcript `~/Desktop/cursor_tea_rags_setup_plugin_installati.md`). They had to
solve twenty problems by hand. Grouped:

- **Delivery.** The setup plugin exists only for Claude Code (1); the main
  plugin was installed on a separate request and its `mcp.json` fought the
  project one (2); npm lagged main by 722 commits, so the user built from source
  (3); a clone under `~/.tea-rags/src/...` hit the
  `.replace("/src/", "/build/")` worker-path bug in four places (4); Node 20
  instead of 24 (5).
- **Model and llama-server.** Muninn-small has no public GGUF, `fetch-model`
  reads only the Ollama registry, and the agent improvised a python conversion
  (6); the wizard looked for `llama-server` only in `/opt/homebrew/bin` (7); the
  user had to demand random ports and the `tea-rags llama-server` commands (8);
  `EMBEDDING_MODEL` was not written, then written as a GGUF file name the
  dimension registry does not know (9); `llama-server command` binds `0.0.0.0`
  without a key (10).
- **Project size.** `analyze-project.sh` ignores `.gitignore`, counts `target/`
  and `.svelte-kit`, and knows 16 extensions — 755k LOC estimated, 367 files
  indexed (11); `.contextignore.local` was written by hand in two rounds (12).
- **Rust driver.** "Yes" in the wizard produced a silent `unavailable` (13); the
  user built the driver by hand (14); `cargo check` runs only at the repository
  root, so a nested `backend/Cargo.toml` needed a wrapper (15); the driver
  status stayed `unavailable` until a forced recompute (16).
- **Configuration.** Git analytics was switched off in the wizard and then on
  again, plus squash-aware sessions, each costing a rebuild — one of them a full
  `--force` (17); env lives in both the registry and `.cursor/mcp.json`, so MCP
  restarted at least four times (18); the wizard never indexes, tunes before the
  MCP exists, and packs five questions into one line (19); two `aborted`
  indexing jobs kept notifying (20).

## Goal

One install step: the user invokes the install skill in their harness, sees one
plan, confirms once, and ends with a registered, indexed project whose MCP
server works. macOS, Linux and Windows.

## Ownership split

**The CLI owns binaries and processes, nothing else.**

- Installs `llama-server` from llama.cpp release binaries for the OS and GPU
  backend into `~/.tea-rags/llama.cpp/<build>/`.
- Installs the rustc driver from a TeaRAGs GitHub Release into the existing
  driver cache, plus the pinned nightly it links against.
- Downloads embedding-model GGUFs from Hugging Face into `~/.tea-rags/models/`.
- Starts, stops, reports and benchmarks llama-server pools.

**The install skill owns everything else**, because the harness already knows
how to install its own plugins and MCP servers: environment detection,
`.contextignore.local`, the project profile, model choice, the plan and its
single confirmation, plugin and MCP installation, registration, indexing.

Rejected: a `tea-rags setup` command owning the whole flow. It would duplicate
three harnesses' plugin and MCP mechanics inside the CLI and go stale whenever a
harness changes its plugin commands. The user rejected it explicitly.

## Decisions

| Topic                 | Decision                                                                                                  |
| --------------------- | --------------------------------------------------------------------------------------------------------- |
| Embedding provider    | llama-server only. Ollama is not offered; a user switches to it themselves.                               |
| Instances             | Two or more. `llama-server bench` picks the count.                                                        |
| Model choice          | By language; see the table below.                                                                         |
| Hardware profile      | Sets instances, `-np`, `-ngl`, `-fa` and client env only. `-c`, `-b`, `-ub` derive from the model window. |
| Ports                 | Random free ports in 20000–29999, bound to `127.0.0.1`.                                                   |
| Squash-aware sessions | Not asked. The flag is removed (separate branch, see below).                                              |
| Git analytics         | On by default, not asked.                                                                                 |
| Env source of truth   | The project registry. MCP configs carry no `env`.                                                         |
| Platforms             | macOS (arm64, x64), Linux (x64, arm64), Windows (x64; arm64 CPU only).                                    |

### Language → model

Shares are of code LOC after `.contextignore.local` is applied.

| Rule (first match wins)                                                                                 | Model                                 | Why                                                                                           |
| ------------------------------------------------------------------------------------------------------- | ------------------------------------- | --------------------------------------------------------------------------------------------- |
| Ruby ≥ 5%                                                                                               | `nomic-ai/CodeRankEmbed`              | Ruby is in its training set; +0.10 MRR over Muninn on both Ruby corpora                       |
| Swift ≥ 5%                                                                                              | `nomic-ai/CodeRankEmbed`              | Measured on pixbar-tiles: 0.802 MRR vs jina 0.689 vs Muninn 0.664                             |
| Muninn-trained languages ≥ 80% (C, C++, C#, Go, Java, JavaScript, TypeScript, PHP, Python, Rust, Scala) | `brokkai/Muninn-small`                | 2.37× jina throughput; the +0.03 MRR CodeRankEmbed gives on TypeScript is not worth the speed |
| otherwise                                                                                               | `jinaai/jina-embeddings-v2-base-code` | Widest language coverage, 8192 window                                                         |

The 5% and 80% thresholds are installer constants, printed in the plan so the
user can override the model on the confirmation screen.

`EMBEDDING_MODEL` is always the Hugging Face id, never a file name — this is the
key `MODEL_DIMENSIONS` and `servedModelMatches` know (fixes 9).

### Model catalog

A typed catalog in the CLI, one entry per model:

| Field              | Meaning                                                     |
| ------------------ | ----------------------------------------------------------- |
| `id`               | HF id, the value written to `EMBEDDING_MODEL`               |
| `gguf`             | `{ repo, file, revision, sha256, bytes }` on Hugging Face   |
| `dimensions`       | must equal `MODEL_DIMENSIONS[id]` (test-enforced)           |
| `window`           | tokens per slot: CodeRankEmbed 2048, jina 8192, Muninn 8192 |
| `trainedLanguages` | from the model card                                         |

Sources: jina → `ggml-org/jina-embeddings-v2-base-code-Q8_0-GGUF`. CodeRankEmbed
→ a public Q8_0 GGUF pinned by revision and sha256 (Q8_0 is what was measured).
Muninn-small has no public GGUF; we convert it once (f16) and publish it under
the project's Hugging Face account. Publishing is an outward-facing action the
user performs. Until the catalog entry carries a published source, the Muninn
row of the table falls through to CodeRankEmbed — the next-best measured model
on Muninn's own TypeScript corpus (0.918).

Rejected: converting on the user's machine with `convert_hf_to_gguf.py`. It
needs python, `transformers`, `torch`, and a tokenizer-config patch — the exact
improvisation from the transcript (6).

## CLI components

### Native asset installer (shared)

One module downloads a pinned release asset, verifies sha256, unpacks into a
temporary sibling directory and renames it into place (atomic publish), and
skips the download when the target already verifies. It follows `downloadQdrant`
(`src/core/adapters/qdrant/embedded/download.ts`), which the npm postinstall
already uses. Pins and hashes live in a checked-in manifest generated by a
script, never typed by hand.

### `tea-rags llama-server install [--backend auto|metal|cuda|vulkan|rocm|cpu]`

- Pins one llama.cpp build (currently b12032) and maps OS/arch/backend to its
  asset: `macos-arm64` (Metal), `macos-x64`, `ubuntu-{x64,arm64}`,
  `ubuntu-vulkan-{x64,arm64}`, `ubuntu-cuda-13.4-{x64,arm64}`,
  `ubuntu-rocm-10.0-x64`, `win-cpu-{x64,arm64}`, `win-vulkan-x64`,
  `win-cuda-13.4-x64` (plus the matching `cudart-llama-bin-win-cuda-13.4-x64`),
  `win-rocm-10.0-x64`.
- `auto` probes `nvidia-smi`, `rocminfo`, `vulkaninfo` in that order; macOS
  arm64 is always Metal; nothing found → CPU.
- Installs to `~/.tea-rags/llama.cpp/<build>-<backend>/` and prints the binary
  path. Discovery order for every llama-server consumer: `LLAMA_SERVER_PATH` env
  → the managed install → `PATH` (fixes 7).

### `tea-rags llama-server fetch-model <id>`

Resolves `<id>` in the catalog and downloads the GGUF from Hugging Face into
`~/.tea-rags/models/<file>`, sha256-verified. The Ollama-registry path stays for
references the catalog does not know.

### Pools: `tea-rags llama-server start|stop|status|bench`

- A pool is one model served by N instances.
  `start --model <id> [--instances N|auto]` spawns N detached `llama-server`
  processes on random free ports in 20000–29999 bound to `127.0.0.1`, waits for
  `/health`, verifies `/props` reports the expected model, and records the pool
  in `~/.tea-rags/llama-server/pools.json` (pid, port, model, args, log path).
- Launch args per instance: hardware-profile `-ngl`, `-fa`, `-np`;
  `-c = np × window`, `-b = -ub = window` from the catalog.
- `status` reports each pool's instances (alive, port, model, slots); `stop`
  terminates a pool or all.
- `bench` embeds a fixed synthetic corpus at 1..K instances and returns texts/s
  per count; `--instances auto` takes the smallest count within 5% of the best,
  minimum 2.
- The default host of the existing `llama-server command` sheet becomes
  `127.0.0.1` (fixes 10).
- **Restart after reboot.** Pools are started on demand rather than as OS
  services: when the embedding endpoints of a project resolve to a pool in
  `pools.json` and none answers, the server or CLI process restarts that pool
  from its record before embedding. Rejected: launchd, systemd `--user` and Task
  Scheduler units — three platform-specific generators, and Windows needs
  elevated rights for some trigger types.

### `tea-rags rustc-driver install`

- CI builds the driver for darwin-arm64, darwin-x64, linux-x64, linux-arm64 and
  windows-x64 on each release and attaches the archives to the GitHub Release
  with a sha256 manifest.
- `install` downloads the archive for the current platform into the existing
  cache `${dataDir}/rustc-driver/bin/<pin>-<sourceHash>/` — discovery already
  checks this path third, so discovery code is unchanged.
- The driver links `librustc_driver` of the pinned nightly
  (`RUSTC_DRIVER_TOOLCHAIN_PIN`). `install` therefore also installs that
  toolchain with `--profile minimal` through rustup, with `RUSTUP_HOME` and
  `CARGO_HOME` under `~/.tea-rags/rust/` so the user's own toolchains are
  untouched. Whether `rustc-dev`/`rust-src` are needed at runtime is verified by
  the CI smoke job on a clean runner; the default is minimal.
- npm `postinstall` runs the driver download best-effort, like Qdrant (fixes 13,
  14).

### Rust workspace roots (fixes 15)

The driver run discovers every `Cargo.toml` that is a workspace root (or a
standalone package not inside a workspace) under the project, and runs
`cargo check` per root with `--manifest-path`. `Cargo.lock` and `cargo fetch`
follow the same roots.

## Install skill

One skill, one step, the same flow for Claude Code, Cursor and Codex. Helper
scripts are Node (`.mjs`), since Node ≥ 22 (the package `engines` floor) is a
prerequisite anyway; the bash and PowerShell twins go away.

1. **Detect** (`detect.mjs`, JSON out): OS, arch, RAM, GPU backend, Node
   version, harness, installed `tea-rags` version, existing registry entry for
   the project.
2. **Ignore** (`contextignore.mjs`): writes `.contextignore.local` with the
   project's generated and vendored paths — build outputs per detected stack
   (`target/`, `.svelte-kit/`, `dist/`, `build/`, `.next/`, `vendor/`, …),
   lockfiles, minified assets, generated code markers — merged with any existing
   file, never overwriting user lines (fixes 12).
3. **Profile** (`profile.mjs`): LOC and language shares over `git ls-files`
   minus the ignore files, extensions mapped through the same language table the
   indexer uses (fixes 11).
4. **Plan**: model by the table, hardware profile, `bench` planned, rustc driver
   only when Rust is present, estimated chunk count and first-index time. One
   `AskUserQuestion` (or the harness equivalent) with "Install" / "Change model"
   / "Cancel" (fixes 19).
5. **Apply**, in order: `npm i -g tea-rags@latest` when missing or older (fixes
   3, 5 via the Node check) → `llama-server install` → `fetch-model` →
   `llama-server start --instances auto` → `rustc-driver install` when planned →
   register the project with the pool's endpoints and the HF model id in the
   registry → install the `tea-rags` plugin (and MCP) with the harness's own
   commands, MCP config without `env`, no project-level duplicate (fixes 2, 18)
   → `tea-rags index-codebase --project <alias> --wait-enrichments --json`.
6. **Verify**: `get_index_status` through the new MCP server, one
   `semantic_search`, and a short report.

Harness plugin commands:

| Harness     | Plugin install                                                                                 |
| ----------- | ---------------------------------------------------------------------------------------------- |
| Claude Code | `claude plugin marketplace add artk0de/TeaRAGs-MCP`, `claude plugin install tea-rags@tea-rags` |
| Codex       | `codex plugin marketplace add artk0de/TeaRAGs-MCP`, `codex plugin add tea-rags@tea-rags`       |
| Cursor      | copy `harness/cursor/tea-rags` to `~/.cursor/plugins/local/tea-rags`                           |

The setup plugin itself is generated for Cursor and Codex the same way the main
plugin is (`npm run gen:plugins`), fixing 1.

The `tune` skill stays for re-tuning an existing install; the install flow no
longer calls it.

## Handled on other branches

- `/src/ → /build/` worker paths (4): `compiledModuleDir` in `primitives/paths`,
  branch `worktree-agent-aa05226f00fadc4df`.
- Removal of `TRAJECTORY_GIT_SQUASH_AWARE_SESSIONS` (17): its own branch. The
  experiment found no effect or a sign flip on both corpora.

## Status defects

- **Stale driver status (16).** The driver availability shown by status and
  prime is the value stamped at the last index run. It is re-probed at read time
  through `discoverRustcDriver`, so an install shows up without a recompute.
- **Lingering `aborted` jobs (20).** An `aborted` indexing job is reported once
  and then retired from the notification set.

## Out of scope

- Ollama setup.
- Remote GPU hosts. The pool manager serves local instances only.

## Testing

- Asset tables: unit tests map every supported OS/arch/backend triple to an
  asset name and fail on an unmapped triple.
- Catalog: `dimensions` equals `MODEL_DIMENSIONS[id]` for every entry.
- Installer: download, hash mismatch, interrupted unpack (no partial target),
  already-installed skip — against a local HTTP fixture.
- Pools: port allocation in range and on loopback, `pools.json` round trip,
  restart-on-demand with a fake `llama-server` executable.
- Model choice: the language table, including the Muninn fall-through.
- Skill scripts: `contextignore.mjs` and `profile.mjs` against fixture repos
  (Rust with `target/`, SvelteKit, Ruby + JS).
- Live: a clean install on this machine per the epic completion gate,
  user-gated.

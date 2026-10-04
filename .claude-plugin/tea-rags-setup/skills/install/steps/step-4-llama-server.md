# Step 4L: llama-server Provider (GPU host)

Entered from step 4e when user picked llama-server. tea-rags NEVER launches
llama-server — `tea-rags llama-server command` only PRINTS lines; operator runs
them on GPU host. Spawns nothing, runs not even `--list-devices`.

Topology: PEERS = remote llama-server per GPU (`EMBEDDING_BASE_URL`, comma
list). FALLBACK = local llama-server on this machine (`EMBEDDING_FALLBACK_URL`).
Ollama NEVER fallback for llama-server — may not serve same model.

## 4L-a: Ask GPU host facts

AskUserQuestion, one at a time:

1. GPU host OS → `windows` | `linux` | `macos` (→ `--os`).
2. GPU host LAN address clients dial (IP or name) → `--advertise`.
3. llama-server binary path on host, PER BUILD. Build per GPU vendor: ROCm
   (AMD), Vulkan (AMD/Intel iGPU), CUDA (NVIDIA), Metal (macOS). Mixed vendors
   on one host → one binary per build → one `command` run per build.
4. Require API key? Optional. Yes → generate random key → `--api-key`.

Device ids unknown → first run WITHOUT `--device`: sheet prints one default
launch line + hint `<bin> --list-devices`. Operator runs hint on host, reports
ids, re-run with `--device <id>` per GPU (repeat flag; one port each).

Save to progress key `llamaServer` (JSON: `os`, `advertise`, `builds[]` of
`{bin, devices}`) — tune skill re-prints from it.

## 4L-b: Print GPU host sheet

Per build:

```bash
tea-rags llama-server command \
  --os <windows|linux|macos> \
  --bin <llama-server path on host> \
  --device <id> [--device <id> ...] \
  --advertise <lan-ip-or-name> \
  [--api-key <key>] \
  [--port <n>] \
  --autostart
```

Flags (yargs, exact): `--bin` (required), `--os` (default: this machine),
`--device` (repeatable), `--host` (default `0.0.0.0`), `--port` (default `8081`,
first device; next devices +1), `--slots` (default `4`, `-np`), `--model` (GGUF
path on host or Ollama ref; default `EMBEDDING_MODEL`, else jina),
`--advertise`, `--api-key`, `--autostart` (default false; prints start-at-boot
registration).

Second+ build → `--port` past previous build's range. Sheet prints, per OS:
sha256-verified GGUF download (host needs no Node, no tea-rags), launch line per
device, firewall rule, keep-awake, autostart, final `EMBEDDING_BASE_URL`. Host
sleeping = failure seen 2026-10-02 → stress keep-awake line.

Hand sheet to user verbatim. AskUserQuestion:

```
question: "Run the printed commands on the GPU host (download model, launch, firewall, keep-awake, autostart), then confirm."
options: [
  { label: "Done", description: "llama-server running on every GPU" },
  { label: "Problem", description: "Something went wrong" }
]
```

Verify each peer from this machine: `curl -sf http://<advertise>:<port>/health`.
Fail → check firewall line, host awake, bind `0.0.0.0`.

Collect `EMBEDDING_BASE_URL` from each sheet's last block; multiple builds →
join lists with commas, one URL per GPU.

## 4L-c: Local fallback

Needs llama-server binary on THIS machine — ask path (macOS: Homebrew
`llama-server` Metal build). Then:

```bash
tea-rags llama-server fetch-model            # GGUF → ~/.tea-rags/models/gguf, prints path last
tea-rags llama-server command --os <local-os> --host 127.0.0.1 --bin <local llama-server> --model <path from fetch-model> [--port <n>] [--autostart]
```

`fetch-model [model] [--dir <d>]` — model default `EMBEDDING_MODEL`, else jina;
`--dir` default `~/.tea-rags/models/gguf` (honours `TEA_RAGS_DATA_DIR`). Port
collides with local service → pass `--port`. Hand local lines to user, verify
`curl -sf http://127.0.0.1:<port>/health`. Its URL → `EMBEDDING_FALLBACK_URL`.

User declines local fallback → omit `EMBEDDING_FALLBACK_URL`; warn: all peers
down = indexing waits.

## 4L-d: Save

```bash
$SCRIPTS/progress.sh set embeddingProvider "llama-server"
$SCRIPTS/progress.sh set embeddingBaseUrl "http://host:8081,http://host:8082"
$SCRIPTS/progress.sh set embeddingFallbackUrl "http://127.0.0.1:8081"   # if set
$SCRIPTS/progress.sh set embeddingApiKey "<key>"                         # if --api-key used
```

Step 8 writes these as `EMBEDDING_PROVIDER`, `EMBEDDING_BASE_URL`,
`EMBEDDING_FALLBACK_URL`, `EMBEDDING_API_KEY` (see `reference.md` env table).

Context: `-c = slots*8192` printed by `command` — 8192 per slot for jina. Never
hand-edit `-c`/`-b`/`-ub`: changes chunk size → `--force` reindex.

Mark step 4 completed → step 5.

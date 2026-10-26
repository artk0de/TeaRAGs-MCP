# Step 4L: llama-server Provider (GPU host)

Entered from step 4e when user picked llama-server. tea-rags NEVER launches
llama-server — `tea-rags llama-server command` only PRINTS lines; operator runs
them on GPU host. Spawns nothing, runs not even `--list-devices`.

Topology: PEERS = remote llama-server per GPU (`EMBEDDING_BASE_URL`, comma
list). FALLBACK = local llama-server on this machine (`EMBEDDING_FALLBACK_URL`).
Ollama NEVER fallback for llama-server — may not serve same model.

User picked "llama-server (this Mac)" → §4L-local only, skip 4L-a…4L-d.

## 4L-local: this Mac = embedding server

Apple Silicon (darwin + arm64, Metal). Local instances ARE the server: no GPU
host, no `EMBEDDING_FALLBACK_URL`, Ollama never fallback. CLI still only PRINTS;
skill runs printed lines via Bash after ONE consent (step 5).

1. **Binary.** Default `/opt/homebrew/bin/llama-server`; check `test -x`.
   Missing → AskUserQuestion "Install llama.cpp via Homebrew?" → yes →
   `brew install llama.cpp` (hasBrew=false → "Install Homebrew first:
   https://brew.sh", re-ask). Other path → user gives it.
2. **Model.** AskUserQuestion:
   ```
   question: "Embedding model for llama-server?"
   options: [
     { label: "jina v2 code (default)", description: "unclemusclez/jina-embeddings-v2-base-code:latest — tea-rags default, 8192-token window" },
     { label: "CodeRankEmbed", description: "nomic-ai/CodeRankEmbed — +0.06 to +0.19 MRR over jina, 2048-token window, not in the Ollama library" },
     { label: "Other Ollama ref", description: "Any Ollama library ref, e.g. namespace/name:tag" }
   ]
   ```

   - jina → `tea-rags llama-server fetch-model`. Other ref →
     `tea-rags llama-server fetch-model <ref>`. LAST printed line = GGUF path.
   - CodeRankEmbed → no Ollama ref, `fetch-model` can't get it. User downloads
     Q8_0 GGUF from https://huggingface.co/handwoven8588/CodeRankEmbed-GGUF into
     `~/.tea-rags/models/gguf/` (or converts `nomic-ai/CodeRankEmbed` with
     llama.cpp `convert_hf_to_gguf.py`), gives path. File name MUST contain
     `CodeRankEmbed` — served-model check retires endpoint otherwise.
   - Save `embeddingModel`: CodeRankEmbed → `nomic-ai/CodeRankEmbed`; other ref
     → `<ref>`; jina → omit (default).
   - `command` reads model window from GGUF header: per slot = min(8192,
     context_length); prints `# Warning: ... context window` line when < 8192
     (CodeRankEmbed: 2048). Expected, not error.
3. **Instance count.** Default 2 (M3 Pro: ×1 82, ×2 93.5, ×3 92 texts/s — third
   adds nothing). AskUserQuestion confirm or other N.
4. **Ports — USER decides.** Propose N consecutive ports from 8080. Per
   candidate: `lsof -nP -iTCP:<p> -sTCP:LISTEN` — output = busy → skip to next
   free port, never propose busy one. Stay near 8080; never jump silently to
   unfamiliar range. AskUserQuestion: "Use ports <p1>, <p2>?" → options "Use
   these" / "Enter my own list". Own list → re-check each with `lsof`, busy →
   say so, re-ask.
5. **Print, consent, start.** Per port:
   ```bash
   tea-rags llama-server command --os macos --host 127.0.0.1 --port <p> \
     --bin <bin> --model <gguf> --autostart
   ```
   Show ALL sheets. ONE AskUserQuestion for whole batch: "Run these lines now?
   They write a LaunchAgent per port and start llama-server at login." → yes →
   run via Bash each sheet's §"Start at boot" lines (`mkdir`, plist heredoc,
   `launchctl bootout … || true`, `launchctl bootstrap`) — port by port.
   Instance N+1 starts ONLY after instance N healthy: poll
   `curl -sf http://127.0.0.1:<p>/health` every 2 s, max 30 tries. Never healthy
   → stop, show `tail -n 40 ~/.tea-rags/logs/llama-server-<p>.log`,
   AskUserQuestion retry / abort. No → hand sheets to user, wait "Done", then
   same health checks. Remind sheet's BTM line: System Settings > General >
   Login Items > Allow in the Background → enable `llama-server`, else no start
   at login. Check: `sfltool dumpbtm | grep -A3 llama-server`. Re-run safe:
   `bootout` before `bootstrap` replaces loaded agent.
6. **Result.** `EMBEDDING_BASE_URL=<p1>,<p2>` (bare ports = localhost). NO
   `EMBEDDING_FALLBACK_URL`.
   ```bash
   $SCRIPTS/progress.sh set embeddingProvider "llama-server"
   $SCRIPTS/progress.sh set embeddingBaseUrl "8080,8081"
   $SCRIPTS/progress.sh set embeddingModel "nomic-ai/CodeRankEmbed"   # if not jina
   $SCRIPTS/progress.sh set llamaServer.local '{"bin":"<bin>","model":"<ref or nomic-ai/CodeRankEmbed>","gguf":"<path>","ports":[8080,8081]}'
   ```
   Tune skill re-prints from `llamaServer.local`.
7. **Uninstall** (tell user, don't run). Per port:
   ```bash
   launchctl bootout gui/$(id -u)/com.tea-rags.llama-server.<p>
   rm ~/Library/LaunchAgents/com.tea-rags.llama-server.<p>.plist
   ```

Mark step 4 completed → step 5.

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
sleeping = known failure → stress keep-awake line.

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

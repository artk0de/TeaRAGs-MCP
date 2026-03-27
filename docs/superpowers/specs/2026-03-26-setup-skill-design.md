# Setup Skill Design

**Date**: 2026-03-27 **Status**: Approved **Scope**: `plugin/skills/setup/`,
`plugin/scripts/setup/`

## Problem

Installing TeaRAGs requires multiple manual steps: Node.js, npm package,
embedding provider (Ollama or ONNX), Qdrant, MCP configuration. Each step has
platform-specific variations, version manager nuances, and failure modes. Users
must read documentation, run commands in order, and configure environment
variables correctly. This creates friction and errors.

## Solution

A modular `/tea-rags:setup` skill that automates the entire installation through
scripts orchestrated by an agent. Progress persists in
`~/.tea-rags/setup-progress.json` so the process can be resumed after
interruptions.

## Architecture

**SKILL.md** — agent orchestrator. Reads progress, calls scripts, interprets
JSON output, interacts with user via AskUserQuestion for choices and
checkpoints. Determines platform and selects the appropriate script set (.sh or
.ps1).

**Bash scripts** (`plugin/scripts/setup/unix/`) — for macOS and Linux.

**PowerShell scripts** (`plugin/scripts/setup/windows/`) — for Windows without
WSL.

Contract is identical: same inputs, same JSON output, same exit codes (0 =
success, 1 = error, 2 = user action required). JSON to stdout, errors to stderr.

```
plugin/
  skills/
    setup/
      SKILL.md
  scripts/
    setup/
      unix/
        detect-environment.sh
        install-node.sh
        install-tea-rags.sh
        install-ollama.sh
        setup-qdrant.sh
        tune.sh
        analyze-project.sh
        configure-mcp.sh
        progress.sh
      windows/
        detect-environment.ps1
        install-node.ps1
        install-tea-rags.ps1
        install-ollama.ps1
        setup-qdrant.ps1
        tune.ps1
        analyze-project.ps1
        configure-mcp.ps1
        progress.ps1
```

**Script set selection**: first action in SKILL.md is to determine the OS.
Windows → `setup/windows/`, otherwise → `setup/unix/`. This is the only
platform-dependent logic in the orchestrator.

## Installation Steps

```
1. detect      — platform, arch, version managers, package manager, node path, GPU
2. node        — install Node.js 22+ if missing
3. tea-rags    — install -g tea-rags via detected package manager
4. embedding   — choose provider → install if needed
5. qdrant      — choose mode → install if needed
6. tune        — npx tea-rags tune → optimal batch/concurrency settings
7. analyze     — git repo analysis → recommend env vars
8. configure   — claude mcp add with all env vars
9. verify      — claude mcp get → connected
```

**Step 4 (embedding)**: user chooses Ollama or ONNX.

- **Ollama** — separate service. Mac/Win: download app (Metal/DirectML GPU).
  Linux: curl script. After install — pull model.
- **ONNX (beta)** — embedded daemon process inside tea-rags, no external
  services required. GPU acceleration: DirectML (Windows), Vulkan (Linux).
  **macOS: CPU only (Metal not supported).** Suitable for projects up to ~100k
  LOC. Model downloads on first run (~260 MB).

**Project size detection**: before the embedding choice, the script estimates
LOC of the current project. If project > 100k LOC and user picks ONNX — warning:
"Project ~{N}k LOC. ONNX is recommended for up to ~100k LOC, indexing may be
slow. Ollama recommended."

**Project directory**: if Claude is running outside a project directory (e.g.,
`~`), the skill asks via AskUserQuestion: "Specify the project directory you are
configuring tea-rags for" — open-ended input. Path is saved to progress and used
in analyze and configure steps.

**GPU detection**: the detect script identifies the user's GPU and evaluates
compatibility with both providers.

- macOS: `system_profiler SPDisplaysDataType`
- Windows: `Get-CimInstance Win32_VideoController`
- Linux: `lspci | grep -i vga`

Determines vendor (apple/nvidia/amd/intel/none), model, architecture (RDNA2/
RDNA3 for AMD).

**Embedding provider recommendation by platform, GPU, and project size:**

| Platform              | GPU                    | Project   | Recommendation          | Why                                  |
| --------------------- | ---------------------- | --------- | ----------------------- | ------------------------------------ |
| macOS (Apple Silicon) | M1-M4                  | any       | **Ollama app**          | Metal GPU, ONNX is CPU-only on Mac   |
| Linux                 | NVIDIA                 | any       | **Ollama**              | Native CUDA                          |
| Linux                 | AMD                    | any       | **Ollama** (ROCm)       | GPU acceleration via ROCm            |
| Linux                 | none                   | ≤100k LOC | **ONNX (beta)**         | Zero-setup, CPU fallback             |
| Linux                 | none                   | >100k LOC | **Ollama**              | CPU Ollama faster for large projects |
| Windows               | NVIDIA                 | any       | **Ollama app**          | CUDA                                 |
| Windows               | AMD RDNA2/3            | any       | **Ollama + PRO driver** | GPU via Radeon PRO Software          |
| Windows               | AMD pre-RDNA2          | ≤100k LOC | **ONNX (beta)**         | DirectML, PRO driver not supported   |
| Windows               | Intel                  | ≤100k LOC | **ONNX (beta)**         | DirectML                             |
| Windows               | none / Intel / old AMD | >100k LOC | **Ollama app**          | CPU Ollama faster for large projects |

**AMD Windows flow**: detect GPU model → determine RDNA generation → if RDNA2/3:
recommend Ollama + PRO driver (show link to
https://www.amd.com/en/support/professional-graphics, AskUserQuestion checkpoint
"install PRO driver, respond when done", verify `ollama --version` + GPU usage).
If pre-RDNA2: recommend ONNX (DirectML works with broader AMD support).

**Step 5 (qdrant)**: user chooses embedded (recommended) / Docker / native. Each
option is installed fully: embedded — verify binary, Docker — `docker run` +
healthz, native — brew/apt/binary per platform + healthz.

**Step 6 (tune)**: runs `npx tea-rags tune` with env vars of chosen provider.
Parses result for EMBEDDING_BATCH_SIZE, QDRANT_UPSERT_BATCH_SIZE,
INGEST_PIPELINE_CONCURRENCY. For ONNX — requires benchmark extension (separate
task). If tune doesn't support the provider — skipped, default values used.

**Step 7 (analyze)**: if the project is a git repo, analyzes `git log` of last
200 commits. Determines dominant author, median gap between commits. Recommends
TRAJECTORY_GIT_ENABLED=true and TRAJECTORY_GIT_SQUASH_AWARE_SESSIONS=true if
median gap < 30 minutes. Determines project size (files, LOC) for
MAX_TOTAL_CHUNKS recommendations.

**Step 8 (configure)**: agent assembles JSON from results of steps 4-7, passes
to configure-mcp. Script builds and executes
`claude mcp add tea-rags -s user -- npx tea-rags server -e KEY=VAL ...`.

**Step 9 (verify)**: `claude mcp get tea-rags` → verify server is connected. If
not — ask to restart session.

## Progress File

Path: `~/.tea-rags/setup-progress.json`

```json
{
  "version": 1,
  "startedAt": "2026-03-26T12:00:00Z",
  "platform": "darwin",
  "arch": "arm64",
  "versionManager": "asdf",
  "packageManager": "npm",
  "nodePath": "/Users/x/.asdf/installs/nodejs/22.14.0/bin/node",
  "npmPath": "/Users/x/.asdf/installs/nodejs/22.14.0/bin/npm",
  "embeddingProvider": "ollama",
  "qdrantMode": "embedded",
  "projectPath": "/Users/x/my-project",
  "projectLocEstimate": 85000,
  "gpu": {
    "vendor": "apple",
    "model": "Apple M3 Pro",
    "architecture": null,
    "detectedAt": "2026-03-26T12:00:01Z"
  },
  "steps": {
    "detect": { "status": "completed", "at": "2026-03-26T12:00:01Z" },
    "node": { "status": "completed", "at": "2026-03-26T12:00:02Z" },
    "tea-rags": { "status": "completed", "at": "2026-03-26T12:00:15Z" },
    "embedding": { "status": "in_progress", "at": "2026-03-26T12:00:16Z" },
    "qdrant": { "status": "pending" },
    "tune": { "status": "pending" },
    "analyze": { "status": "pending" },
    "configure": { "status": "pending" },
    "verify": { "status": "pending" }
  }
}
```

On re-run: read progress, resume from first non-completed step. Platform, GPU,
user choices — all stored, not re-asked.

## Script Contracts

### detect-environment (.sh / .ps1)

**Input**: none **Output**:

```json
{
  "platform": "darwin",
  "arch": "arm64",
  "availableManagers": ["asdf", "fnm"],
  "activeManager": "asdf",
  "packageManager": "npm",
  "nodeVersion": "22.14.0",
  "nodePath": "/Users/x/.asdf/installs/nodejs/22.14.0/bin/node",
  "npmPath": "/Users/x/.asdf/installs/nodejs/22.14.0/bin/npm",
  "hasGit": true,
  "hasDocker": true,
  "hasOllama": false,
  "hasBrew": true,
  "gpu": {
    "vendor": "apple",
    "model": "Apple M3 Pro",
    "architecture": null
  }
}
```

**Version manager detection** — two phases:

Phase 1 — Inventory. Check `command -v` for each: volta, asdf, mise, fnm,
nodenv, n. For nvm: check `$NVM_DIR/nvm.sh` exists (nvm is a shell function, not
a binary).

Phase 2 — Identify active. Resolve `which node | xargs realpath` and match
against known paths:

| Path pattern                         | Manager |
| ------------------------------------ | ------- |
| `~/.volta/tools/image/node/`         | volta   |
| `~/.asdf/installs/nodejs/`           | asdf    |
| `~/.local/share/mise/installs/node/` | mise    |
| `~/.fnm/node-versions/`              | fnm     |
| `~/.nvm/versions/node/`              | nvm     |
| `~/.nodenv/versions/`                | nodenv  |
| `/usr/local/n/versions/node/`        | n       |

No match → `"activeManager": "none"` (system Node).

**Package manager**: check which binaries exist in the same prefix as the
resolved node binary (npm is always present; also check yarn, pnpm, bun). Use
the one that exists. If multiple exist, prefer: npm (most universal for global
installs).

**GPU detection**:

- macOS: `system_profiler SPDisplaysDataType`
- Windows: `Get-CimInstance Win32_VideoController`
- Linux: `lspci | grep -i vga`

Determines vendor (apple/nvidia/amd/intel/none), model, architecture (RDNA2/
RDNA3 for AMD).

### install-node (.sh / .ps1)

**Input**: version manager name or "none" **Output**:

```json
{
  "status": "installed|already_done|manual_required",
  "nodePath": "...",
  "nodeVersion": "..."
}
```

If Node.js is present and >= 22: `already_done`. If missing or < 22: attempt
install via the version manager. If `none` and no node: `manual_required` —
skill shows platform-specific instructions and uses AskUserQuestion checkpoint.

### install-tea-rags (.sh / .ps1)

**Input**: package manager name, path to its binary **Output**:

```json
{
  "status": "installed|already_done|error",
  "binPath": "/path/to/tea-rags",
  "version": "1.15.1"
}
```

Idempotency: check `tea-rags --version` first. If present and up-to-date →
`already_done`. If present but outdated → update.

Commands by package manager:

| PM   | Install                    | Update                         |
| ---- | -------------------------- | ------------------------------ |
| npm  | `npm install -g tea-rags`  | `npm update -g tea-rags`       |
| yarn | `yarn global add tea-rags` | `yarn global upgrade tea-rags` |
| pnpm | `pnpm add -g tea-rags`     | `pnpm update -g tea-rags`      |
| bun  | `bun add -g tea-rags`      | `bun update -g tea-rags`       |

**Permissions**: if `npm prefix -g` points to a system directory without write
access, suggest `sudo` or `npm config set prefix ~/.npm-global`.

### install-ollama (.sh / .ps1)

Called only when user chose Ollama as embedding provider. If ONNX was chosen,
the skill skips this script entirely (ONNX is bundled, no install needed).

**Input**: platform, gpu (JSON from detect) **Output**:

```json
{
  "status": "installed|already_done|manual_required",
  "method": "app|curl|pro_driver"
}
```

| Platform              | Action                                                                                                                                                                                                                                                      |
| --------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| macOS                 | `manual_required`, method `app`. Skill shows: "Download Ollama from https://ollama.com/download/mac, install to /Applications, launch." AskUserQuestion checkpoint.                                                                                         |
| Windows               | `manual_required`, method `app`. Skill shows: "Download from https://ollama.com/download, run installer." AskUserQuestion checkpoint.                                                                                                                       |
| Windows + AMD RDNA2/3 | `manual_required`, method `pro_driver`. Skill shows: "For GPU acceleration install AMD Radeon PRO driver: https://www.amd.com/en/support/professional-graphics (RDNA2: RX 6000, RDNA3: RX 7000 only). Then install Ollama app." AskUserQuestion checkpoint. |
| Linux                 | Auto-install via `curl -fsSL https://ollama.com/install.sh \| sh`.                                                                                                                                                                                          |

After install (all platforms): verify `ollama --version`, then
`ollama pull unclemusclez/jina-embeddings-v2-base-code:latest`.

If model already present in `ollama list` → skip pull.

### setup-qdrant (.sh / .ps1)

**Input**: qdrant mode (embedded, docker, native), platform **Output**:

```json
{
  "status": "installed|already_done|error",
  "mode": "embedded",
  "url": "embedded"
}
```

| Mode     | Action                                                                                                                                                                                                                                                                          |
| -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| embedded | Verify binary exists in `~/.tea-rags/qdrant/bin/`. If missing, download via the same logic as postinstall.js. Return `url: "embedded"`.                                                                                                                                         |
| docker   | Pre-check: `docker --version`. If missing → exit 2 (user action required). Run `docker run -d --name qdrant -p 6333:6333 -v qdrant_storage:/qdrant/storage qdrant/qdrant:latest`. Verify `curl http://localhost:6333/healthz` → healthy. Return `url: "http://localhost:6333"`. |
| native   | Platform-specific install + verify healthz.                                                                                                                                                                                                                                     |

**Native install by platform:**

| Platform | Command                                                                                               |
| -------- | ----------------------------------------------------------------------------------------------------- |
| darwin   | `brew install qdrant && brew services start qdrant`                                                   |
| linux    | Download binary from GitHub releases (detect arch: x86_64/aarch64), extract, run. Offer systemd unit. |
| windows  | Download .exe from GitHub releases, run.                                                              |

Each option ends with healthz verification (except embedded — verified on MCP
server start).

### tune (.sh / .ps1)

**Input**: embedding provider (ollama, onnx) **Output**:

```json
{
  "status": "completed|skipped|error",
  "values": {
    "EMBEDDING_BATCH_SIZE": "256",
    "QDRANT_UPSERT_BATCH_SIZE": "384",
    "INGEST_PIPELINE_CONCURRENCY": "4"
  }
}
```

Runs `npx tea-rags tune` with appropriate provider env vars set. Parses
`tuned_environment_variables.env` output.

**ONNX (beta)**: tune support for ONNX is a separate implementation task. The
script detects if tune supports the provider and returns `skipped` with default
values if not.

### analyze-project (.sh / .ps1)

**Input**: path to project directory **Output**:

```json
{
  "isGitRepo": true,
  "fileCount": 1200,
  "locEstimate": 85000,
  "topAuthor": "John Doe",
  "authorCommitCount": 450,
  "hasFrequentCommits": true,
  "avgGapMinutes": 12,
  "recommendedEnv": {
    "TRAJECTORY_GIT_ENABLED": "true",
    "TRAJECTORY_GIT_SQUASH_AWARE_SESSIONS": "true"
  }
}
```

**Git analysis**: `git log --format='%an %at' -200` on the target project.
Calculate time gaps between consecutive commits by dominant author. If median
gap < 30 minutes → `hasFrequentCommits: true` → recommend
`TRAJECTORY_GIT_SQUASH_AWARE_SESSIONS=true`.

**Project size**: `find <path> -type f | wc -l` for file count,
`cloc --quiet --sum-one` or `wc -l` fallback for LOC estimate.

If not a git repo → `isGitRepo: false`, skip git analysis,
`TRAJECTORY_GIT_ENABLED: "false"`.

### configure-mcp (.sh / .ps1)

**Input**: JSON object with all env vars to set. The SKILL.md (agent) assembles
this JSON from results of previous steps before calling this script. **Output**:

```json
{
  "status": "configured|error",
  "command": "claude mcp add tea-rags -s user -- ..."
}
```

Builds and executes:

```bash
claude mcp add tea-rags -s user -- npx tea-rags server \
  -e EMBEDDING_PROVIDER=ollama \
  -e EMBEDDING_BATCH_SIZE=256 \
  -e TRAJECTORY_GIT_ENABLED=true \
  ...
```

Env vars assembled from:

- Step 4 (embedding): provider, model, base URL
- Step 5 (qdrant): QDRANT_URL if not embedded
- Step 6 (tune): batch sizes, concurrency
- Step 7 (analyze): trajectory settings

### progress (.sh / .ps1)

**Actions**:

| Command                          | Description                                            |
| -------------------------------- | ------------------------------------------------------ |
| `progress init`                  | Create new progress file                               |
| `progress get`                   | Output full JSON                                       |
| `progress get <dotpath>`         | Output specific value (e.g., `steps.ollama.status`)    |
| `progress set <dotpath> <value>` | Set value (JSON for objects, plain string for scalars) |

Path: `~/.tea-rags/setup-progress.json`. Creates `~/.tea-rags/` directory if
missing.

## User Interaction Points

The skill uses AskUserQuestion for decisions and checkpoints.

### Decision points

| Step      | Question                                      | Options                                                                                                    |
| --------- | --------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| start     | Project directory (if Claude outside project) | Open-ended path input                                                                                      |
| embedding | Choose embedding provider                     | Ollama (recommended for {platform/GPU reason}), ONNX (beta, zero-setup, embedded process, up to ~100k LOC) |
| qdrant    | Choose Qdrant mode                            | Embedded (recommended, zero-setup), Docker, Native ({brew\|apt\|binary})                                   |
| analyze   | Enable git analytics?                         | Yes (recommended — git repo detected), No                                                                  |
| analyze   | Enable squash-aware sessions?                 | Yes (detected: frequent commits from {author}, median {N}min gap), No                                      |
| configure | Confirm MCP configuration                     | Show full `claude mcp add` command → Confirm, Modify                                                       |

### Checkpoints (waiting for user)

| Situation                          | Instruction                                                                       | Verification                   |
| ---------------------------------- | --------------------------------------------------------------------------------- | ------------------------------ |
| Ollama app (Mac/Win)               | "Download from https://ollama.com/download, install, launch"                      | `ollama --version`             |
| AMD PRO driver (Win + AMD RDNA2/3) | "Install Radeon PRO driver: https://www.amd.com/en/support/professional-graphics" | `ollama --version` + GPU check |
| Node.js missing                    | "Install Node.js 22+ via {method}"                                                | `node --version`               |
| Docker missing (docker qdrant)     | "Install Docker Desktop"                                                          | `docker --version`             |

After user responds "Done" → run verification command. If fails → repeat
checkpoint with specific error message.

## Error Handling

### Critical errors (block installation)

| Situation                             | Action                                                                             |
| ------------------------------------- | ---------------------------------------------------------------------------------- |
| No Node.js                            | Show install instructions for platform + version manager. Checkpoint.              |
| Node.js < 22                          | Suggest update via active version manager. Checkpoint.                             |
| `install -g tea-rags` fails           | Show stderr. Common: permissions → suggest sudo or prefix change. Retry.           |
| Ollama not responding                 | Checkpoint: "ensure Ollama is running". Verify `curl localhost:11434/api/version`. |
| Docker missing (docker qdrant chosen) | Checkpoint: "install Docker".                                                      |
| `claude mcp add` fails                | Show stderr. Possible: Claude CLI not installed.                                   |
| `claude mcp get` not connected        | Suggest session restart. If persists → show debug steps.                           |

### Non-critical (continue with fallback)

| Situation                    | Fallback                                                                |
| ---------------------------- | ----------------------------------------------------------------------- |
| tune fails                   | Skip, use default values. Record warning in progress.                   |
| Not a git repo               | Skip analyze, `TRAJECTORY_GIT_ENABLED=false`.                           |
| Version manager not detected | `activeManager: "none"`, use `which npm` directly.                      |
| ONNX model download fails    | Warn: "model downloads on first MCP server start, needs internet once". |
| GPU not detected             | Show both options without recommendation, user decides.                 |

### Edge cases

**Reinstall**: tea-rags already installed → `already_done`, show version, ask
"update?". If yes → update.

**Reconfigure**: progress shows completed steps but user wants different
embedding/qdrant. Skill asks "reconfigure?" → overwrites steps from embedding
through configure.

**Windows paths**: scripts detect shell (Git Bash/MSYS2 vs PowerShell) and
handle path conversion.

**Mac permissions**: if `npm prefix -g` → system dir without write access →
suggest `sudo` or `npm config set prefix ~/.npm-global`.

**Ollama model already pulled**: check `ollama list` before pull → skip if
present.

**Claude outside project**: if cwd has no code (e.g., `~`), skill asks for
project path before the analyze step.

## What the Skill Does NOT Do

- Install Claude Code (assumed present — we are running inside it)
- Configure remote Qdrant/Ollama (advanced setup, not first-time)
- Run indexing — that is `/tea-rags:index` after session restart
- Modify existing MCP config for other servers

## Implementation Tasks

1. `plugin/scripts/setup/unix/progress.sh` + `windows/progress.ps1` — progress
   CRUD
2. `plugin/scripts/setup/unix/detect-environment.sh` +
   `windows/detect-environment.ps1` — platform, version manager, GPU detection
3. `plugin/scripts/setup/unix/install-node.sh` + `windows/install-node.ps1` —
   Node.js installation
4. `plugin/scripts/setup/unix/install-tea-rags.sh` +
   `windows/install-tea-rags.ps1` — tea-rags global install
5. `plugin/scripts/setup/unix/install-ollama.sh` + `windows/install-ollama.ps1`
   — Ollama installation (incl. AMD PRO driver flow on Windows)
6. `plugin/scripts/setup/unix/setup-qdrant.sh` + `windows/setup-qdrant.ps1` —
   Qdrant setup by mode (embedded/docker/native)
7. `plugin/scripts/setup/unix/tune.sh` + `windows/tune.ps1` — benchmark runner
8. `plugin/scripts/setup/unix/analyze-project.sh` +
   `windows/analyze-project.ps1` — project analysis
9. `plugin/scripts/setup/unix/configure-mcp.sh` + `windows/configure-mcp.ps1` —
   MCP configuration
10. `plugin/skills/setup/SKILL.md` — agent orchestrator
11. Extend `npx tea-rags tune` to support ONNX provider (beta)
12. Plugin version bump

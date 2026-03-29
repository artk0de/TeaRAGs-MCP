---
name: install
description:
  Automated TeaRAGs installation wizard. Detects environment, installs
  dependencies (Node.js, tea-rags, Ollama/ONNX, Qdrant), tunes performance,
  configures MCP server. Progress saves to ~/.tea-rags/setup-progress.json for
  resumable installation.
argument-hint: [project path]
---

# TeaRAGs Setup Wizard

Automated installation and configuration of TeaRAGs MCP server.

## How to use this skill

1. Read the step file for the current step from `steps/`
2. Read `reference.md` when you need lookup tables (recommendations, version
   managers, env vars, defaults)
3. Execute the step
4. Move to the next step

## Script Location

All scripts are in `${CLAUDE_PLUGIN_ROOT}/scripts/setup/`.

**First: determine OS to select script set.**

Run: `uname -s` (or check via Bash tool)

- Output contains "Darwin" or "Linux" → use `unix/` scripts (`.sh`)
- Output contains "MINGW", "MSYS", "CYGWIN" → use `unix/` scripts (running in
  Git Bash)
- If PowerShell detected (Windows native) → use `windows/` scripts (`.ps1`)

Store the chosen prefix (e.g.,
`SCRIPTS="${CLAUDE_PLUGIN_ROOT}/scripts/setup/unix"`) and use it for all
subsequent script calls.

## Steps

| Step | File                        | What it does                         |
| ---- | --------------------------- | ------------------------------------ |
| 0    | `steps/step-0-progress.md`  | Check/init progress file             |
| 1    | `steps/step-1-detect.md`    | Detect environment, save to progress |
| 2    | `steps/step-2-node.md`      | Install Node.js 24+                  |
| 3    | `steps/step-3-tea-rags.md`  | Install tea-rags package             |
| 4    | `steps/step-4-embedding.md` | Choose & install embedding provider  |
| 5    | `steps/step-5-qdrant.md`    | Choose & setup Qdrant                |
| 6    | `steps/step-6-tune.md`      | Tune performance parameters          |
| 7    | `steps/step-7-git.md`       | Configure git analytics              |
| 8    | `steps/step-8-configure.md` | Configure MCP server                 |
| 9    | `steps/step-9-verify.md`    | Verify setup                         |

**Reference**: `reference.md` — recommendation tables, version manager options,
env vars, tune defaults.

## Error Recovery

At any point if a script fails (exit code 1):

1. Show the error from stderr to the user
2. The progress file retains the last successful state
3. Suggest re-running `/tea-rags-setup:install` — it will resume from the failed
   step

**Common issues to check:**

- **Network/proxy errors** (ECONNREFUSED, timeout, SSL): ask user if they're
  behind a corporate proxy. If yes: "Set proxy before re-running:
  `export HTTP_PROXY=http://proxy:port HTTPS_PROXY=http://proxy:port`"
- **Permission errors** (EACCES): suggest sudo or fix ownership
- **"command not found" after install**: suggest restarting terminal or sourcing
  shell profile (`source ~/.bashrc` / `source ~/.zshrc`)
- **jq/curl missing**: the scripts will report this explicitly — follow the
  install instructions in the error message

## Do NOT

- Run scripts without checking progress first
- Skip AskUserQuestion for user choices (embedding, qdrant)
- Proceed past a checkpoint without verification
- Modify MCP config for other servers
- Run indexing — that is `/tea-rags:index` after restart

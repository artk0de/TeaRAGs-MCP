---
name: install
description:
  Run automated TeaRAGs install wizard from scratch — detects environment,
  installs deps (Node.js, tea-rags, Ollama/ONNX, Qdrant), tunes performance,
  configures MCP server. Progress saves to ~/.tea-rags/setup-progress.json for
  resumable install. Triggers on "install tea-rags", "set up TeaRAGs MCP",
  "configure tea-rags from scratch", "поставить tea-rags в проект". NOT for
  tuning an existing install — use tune for that.
argument-hint: [project path]
---

# TeaRAGs Setup Wizard

Automated install + config of TeaRAGs MCP server.

## How to use this skill

1. Read step file for current step from `steps/`
2. Read `reference.md` for lookup tables (recommendations, version managers, env
   vars, defaults)
3. Execute step
4. Next step

## Script Location

All scripts in `${CLAUDE_PLUGIN_ROOT}/scripts/setup/`.

**First: determine OS to select script set.**

Run `uname -s` (or via Bash tool)

- Output contains "Darwin" or "Linux" → use `unix/` scripts (`.sh`)
- Output contains "MINGW", "MSYS", "CYGWIN" → use `unix/` scripts (Git Bash)
- If PowerShell detected (Windows native) → use `windows/` scripts (`.ps1`)

Store chosen prefix (e.g. `SCRIPTS="${CLAUDE_PLUGIN_ROOT}/scripts/setup/unix"`),
use for all subsequent script calls.

## Steps

| Step | File                         | What it does                          |
| ---- | ---------------------------- | ------------------------------------- |
| 0    | `steps/step-0-progress.md`   | Check/init progress file              |
| 1    | `steps/step-1-detect.md`     | Detect environment, save to progress  |
| 2    | `steps/step-2-node.md`       | Install Node.js 24+                   |
| 3    | `steps/step-3-tea-rags.md`   | Install tea-rags package              |
| 4    | `steps/step-4-embedding.md`  | Choose & install embedding provider   |
| 5    | `steps/step-5-qdrant.md`     | Choose & setup Qdrant                 |
| 6    | `steps/step-6-tune.md`       | Tune performance parameters           |
| 7    | `steps/step-7-git.md`        | Configure git analytics               |
| 8    | `steps/step-8-configure.md`  | Configure MCP server                  |
| 9    | `steps/step-9-register.md`   | Register project alias (before index) |
| 10   | `steps/step-10-verify.md`    | Verify setup                          |
| 11   | `steps/step-11-freshness.md` | Offer auto-update + worktree mode     |

**Reference**: `reference.md` — recommendation tables, version manager options,
env vars, tune defaults.

## Error Recovery

If a script fails (exit code 1):

1. Show stderr error to user
2. Progress file retains last successful state
3. Suggest re-running `/tea-rags-setup:install` — resumes from failed step

**Common issues to check:**

- **Network/proxy errors** (ECONNREFUSED, timeout, SSL): ask if behind corporate
  proxy. If yes: "Set proxy before re-running:
  `export HTTP_PROXY=http://proxy:port HTTPS_PROXY=http://proxy:port`"
- **Permission errors** (EACCES): suggest sudo or fix ownership
- **"command not found" after install**: suggest restart terminal or source
  shell profile (`source ~/.bashrc` / `source ~/.zshrc`)
- **jq/curl missing**: scripts report explicitly — follow install instructions
  in error message

## Do NOT

- Run scripts without checking progress first
- Skip AskUserQuestion for user choices (embedding, qdrant)
- Proceed past a checkpoint without verification
- Modify MCP config for other servers
- Run indexing — that is `/tea-rags:index` after restart. (Step 9 registers
  alias only — records path mapping, does NOT index.)

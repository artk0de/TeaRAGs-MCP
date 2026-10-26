---
name: install
description: >-
  Run automated TeaRAGs install wizard from scratch — detects environment,
  installs deps (Node.js, tea-rags, Ollama/ONNX/llama-server, Qdrant), tunes
  performance, configures MCP server. Progress saves to
  ~/.tea-rags/setup-progress.json for resumable install. Triggers on "install
  tea-rags", "set up TeaRAGs MCP", "configure tea-rags from scratch", "поставить
  tea-rags в проект". NOT for tuning an existing install — use tune for that.
argument-hint: [project path]
---

# TeaRAGs Setup Wizard

Automated install + config of TeaRAGs MCP server.

Per step: read `steps/<file>` → lookups in `reference.md` (recommendation
tables, version managers, env vars, tune defaults) → execute → next step.

## Invariants — state them in every install answer

Hold for every path (resume, Docker, embedded, ONNX, subagent, plan-only
answer). Name them to the user even when the step file is not read yet:

- **MCP server command = `tea-rags server`** (global binary). NEVER
  `npx tea-rags server`. Step 8 registers it; Docker Qdrant → plus `QDRANT_URL`,
  embedded → omit `QDRANT_URL`.
- **Node.js 24+** (not 22+). Lower version → upgrade; block progress until
  `node -v` ≥ 24, then re-run `detect-environment` to refresh PATH.
- **tea-rags installed globally** — `npm install -g tea-rags`. Never `npx`.
- **Embedded Qdrant** → setup triggers postinstall download via global
  `tea-rags --version` (never `npx`). Binary missing → error tells user to run
  `npm install -g tea-rags`, then retry. Docker Qdrant → no postinstall trigger.
- Read-only / subagent / "just plan it" context → still answer with the step
  sequence and these invariants; never decline to describe the wizard.

## Script Location

All scripts in `${CLAUDE_PLUGIN_ROOT}/scripts/setup/`.

**First: OS → script set.** Run `uname -s`:

- "Darwin" / "Linux" → `unix/` scripts (`.sh`)
- "MINGW" / "MSYS" / "CYGWIN" → `unix/` scripts (Git Bash)
- PowerShell (Windows native) → `windows/` scripts (`.ps1`)

Store prefix (e.g. `SCRIPTS="${CLAUDE_PLUGIN_ROOT}/scripts/setup/unix"`), use
for all script calls.

## Steps

| Step | File                           | What it does                                |
| ---- | ------------------------------ | ------------------------------------------- |
| 0    | `steps/step-0-progress.md`     | Check/init progress file                    |
| 1    | `steps/step-1-detect.md`       | Detect environment, save to progress        |
| 2    | `steps/step-2-node.md`         | Install Node.js 24+                         |
| 3    | `steps/step-3-tea-rags.md`     | Install tea-rags package                    |
| 4    | `steps/step-4-embedding.md`    | Choose & install embedding provider         |
| 4L   | `steps/step-4-llama-server.md` | llama-server: GPU host / this Mac           |
| 5    | `steps/step-5-qdrant.md`       | Choose & setup Qdrant                       |
| 6    | `steps/step-6-tune.md`         | Tune performance parameters                 |
| 7    | `steps/step-7-git.md`          | Configure git analytics                     |
| 7R   | `steps/step-7-rust-driver.md`  | Rust projects: offer rustc driver toolchain |
| 8    | `steps/step-8-configure.md`    | Configure MCP server                        |
| 9    | `steps/step-9-register.md`     | Register project alias (before index)       |
| 10   | `steps/step-10-verify.md`      | Verify setup                                |
| 11   | `steps/step-11-freshness.md`   | Offer auto-update + worktree mode           |

## Error Recovery

Script fails (exit 1) → show stderr; progress file keeps last successful state;
suggest re-running `/tea-rags-setup:install` (resumes from failed step).

**Common issues:**

- **Network/proxy** (ECONNREFUSED, timeout, SSL): ask if behind corporate proxy.
  Yes → "Set proxy before re-running:
  `export HTTP_PROXY=http://proxy:port HTTPS_PROXY=http://proxy:port`"
- **Permission** (EACCES): sudo or fix ownership
- **"command not found" after install**: restart terminal or source profile
  (`source ~/.bashrc` / `source ~/.zshrc`)
- **jq/curl missing**: scripts say so — follow install instructions in error

## Do NOT

- Run scripts without checking progress first
- Skip AskUserQuestion for user choices (embedding, qdrant)
- Run llama-server or its printed lines yourself on GPU host — print, hand to
  user. Local fallback lines: hand to user too. Only exception: §4L-local lines,
  run via Bash after ONE user consent
- Use Ollama as llama-server fallback — `EMBEDDING_FALLBACK_URL` = local
  llama-server only
- Proceed past a checkpoint without verification
- Modify MCP config for other servers
- Run indexing — `/tea-rags:index` after restart. (Step 9 registers alias only,
  does NOT index.)

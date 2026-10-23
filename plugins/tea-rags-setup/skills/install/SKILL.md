---
name: install
description:
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

## Script Location

All scripts in `${CLAUDE_PLUGIN_ROOT}/scripts/setup/`.

**First: OS → script set.** Run `uname -s`:

- "Darwin" / "Linux" → `unix/` scripts (`.sh`)
- "MINGW" / "MSYS" / "CYGWIN" → `unix/` scripts (Git Bash)
- PowerShell (Windows native) → `windows/` scripts (`.ps1`)

Store prefix (e.g. `SCRIPTS="${CLAUDE_PLUGIN_ROOT}/scripts/setup/unix"`), use
for all script calls.

## Steps

| Step | File                           | What it does                            |
| ---- | ------------------------------ | --------------------------------------- |
| 0    | `steps/step-0-progress.md`     | Check/init progress file                |
| 1    | `steps/step-1-detect.md`       | Detect environment, save to progress    |
| 2    | `steps/step-2-node.md`         | Install Node.js 24+                     |
| 3    | `steps/step-3-tea-rags.md`     | Install tea-rags package                |
| 4    | `steps/step-4-embedding.md`    | Choose & install embedding provider     |
| 4L   | `steps/step-4-llama-server.md` | llama-server: GPU host sheet + fallback |
| 5    | `steps/step-5-qdrant.md`       | Choose & setup Qdrant                   |
| 6    | `steps/step-6-tune.md`         | Tune performance parameters             |
| 7    | `steps/step-7-git.md`          | Configure git analytics                 |
| 8    | `steps/step-8-configure.md`    | Configure MCP server                    |
| 9    | `steps/step-9-register.md`     | Register project alias (before index)   |
| 10   | `steps/step-10-verify.md`      | Verify setup                            |
| 11   | `steps/step-11-freshness.md`   | Offer auto-update + worktree mode       |

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
  user. Local fallback lines: hand to user too
- Use Ollama as llama-server fallback — `EMBEDDING_FALLBACK_URL` = local
  llama-server only
- Proceed past a checkpoint without verification
- Modify MCP config for other servers
- Run indexing — `/tea-rags:index` after restart. (Step 9 registers alias only,
  does NOT index.)

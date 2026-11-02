---
name: install
description: >-
  One-step TeaRAGs install for Claude Code, Cursor and Codex: detects host,
  writes .contextignore.local, profiles languages, picks embedding model, shows
  ONE plan, confirms once, then installs tea-rags, llama-server pool, model,
  plugin + MCP server, registers and indexes the project. Triggers on "install
  tea-rags", "set up TeaRAGs", "configure tea-rags from scratch", "поставь
  tea-rags", "установи tea-rags в проект". NOT for re-tuning an existing install
  — use tune.
argument-hint: "[project path]"
---

# TeaRAGs install — one plan, one confirmation

Same flow in every harness and OS. Order fixed: detect → ignore → profile → plan
→ ONE confirmation → apply → verify. No question before the plan, none after the
confirmation.

## Invariants — every answer, plan-only included

- Embedding provider = llama-server pool, ≥ 2 instances, loopback ports the CLI
  picks (random 20000–29999). Never offer or configure Ollama.
- Model = `choose-model` result. Show its `rule` string verbatim; never derive
  the model yourself.
- MCP server = `tea-rags server` (global binary, never `npx`), config WITHOUT
  `env` — project registry holds embedding config.
- Git analytics on. No squash question.
- Indexing = FOREGROUND command, waited on. Never a detached/background shell
  job.
- Commands below are shell-neutral unless a POSIX / PowerShell pair is given.

## Paths

`<project>` = argument, else cwd (absolute). Helper scripts live in
`${CLAUDE_PLUGIN_ROOT}/scripts/`. Variable not expanded in your harness → use
the `scripts/` folder two levels above this SKILL.md
(`<this skill dir>/../../scripts`) in its place.

## Step 0 — Node prerequisite

`node --version`. Missing or major < 22 → STOP before Step 1, print the install
line for the OS, ask user to re-run after a new terminal:

| OS                    | Command                                                                                                |
| --------------------- | ------------------------------------------------------------------------------------------------------ |
| macOS (Homebrew)      | `brew install node@24`                                                                                 |
| Windows               | `winget install OpenJS.NodeJS.LTS`                                                                     |
| Linux (Debian/Ubuntu) | `curl -fsSL https://deb.nodesource.com/setup_24.x \| sudo -E bash - && sudo apt-get install -y nodejs` |
| other                 | installer from <https://nodejs.org> (v24)                                                              |

## Step 1 — Detect

`node "${CLAUDE_PLUGIN_ROOT}/scripts/detect.mjs" "<project>"` → JSON:
`{ os, arch, ramGb, gpuBackend, node: { version, ok }, teaRags: { version } | null, harness, registered: { name } | null }`.
`node.ok` false → Step 0 table, STOP. `harness` decides the Step 5 row.

Latest published client: `npm view tea-rags version`.

## Step 2 — Ignore (before any LOC count)

`node "${CLAUDE_PLUGIN_ROOT}/scripts/contextignore.mjs" "<project>"` →
`{ added, kept }`. Merges build outputs, vendored dirs, lockfiles, minified
assets into `<project>/.contextignore.local`; user lines never removed. Runs
before the profile so shares exclude generated code.

## Step 3 — Profile

`node "${CLAUDE_PLUGIN_ROOT}/scripts/profile.mjs" "<project>"` →
`{ files, loc, languages: { <lang>: { files, loc, share } }, estimatedChunks }`.

Shares JSON = `{ "<lang>": <share>, … }` from `languages`.

## Step 4 — Plan + ONE confirmation

Model — client installed:
`tea-rags llama-server choose-model --shares '<shares json>'`; client missing →
`npx -y tea-rags@latest llama-server choose-model --shares '<shares json>'`.
Windows PowerShell 5.1 strips inner quotes → escape them:
`--shares '{\"ruby\":0.06,\"typescript\":0.94}'` (PowerShell 7.3+ and POSIX
shells take the plain form). Output `{ model, rule, window, dimensions }`.

Alias = `registered.name` when present, else project folder name lowercased, non
`[a-z0-9_-]` → `-`, matching `^[a-z0-9][a-z0-9_-]{0,63}$`.

Print this block, slots filled, then ask:

```text
TeaRAGs install plan — <project>
Host:        <os>/<arch>, <ramGb> GB RAM, GPU backend <gpuBackend>, harness <harness>
Client:      tea-rags <installed version | not installed> → <latest> (npm i -g tea-rags@latest | up to date)
Project:     <files> files, <loc> LOC, ~<estimatedChunks> chunks; top languages <lang share%, …>
Ignore:      .contextignore.local +<added count> patterns
Model:       <model> (<dimensions>d, window <window>) — <rule>
Embeddings:  llama-server pool, instances by bench (≥ 2), loopback ports 20000–29999
Rust:        rustc driver install | not needed (no Rust)
Register:    alias <alias> (<new | existing — env updated>), git analytics on
Plugin+MCP:  <harness>: tea-rags plugin pinned v<latest> + MCP `tea-rags server`, no env
Index:       tea-rags index-codebase --project <alias> --wait-enrichments --json (foreground)
Thresholds:  Ruby ≥ 5% or Swift ≥ 5% → CodeRankEmbed; Muninn languages ≥ 80% → Muninn-small; else jina
```

ONE `AskUserQuestion` (no such tool → ask the user), options: `Install` /
`Change model` / `Cancel`.

- `Install` → Step 5, no further question.
- `Change model` → one pick among `nomic-ai/CodeRankEmbed`,
  `jinaai/jina-embeddings-v2-base-code`, `brokkai/Muninn-small`; the pick IS the
  confirmation → Step 5 with that model.
- `Cancel` → stop; `.contextignore.local` stays (harmless, user-editable).

## Step 5 — Apply, in order, stop on first failure

Each command foreground, waited on (long ones: timeout ≥ 10 min).

1. Client missing or older than latest → `npm i -g tea-rags@latest`; then
   `tea-rags --version` = `<ver>`. Say once: "Client auto-update is ON (runs
   from `tea-rags prime`); turn off: `tea-rags update --auto off`."
2. `tea-rags llama-server install`
3. `tea-rags llama-server fetch-model <model>`
4. `tea-rags llama-server start --model <model> --instances auto` → JSON
   `{ model, endpoints, instances, bench }`. `<endpoints>` = `endpoints` joined
   with `,`.
5. Rust in profile → `tea-rags rustc-driver install`, then
   `tea-rags rustc-driver status`.
6. Register (registry = env source of truth):
   - new:
     `tea-rags projects register --path "<project>" --name <alias> --env EMBEDDING_PROVIDER=llama-server --env "EMBEDDING_BASE_URL=<endpoints>" --env EMBEDDING_MODEL=<model> --env TRAJECTORY_GIT_ENABLED=true`
   - existing alias:
     `tea-rags projects set-env --name <alias> EMBEDDING_PROVIDER=llama-server "EMBEDDING_BASE_URL=<endpoints>" EMBEDDING_MODEL=<model> TRAJECTORY_GIT_ENABLED=true`
7. Plugin + MCP, block for `harness` (pin = `v<ver>`, never a branch):
   - Claude Code — three commands, in order:
     `claude plugin marketplace add https://github.com/artk0de/TeaRAGs-MCP.git#v<ver>`
     → `claude plugin install tea-rags@tea-rags --scope user` →
     `claude mcp add --scope user tea-rags -- tea-rags server`.
   - Codex — plugin ships the MCP server:
     `codex plugin marketplace add artk0de/TeaRAGs-MCP --ref v<ver> --sparse .agents --sparse harness/codex`
     → `codex plugin add tea-rags@tea-rags`.
   - Cursor — no marketplace CLI; plugin ships the MCP server. Copy
     `<npm root -g>/tea-rags/harness/cursor/tea-rags` into
     `~/.cursor/plugins/local/`. POSIX:
     `cp -R "$(npm root -g)/tea-rags/harness/cursor/tea-rags" ~/.cursor/plugins/local/`
     · PowerShell:
     `Copy-Item -Recurse "$(npm root -g)\tea-rags\harness\cursor\tea-rags" "$HOME\.cursor\plugins\local\"`.

   Marketplace already added at another ref → `tea-rags update` re-pins it to
   `v<ver>` instead of the add. Never add an `env` block to any MCP config;
   project-level MCP entry for tea-rags (`<project>/.mcp.json`,
   `.cursor/mcp.json`) → report it as duplicate, never write one.

8. `tea-rags index-codebase --project <alias> --wait-enrichments --json` —
   foreground, timeout ≥ 60 min on large repos. Read `outcome.measured`, then
   `outcome.failed` / `outcome.degraded`.

## Step 6 — Verify

MCP server live in this session (after harness reload) →
`get_index_status(project: "<alias>")`, then one
`semantic_search(project: "<alias>", path: "<project>", query: "<main entry point concept of the top language>", limit: 3)`.
Not live yet → same calls via CLI:
`tea-rags call get_index_status '{"project":"<alias>"}'`.

Report, slots filled:

```text
TeaRAGs installed — <alias>
Model:     <model> on <instances> llama-server instances (<endpoints>)
Index:     <chunks> chunks, status <status>, enrichment <measured: ok | failed: … | degraded: …>
Search:    <top hit relativePath> — <ok | no hits>
Next:      restart / reload <harness> so the plugin hooks and MCP server load
Auto-update: on (`tea-rags update --auto off` to disable)
```

## Errors

- Command fails → show stderr, stop, fix cause, re-run from the failed command;
  completed commands need no repeat.
- Network / proxy (ECONNREFUSED, timeout, SSL) → ask about proxy; set
  `HTTPS_PROXY` (POSIX `export HTTPS_PROXY=http://host:port`, PowerShell
  `$env:HTTPS_PROXY="http://host:port"`), re-run.
- EACCES on `npm i -g` → fix npm prefix ownership or use a Node version manager;
  never `sudo npm`.
- `command not found` after install → new terminal (PATH refresh), re-run.

## Do NOT

- Ask anything before the plan or after the confirmation.
- Offer Ollama, ONNX, or a remote GPU host.
- Re-derive the model or edit the `rule` string.
- Pass `env` in an MCP config or write a project-level MCP duplicate.
- Run indexing detached (`&`, `nohup`, `Start-Process`, background job).

---
title: Installation
sidebar_position: 1
---

TeaRAGs can be installed two ways: via the **setup plugin** (recommended for
Claude Code users) or **manually** for CI, non-Claude MCP clients (Cursor, Roo
Code, Continue, …), or air-gapped setups.

:::tip Rust projects: install the compiler driver
Without it, Rust call-graph edges are static-only (resolution rate 0.54-0.71
instead of 0.98-0.99 on tikv, servo, ripgrep). One command:
`tea-rags rustc-driver install` downloads the prebuilt driver from GitHub
Releases and a managed toolchain. The setup plugin runs it when the project
contains Rust. Details:
[Rust compiler driver](../usage/advanced/codegraph-enrichments.md#rust-compiler-driver).
:::

## Option A — via the Setup Plugin (recommended)

The `tea-rags-setup` plugin installs and configures everything in one confirmed
plan. `/tea-rags-setup:install` does, in order: detect the environment, write
`.contextignore`, profile the project's languages, choose the embedding model,
start a local llama-server pool, install the Rust compiler driver when the
project contains Rust, register the MCP server, and index the project in the
foreground. It shows the whole plan and asks once before running it.

**Step 1 — Add the TeaRAGs marketplace to Claude Code:**

```
/plugin marketplace add artk0de/TeaRAGs-MCP
```

**Step 2 — Install the setup plugin:**

```
/plugin install tea-rags-setup@tea-rags
```

**Step 3 — Run the installer:**

```
/tea-rags-setup:install
```

The model is picked from the project's language mix (see
[Embedding model choice](../config/embedding-model-choice.md#choosing-by-language-mix)),
and the llama-server binary and model files are downloaded and sha256-verified
by the CLI (see [llama-server](../config/providers/llama-server.md#managed-local-pools)).

**Step 4 — Install the skills plugin** (final step, Claude Code only):

```
/plugin install tea-rags@tea-rags
```

This plugin is Claude Code-specific and ships the skills
(`/tea-rags:explore`, `/tea-rags:bug-hunt`, `/tea-rags:index`, …). Other MCP
clients can talk to the `tea-rags` server directly without this plugin.

Restart Claude Code so it loads the new skills.

:::tip No containers, no build step
Qdrant is **embedded** — a native binary downloads automatically. No Docker or
Podman required. `tea-rags` is installed as a global CLI — no repo to clone.
:::

## Option B — Manual Install

Use this for CI, non-Claude MCP clients, air-gapped environments, or full
control over the setup.

### B.1. Install Node.js 24+

<details>
<summary>macOS</summary>

```bash
# Homebrew (recommended)
brew install node@24

# Or a version manager
brew install fnm && fnm install 24 && fnm default 24
```

Alternatives: `brew install mise` / `asdf` / `nodenv`, or
`curl https://get.volta.sh | bash`.

</details>

<details>
<summary>Linux / WSL (Debian/Ubuntu)</summary>

```bash
# NodeSource (system-wide)
curl -fsSL https://deb.nodesource.com/setup_24.x | sudo -E bash -
sudo apt-get install -y nodejs

# Or fnm (user-level)
curl -fsSL https://fnm.vercel.app/install | bash
fnm install 24 && fnm default 24
```

Alternatives: `curl https://mise.run | sh`,
`curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.3/install.sh | bash`.

</details>

<details>
<summary>Windows (PowerShell)</summary>

```powershell
# winget (recommended)
winget install OpenJS.NodeJS.LTS

# Or fnm (version manager)
winget install Schniz.fnm
fnm install 24
fnm default 24
```

Alternatives: `winget install Volta.Volta`,
`winget install CoreyButler.NVMforWindows`, or download from
[nodejs.org](https://nodejs.org).

</details>

Verify: `node --version` prints `v24.x.x`.

### B.2. Install `tea-rags`

```bash
npm install -g tea-rags
# or: pnpm add -g tea-rags | yarn global add tea-rags | bun add -g tea-rags
```

Verify: `tea-rags --version`.

:::tip `EACCES` on macOS/Linux?
Either use `sudo npm install -g tea-rags`, or set a user-writable prefix:

```bash
npm config set prefix ~/.npm-global
export PATH=~/.npm-global/bin:$PATH
```
:::

### B.3. Pick an Embedding Provider

For a local setup without Ollama, `tea-rags llama-server install` and
`tea-rags llama-server start --model <id> --instances auto` give you a managed
pool; see [llama-server](../config/providers/llama-server.md#managed-local-pools).

| Provider                  | When to use                                                              | Install                                                      |
| ------------------------- | ------------------------------------------------------------------------ | ------------------------------------------------------------ |
| **Ollama** (recommended)  | macOS (Apple Silicon), Linux/WSL + NVIDIA/AMD, any CPU host              | see below                                                    |
| **ONNX** (built-in, beta) | Windows (DirectML GPU), small projects (≤100k LOC), no external process  | nothing to install — pass `-e EMBEDDING_PROVIDER=onnx`       |
| **OpenAI**                | Cloud preferred, no local GPU                                            | no local install — set `OPENAI_API_KEY`                      |
| **Cohere / Voyage AI**    | Cloud, code-tuned models                                                 | no local install — set `COHERE_API_KEY` / `VOYAGE_API_KEY`   |

Platform-specific recommendations (from the setup plugin):

| Platform              | GPU            | LOC    | Recommended                               |
| --------------------- | -------------- | ------ | ----------------------------------------- |
| macOS (Apple Silicon) | apple          | any    | Ollama (Metal)                            |
| macOS (Intel)         | intel          | ≤100k  | ONNX (CPU)                                |
| macOS (Intel)         | intel          | >100k  | Ollama (CPU)                              |
| Linux / WSL           | nvidia         | any    | Ollama (CUDA)                             |
| Linux                 | amd            | any    | Ollama (ROCm)                             |
| Linux / WSL           | none / intel   | ≤100k  | ONNX (CPU)                                |
| Linux / WSL           | none / intel   | >100k  | Ollama (CPU)                              |
| Windows               | nvidia         | any    | ONNX (DirectML) or Ollama (CUDA)          |
| Windows               | amd (RDNA2/3)  | any    | ONNX (DirectML) or Ollama + PRO driver    |
| Windows               | amd/intel/none | any    | ONNX (DirectML or CPU)                    |

<details>
<summary>Install Ollama + pull the default model</summary>

```bash
# macOS / Linux / WSL
curl -fsSL https://ollama.com/install.sh | sh

# Windows (winget)
winget install Ollama.Ollama
```

Pull the default code-embedding model (~270 MB):

```bash
ollama pull unclemusclez/jina-embeddings-v2-base-code:latest
```

Verify: `curl -s http://localhost:11434/api/tags` lists the model.

**AMD on Windows (RDNA2 / RDNA3):** install the
[AMD Radeon PRO driver](https://www.amd.com/en/support/professional-graphics)
before Ollama for GPU acceleration.

</details>

<details>
<summary>Use ONNX (built-in, no install)</summary>

No install needed. At Step B.4, register the MCP server with
`-e EMBEDDING_PROVIDER=onnx`. ONNX runs inside the MCP process — no Ollama, no
Docker. Best for Windows (DirectML GPU) and projects up to ~100k LOC on CPU.

</details>

<details>
<summary>Use OpenAI / Cohere / Voyage (cloud)</summary>

No local install. At Step B.4, register with the provider and key:

```bash
-e EMBEDDING_PROVIDER=openai  -e OPENAI_API_KEY=sk-...
# or
-e EMBEDDING_PROVIDER=cohere  -e COHERE_API_KEY=...
# or
-e EMBEDDING_PROVIDER=voyage  -e VOYAGE_API_KEY=...
```

</details>

### B.4. Register the MCP Server

For Claude Code — env vars are `claude mcp add` flags, so they go **before** `--`:

```bash
# Ollama (defaults — Qdrant embedded, Ollama on localhost:11434)
claude mcp add tea-rags -s user -- tea-rags

# ONNX
claude mcp add tea-rags -s user \
  -e EMBEDDING_PROVIDER=onnx \
  -- tea-rags

# OpenAI
claude mcp add tea-rags -s user \
  -e EMBEDDING_PROVIDER=openai \
  -e OPENAI_API_KEY=sk-... \
  -- tea-rags
```

For other MCP clients (Cursor, Roo Code, Continue, …), add this to your
`mcpServers` JSON config:

```json
{
  "mcpServers": {
    "tea-rags": {
      "command": "tea-rags",
      "env": {
        "EMBEDDING_PROVIDER": "onnx"
      }
    }
  }
}
```

Qdrant starts automatically (embedded). For external Qdrant or Qdrant Cloud,
see [Connect to an Agent](/quickstart/connect-to-agent).

### B.5. (Claude Code only) Install the skills plugin

Once the MCP server is registered, install the skills plugin to get
`/tea-rags:*` slash-commands:

```
/plugin marketplace add artk0de/TeaRAGs-MCP
/plugin install tea-rags@tea-rags
```

## Next Steps

- [Connect to an Agent](/quickstart/connect-to-agent) — remote Qdrant,
  Qdrant Cloud, HTTP transport, provider overrides
- [Create Your First Index](/quickstart/create-first-index) — index a codebase
- [Skills](/usage/skills) — playbooks the skills plugin activates

## Keeping up to date

Automatic client updates are on by default: `tea-rags prime` starts a
background `tea-rags update` at most once a day, and it installs a release only
after that release is 3 days old (7 days for a major version). Turn it off with:

```bash
tea-rags update --auto off
```

`TEA_RAGS_AUTO_UPDATE=0` overrides the setting. To update by hand, run:

```bash
tea-rags update
```

Every `tea-rags update` also re-pins the Claude and Codex plugin marketplaces to
the installed version and refreshes Cursor's plugin copy. See [Keeping tea-rags
up to date](../usage/updating.md) for the full mechanics.

## Build from Source (contributors)

<details>
<summary>For contributing to TeaRAGs itself</summary>

```bash
git clone https://github.com/artk0de/TeaRAGs-MCP.git
cd TeaRAGs-MCP
npm install && npm run build
claude mcp add tea-rags -s user -- node "$PWD/build/index.js"
```

Then install an embedding provider per [B.3](#b3-pick-an-embedding-provider).
Qdrant auto-starts (embedded). This path is for contributing to TeaRAGs itself
— end users should use `npm install -g tea-rags` instead.

</details>

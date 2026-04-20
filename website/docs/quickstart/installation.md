---
title: Installation
sidebar_position: 1
---

## Prerequisites

- [Claude Code](https://docs.anthropic.com/en/docs/claude-code/overview)
  installed and authenticated

That's it. The setup plugin handles everything else — Node.js runtime,
`tea-rags` binary, embedding provider, Qdrant, and MCP registration.

## Install via the Setup Plugin (recommended)

TeaRAGs ships a **Claude Code plugin** that runs an interactive installation
wizard. The wizard detects your environment, installs missing dependencies, and
wires the MCP server into Claude Code automatically.

**Step 1 — Add the TeaRAGs marketplace to Claude Code:**

```
/plugin marketplace add artk0de/TeaRAGs-MCP
```

**Step 2 — Install the setup plugin:**

```
/plugin install tea-rags-setup@tea-rags
```

This plugin installs and configures the **TeaRAGs MCP server itself** —
runtime, binary, embedding provider, Qdrant.

**Step 3 — Run the installation wizard:**

```
/tea-rags-setup:install
```

The wizard walks through 9 steps: environment detection, Node.js install,
`tea-rags` install, embedding provider choice (Ollama / ONNX / OpenAI /
Cohere / Voyage), Qdrant setup (embedded by default), performance tuning,
git analytics, MCP configuration, and verification.

Progress is saved to `~/.tea-rags/setup-progress.json` — if any step fails,
re-running `/tea-rags-setup:install` resumes from the last successful step.

**Step 4 — Install the skills plugin** (final step, Claude Code only):

```
/plugin install tea-rags@tea-rags
```

This plugin is Claude Code-specific and ships the skills
(`/tea-rags:explore`, `/tea-rags:bug-hunt`, `/tea-rags:index`, …). Other MCP
clients (Cursor, Roo Code) can use the TeaRAGs MCP server directly without
this plugin.

Restart Claude Code after Step 4 so it loads the new skills.

:::tip No containers, no build step
Qdrant is **embedded** — a native binary downloads automatically. No Docker or
Podman required. The plugin installs `tea-rags` as a global CLI, so there's no
repo to clone or build.
:::

## Next Steps

- [Connect to an Agent](/quickstart/connect-to-agent) — verify the MCP server
  is registered (the wizard does this; this page shows how to inspect/override)
- [Create Your First Index](/quickstart/create-first-index) — index a codebase
- [Skills](/usage/skills) — the agent playbooks the plugin activates

## Manual Installation

If you can't use plugins (e.g. CI/CD, non-Claude MCP client, air-gapped
environment), the
[15-Minute Guide → Step 1 → Option B](/quickstart/15-minute-guide#step-1)
covers the full manual path: Node.js install per platform (macOS / Linux /
WSL / Windows), `npm install -g tea-rags`, embedding-provider choice (Ollama
/ ONNX / OpenAI / Cohere / Voyage), and MCP registration.

For contributors building from source:

<details>
<summary>Build TeaRAGs from source</summary>

```bash
git clone https://github.com/artk0de/TeaRAGs-MCP.git
cd TeaRAGs-MCP
npm install && npm run build
claude mcp add tea-rags -s user -- node "$PWD/build/index.js"
```

Then install an embedding provider per
[15-Minute Guide → B.3](/quickstart/15-minute-guide#step-1). Qdrant auto-starts
(embedded). This path is for contributing to TeaRAGs itself — end users should
use `npm install -g tea-rags` instead.

</details>

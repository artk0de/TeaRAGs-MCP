---
title: Connect to an Agent
sidebar_position: 2
---

## Claude Code via the Setup Plugin (Recommended)

The fastest path — the `tea-rags-setup` plugin registers the MCP server for
you:

```
/plugin marketplace add artk0de/TeaRAGs-MCP
/plugin install tea-rags-setup@tea-rags
/tea-rags-setup:install
```

The wizard detects your environment, installs `tea-rags`, configures Qdrant
and embeddings, and writes the MCP entry to your Claude Code config. No manual
`claude mcp add` needed.

After the wizard finishes, install the Claude-only skills plugin:

```
/plugin install tea-rags@tea-rags
```

This is the final step — it gives your agent `/tea-rags:explore`,
`/tea-rags:bug-hunt`, and the other skills. See
[Installation](/quickstart/installation) for the full step list.

## Claude Code — Manual MCP Registration

Use this only if you installed `tea-rags` manually or want to override the
plugin's config.

```bash
# Local setup — Qdrant starts automatically (embedded), Ollama on localhost
claude mcp add tea-rags -s user -- tea-rags
```

:::tip
`QDRANT_URL` is autodetected: probes `localhost:6333` for external Qdrant, falls back to embedded. No configuration needed for local setups.
:::

:::note `claude mcp add` flag order
`-e KEY=VAL` is a `claude mcp add` option, so env vars go **before** the `--`
separator. Everything after `--` is the command and its args.
:::

### Remote Server Setup

```bash
# External Qdrant + Ollama on separate host
claude mcp add tea-rags -s user \
  -e QDRANT_URL=http://192.168.1.100:6333 \
  -e EMBEDDING_BASE_URL=http://192.168.1.100:11434 \
  -- tea-rags
```

### Qdrant Cloud

```bash
claude mcp add tea-rags -s user \
  -e QDRANT_URL=https://your-cluster.qdrant.io:6333 \
  -e QDRANT_API_KEY=your-api-key-here \
  -- tea-rags
```

## Cursor

`tea-rags call` runs a tool in-process. It does not register the server with
Cursor. Until an MCP entry exists, a Cursor chat has no TeaRAGs tools.

For every project, create `~/.cursor/mcp.json`. For one repo, use
`.cursor/mcp.json` in that repo instead:

```json
{
  "mcpServers": {
    "tea-rags": {
      "command": "tea-rags"
    }
  }
}
```

`tea-rags` must be on `PATH` (`npm install -g tea-rags`, or `npm link` from a
local checkout). Qdrant starts embedded. To pin a provider, add an `env`
object — the same keys as [below](#using-a-different-provider).

Open **Cursor Settings → MCP** and enable **tea-rags**. A chat that was already
open does not see a server added later; start a new one. The connected server
lists tools such as `search_code` and `find_symbol`.

Index the repo before asking it anything:

```bash
tea-rags index-codebase /path/to/repo --name my-app
```

`--name` is the registry alias later calls pass as `project`. A run that is
still indexing has no chunks yet, so search comes back empty.
`tea-rags call get_index_status '{"project":"my-app"}'` shows the chunk count.

With the server connected, ask the agent in ordinary language ("find the
symbol `FileScanner`", "where is the ignore list loaded"). The same tools work
from the shell without Cursor:

```bash
tea-rags call --list
tea-rags call find_symbol '{"project":"my-app","symbol":"FileScanner"}'
tea-rags call search_code '{"project":"my-app","query":"where ignore patterns are loaded"}'
```

What each tool takes is in the [MCP Tools Atlas](/usage/advanced/mcp-tools).

## HTTP Transport (Remote)

:::warning Security
When deploying HTTP transport in production:
- **Always** run behind a reverse proxy (nginx, Caddy) with HTTPS
- Implement authentication/authorization at the proxy level
- Use firewalls to restrict access to trusted networks
- Never expose directly to the public internet without protection
:::

**Start the server:**

```bash
SERVER_TRANSPORT=http SERVER_HTTP_PORT=3000 tea-rags
```

**Configure client:**

```json
{
  "mcpServers": {
    "qdrant": {
      "url": "http://your-server:3000/mcp"
    }
  }
}
```

## Using a Different Provider

```json
"env": {
  "EMBEDDING_PROVIDER": "openai",
  "OPENAI_API_KEY": "sk-..."
}
```

See [Configuration](/config/environment-variables) for all options.

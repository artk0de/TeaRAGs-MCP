---
title: Connect to an Agent
sidebar_position: 2
---

## Claude Code (Recommended)

```bash
# Local setup (Qdrant + Ollama on localhost)
claude mcp add tea-rags -s user -- node /path/to/tea-rags-mcp/build/index.js \
  -e QDRANT_URL=http://localhost:6333 \
  -e EMBEDDING_BASE_URL=http://localhost:11434
```

### Remote Server Setup

```bash
# Qdrant + Ollama on separate host
claude mcp add tea-rags -s user -- node /path/to/tea-rags-mcp/build/index.js \
  -e QDRANT_URL=http://192.168.1.100:6333 \
  -e EMBEDDING_BASE_URL=http://192.168.1.100:11434
```

### Qdrant Cloud

```bash
claude mcp add tea-rags -s user -- node /path/to/tea-rags-mcp/build/index.js \
  -e QDRANT_URL=https://your-cluster.qdrant.io:6333 \
  -e QDRANT_API_KEY=your-api-key-here \
  -e EMBEDDING_BASE_URL=http://localhost:11434
```

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
TRANSPORT_MODE=http HTTP_PORT=3000 node build/index.js
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
  "OPENAI_API_KEY": "sk-...",
  "QDRANT_URL": "http://localhost:6333"
}
```

See [Configuration](/config/environment-variables) for all options.

---
title: Installation
sidebar_position: 1
---

## Prerequisites

- Node.js 22+

:::tip No Docker required
Qdrant is **built-in** — TeaRAGs automatically downloads and manages a Qdrant binary. Docker is only needed if you prefer to run Qdrant externally.
:::

## Install

```bash
# Clone and install
git clone https://github.com/artk0de/TeaRAGs-MCP.git
cd TeaRAGs-MCP
npm install

# Build
npm run build
```

Qdrant starts automatically on first use. You only need an embedding provider (Ollama recommended):

```bash
# Install and pull the default embedding model
ollama pull unclemusclez/jina-embeddings-v2-base-code:latest
```

<details>
<summary>Using Docker for Qdrant (optional, advanced)</summary>

If you prefer external Qdrant via Docker:

```bash
# Start Qdrant + Ollama via Docker Compose
podman compose up -d   # or: docker compose up -d

# Pull the embedding model
podman exec ollama ollama pull unclemusclez/jina-embeddings-v2-base-code:latest
# or: docker exec ollama ollama pull unclemusclez/jina-embeddings-v2-base-code:latest
```

TeaRAGs will autodetect Qdrant on `localhost:6333` and use it instead of the embedded version.

</details>

## Next Steps

- [Connect to an Agent](/quickstart/connect-to-agent) — configure your AI assistant
- [Create Your First Index](/quickstart/create-first-index) — index a codebase

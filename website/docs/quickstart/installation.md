---
title: Installation
sidebar_position: 1
---

## Prerequisites

- Node.js 22+
- Podman or Docker with Compose support

## Install

```bash
# Clone and install
git clone https://github.com/artk0de/TeaRAGs-MCP.git
cd TeaRAGs-MCP
npm install

# Start services (choose one)
podman compose up -d   # Using Podman
docker compose up -d   # Using Docker

# Pull the embedding model
podman exec ollama ollama pull unclemusclez/jina-embeddings-v2-base-code:latest  # Podman
docker exec ollama ollama pull unclemusclez/jina-embeddings-v2-base-code:latest  # Docker

# Build
npm run build
```

## Next Steps

- [Connect to an Agent](/quickstart/connect-to-agent) — configure your AI assistant
- [Create Your First Index](/quickstart/create-first-index) — index a codebase

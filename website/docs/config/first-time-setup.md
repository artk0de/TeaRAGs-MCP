---
title: Installation
sidebar_position: 0
---

# Installation

## Default Setup

TeaRAGs is **pre-configured for MacBook M1/M2/M3** out of the box. Default settings are optimized for local development with Docker-based Qdrant and Ollama running on the same machine.

**No configuration required** if you're running:
- Qdrant on `http://localhost:6333`
- Ollama on `http://localhost:11434`
- Default embedding model: `unclemusclez/jina-embeddings-v2-base-code:latest`

Just install, index, and search — defaults work immediately.

## Prerequisites & Installation

### Quick Start: Everything in Docker

**Easiest option** — run both Qdrant and Ollama in Docker:

```bash
cd ~/yourpath/to/tea-rags

# Start both services (Qdrant + Ollama)
docker-compose up -d

# Pull the default embedding model
docker exec -it $(docker ps -q -f name=ollama) ollama pull unclemusclez/jina-embeddings-v2-base-code:latest
```

**That's it!** TeaRAGs will connect to `http://localhost:6333` (Qdrant) and `http://localhost:11434` (Ollama) automatically.

---

### Qdrant Setup

#### Option 1: Docker (Recommended)

```bash
# Run Qdrant in Docker
docker run -d \
  --name qdrant \
  -p 6333:6333 \
  -v $(pwd)/qdrant_storage:/qdrant/storage \
  qdrant/qdrant:latest
```

**With custom memory limit:**
```bash
docker run -d \
  --name qdrant \
  -p 6333:6333 \
  -v $(pwd)/qdrant_storage:/qdrant/storage \
  --memory=4g \
  qdrant/qdrant:latest
```

#### Option 2: Native Installation

<details>
<summary>macOS</summary>

```bash
brew install qdrant
```

</details>

<details>
<summary>Linux</summary>

```bash
wget https://github.com/qdrant/qdrant/releases/latest/download/qdrant-x86_64-unknown-linux-gnu.tar.gz
tar -xzf qdrant-x86_64-unknown-linux-gnu.tar.gz
./qdrant
```

</details>

#### Verify Qdrant

```bash
# Check Qdrant is running
curl http://localhost:6333/healthz
# Should return: "healthy"
```

---

### Ollama Setup

#### Option 1: Native Installation (Recommended for GPU)

<details>
<summary>macOS (Apple Silicon)</summary>

:::tip[Recommended: Ollama Desktop App]
On Mac with Apple Silicon (M1/M2/M3/M4), install the **[Ollama desktop app](https://ollama.com/download/mac)** instead of Homebrew. The desktop app automatically uses **Metal GPU acceleration**, which is significantly faster for embedding generation. Homebrew installs a CLI-only version that may not leverage GPU optimally.
:::

```bash
# Recommended: download the .dmg from https://ollama.com/download/mac
# Drag to Applications → launch → GPU acceleration works automatically

# Alternative: Homebrew (CLI-only, less optimal GPU)
brew install ollama
ollama serve
```

</details>

<details>
<summary>Linux</summary>

```bash
# Install script
curl -fsSL https://ollama.com/install.sh | sh

# Start Ollama
ollama serve
```

</details>

<details>
<summary>Windows</summary>

```powershell
# Download installer from https://ollama.com/download
# Run the installer, Ollama starts automatically
```

</details>

#### Option 2: Docker

<details>
<summary>CPU-only (all platforms)</summary>

```bash
docker run -d \
  --name ollama \
  -p 11434:11434 \
  -v ollama_models:/root/.ollama \
  ollama/ollama:latest
```

</details>

<details>
<summary>With GPU (Linux + NVIDIA)</summary>

```bash
docker run -d \
  --name ollama \
  --gpus all \
  -p 11434:11434 \
  -v ollama_models:/root/.ollama \
  ollama/ollama:latest
```

:::warning GPU Access in Docker
Docker GPU support requires [NVIDIA Container Toolkit](https://docs.nvidia.com/datacenter/cloud-native/container-toolkit/install-guide.html) on Linux. On macOS, GPU acceleration is **not available** in Docker — use the [native Ollama app](https://ollama.com/download/mac) for Metal GPU support.
:::

</details>

#### Pull Embedding Model

```bash
# Default code-specialized model (768 dimensions)
ollama pull unclemusclez/jina-embeddings-v2-base-code:latest

# Alternative: nomic-embed-text (768 dimensions)
ollama pull nomic-embed-text:latest

# Alternative: mxbai-embed-large (1024 dimensions)
ollama pull mxbai-embed-large:latest
```

#### Verify Ollama

```bash
# Check Ollama is running
curl http://localhost:11434/api/version

# Test embedding
ollama run unclemusclez/jina-embeddings-v2-base-code:latest "test"
```

---

### Installation Summary

| Component | Recommended | Alternative |
|-----------|-------------|-------------|
| **Qdrant** | Docker | Native binary |
| **Ollama** | Native (for GPU) | Docker (CPU-only on Mac) |

**Recommended setup for MacBook:**
- Qdrant: Docker (simple, isolated)
- Ollama: Native (GPU acceleration)

**Recommended setup for Linux:**
- Qdrant: Docker (simple)
- Ollama: Native or Docker with GPU (both support GPU)

**All-in-Docker setup:**
- Best for: Quick testing, CPU-only, remote servers
- Trade-off: No GPU acceleration on macOS

---

## When to Configure

Configure environment variables when:
- Using **remote Qdrant** or **remote GPU server** for embeddings
- Switching to **cloud providers** (OpenAI, Cohere, Voyage AI)
- **Performance tuning** for large codebases (1M+ LOC)
- Enabling **git enrichment** (authorship, churn, bug-fix rates)

## Essential Environment Variables

Set these in your MCP server configuration when deviating from defaults:

### Connection URLs

| Variable | Default | When to change |
|----------|---------|----------------|
| `QDRANT_URL` | `http://localhost:6333` | Qdrant on remote server or custom port |
| `EMBEDDING_BASE_URL` | `http://localhost:11434` | Ollama on remote GPU server or custom port |

**Example: Remote GPU server**
```bash
claude mcp add tea-rags -s user -- node /path/to/tea-rags/build/index.js \
  -e QDRANT_URL=http://192.168.1.100:6333 \
  -e EMBEDDING_BASE_URL=http://192.168.1.100:11434
```

### Embedding Provider

| Variable | Default | Options |
|----------|---------|---------|
| `EMBEDDING_PROVIDER` | `ollama` | `ollama`, `openai`, `cohere`, `voyage` |
| `EMBEDDING_MODEL` | `unclemusclez/jina-embeddings-v2-base-code:latest` | Provider-specific model name |

**Example: OpenAI**
```bash
claude mcp add tea-rags -s user -- node /path/to/tea-rags/build/index.js \
  -e EMBEDDING_PROVIDER=openai \
  -e EMBEDDING_MODEL=text-embedding-3-small \
  -e OPENAI_API_KEY=sk-...
```

### Git Enrichment

| Variable | Default | Purpose |
|----------|---------|---------|
| `CODE_ENABLE_GIT_METADATA` | `false` | Enable git blame analysis (authorship, churn, task IDs) |

**Enable trajectory enrichment:**
```bash
claude mcp add tea-rags -s user -- node /path/to/tea-rags/build/index.js \
  -e CODE_ENABLE_GIT_METADATA=true
```

:::tip
Git enrichment runs concurrently with embedding and does not increase indexing time. See **[Git Enrichments](/usage/git-enrichments)** for the full list of signals and advanced usage.
:::

### Performance Tuning

| Variable | Default | When to change |
|----------|---------|----------------|
| `EMBEDDING_BATCH_SIZE` | `1024` | Tune via `npm run tune` for your hardware |
| `INGEST_PIPELINE_CONCURRENCY` | `1` | Increase for remote GPU (2–4 typical) |
| `QDRANT_UPSERT_BATCH_SIZE` | `100` | Tune via `npm run tune` |

**Auto-tune for your setup:**
```bash
npm run tune
```

Generates `tuned_environment_variables.env` with optimal settings in ~60 seconds.

:::info
For detailed benchmarks, batch size optimization, and hardware-specific recommendations, see the **[Performance Tuning Guide](/config/performance-tuning)**.
:::

## Configuration Workflow

### 1. Start with defaults
```bash
# Install and run with zero configuration
npm install
npm run build
claude mcp add tea-rags -s user -- node /path/to/tea-rags/build/index.js
```

### 2. Configure only what you need
```bash
# Remote Qdrant example
claude mcp add tea-rags -s user -- node /path/to/tea-rags/build/index.js \
  -e QDRANT_URL=http://gpu-server:6333 \
  -e EMBEDDING_BASE_URL=http://gpu-server:11434
```

### 3. Performance tune (optional)
```bash
# Auto-tune for your hardware
QDRANT_URL=http://gpu-server:6333 \
EMBEDDING_BASE_URL=http://gpu-server:11434 \
npm run tune

# Apply tuned values
claude mcp add tea-rags -s user -- node /path/to/tea-rags/build/index.js \
  -e QDRANT_URL=http://gpu-server:6333 \
  -e EMBEDDING_BASE_URL=http://gpu-server:11434 \
  -e EMBEDDING_BATCH_SIZE=256 \
  -e INGEST_PIPELINE_CONCURRENCY=4 \
  -e QDRANT_UPSERT_BATCH_SIZE=384
```

## Quick Reference: Common Setups

<details>
<summary>Local MacBook (default)</summary>

```bash
# No configuration needed — defaults work out of the box
claude mcp add tea-rags -s user -- node /path/to/tea-rags/build/index.js
```

</details>

<details>
<summary>Remote GPU Server</summary>

```bash
claude mcp add tea-rags -s user -- node /path/to/tea-rags/build/index.js \
  -e QDRANT_URL=http://192.168.1.100:6333 \
  -e EMBEDDING_BASE_URL=http://192.168.1.100:11434 \
  -e INGEST_PIPELINE_CONCURRENCY=4
```

</details>

<details>
<summary>OpenAI Embeddings</summary>

```bash
claude mcp add tea-rags -s user -- node /path/to/tea-rags/build/index.js \
  -e EMBEDDING_PROVIDER=openai \
  -e EMBEDDING_MODEL=text-embedding-3-small \
  -e OPENAI_API_KEY=sk-...
```

</details>

<details>
<summary>Production with Git Enrichment</summary>

```bash
claude mcp add tea-rags -s user -- node /path/to/tea-rags/build/index.js \
  -e CODE_ENABLE_GIT_METADATA=true
```

</details>

## Next Steps

- **[Configuration Variables](/config/environment-variables)** — full list of all configuration options
- **[Embedding Providers](/config/providers)** — detailed comparison of Ollama, OpenAI, Cohere, Voyage
- **[Performance Tuning](/config/performance-tuning)** — benchmarks and optimization guide

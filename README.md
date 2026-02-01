<img src="public/logo.png" width="50%">

<h1 align="left" style="margin-top: 0;">
  🚀 Tea Rags MCP
</h1>

[![CI](https://github.com/mhalder/qdrant-mcp-server/actions/workflows/ci.yml/badge.svg)](https://github.com/mhalder/qdrant-mcp-server/actions/workflows/ci.yml)
[![codecov](https://codecov.io/gh/mhalder/qdrant-mcp-server/branch/main/graph/badge.svg)](https://codecov.io/gh/mhalder/qdrant-mcp-server)

> **This is a fork of [mcp-server-qdrant](https://github.com/mhalder/qdrant-mcp-server)**

A high-performance MCP server for intelligent codebase analysis. Enterprise-ready: handles millions of LOC with fast local indexing. Semantic code search, git-aware metadata (authorship, churn, task IDs), with graph indexing and symbol analysis coming soon. Built on Qdrant. Works with Ollama (local, private) or cloud providers (OpenAI, Cohere, Voyage).

---

## Table of Contents

1. [Key Features](#-key-features)
   1. [This fork vs original](#this-fork-vs-original)
2. [Quick Start](#quick-start)
   1. [Prerequisites](#prerequisites)
   2. [Installation](#installation)
   3. [Configuration](#configuration)
   4. [Work with your agent](#work-with-your-agent)
3. [Advanced Configuration](#advanced-configuration)
   1. [Environment Variables](#environment-variables)
   2. [Data Directories](#data-directories)
   3. [Provider Comparison](#provider-comparison)
4. [MCP Tools](#mcp-tools)
   1. [Collection Management](#collection-management)
   2. [Document Operations](#document-operations)
   3. [Code Vectorization](#code-vectorization-1)
   4. [Resources](#resources)
5. [Configurable Prompts](#configurable-prompts)
6. [Code Vectorization](#code-vectorization)
7. [Examples](#examples)
8. [Troubleshooting](#troubleshooting)
9. [FAQ](#faq)
10. [Performance Tuning](#performance-tuning)
11. [Development](#development)
    1. [Testing](#testing)
12. [Contributing](#contributing)
13. [Acknowledgments](#acknowledgments)
14. [License](#license)

---

## ⚡ Key Features

- 🚀 **Built for scale** — fast local indexing for enterprise codebases (millions of LOC)
- 🔍 **Semantic & hybrid search** — natural language queries with optional keyword matching (BM25 + RRF)
- 🎯 **Accuracy-first** — AST-aware chunking for most popular languages including Ruby and even Markdown. Extensible for other languages
- 📊 **Git-aware search** — filter by author, code age, churn, task IDs from commits
- 🧭 **Topological code search** — symbols and code graph analysis (coming soon)
- 🔒 **Privacy-first** — works offline with Ollama, data never leaves your machine
- 🔄 **Incremental indexing** — only re-index changed files, fast updates
- 📦 **Multiple providers** — Ollama (local), OpenAI, Cohere, Voyage AI
- 🔧 **Flexible deployment** — fully local, local network, or dedicated remote host
- ⚙️ **Highly configurable** — fine-tune batch sizes, concurrency, caching for your hardware. Performance calibration benchmarks included
- 🛠️ **Developer experience** — new versions don't break existing caches, auto-migrations

### This fork vs original

<details>
<summary><strong>Why fork instead of PRs?</strong></summary>

> I love to experiment. A lot. And fast. 🧪
>
> Coordinating changes with maintainers is the right thing to do, but it takes time:
> discussions, reviews, compromises, waiting. Sometimes an idea lives for a day,
> sometimes it turns into something useful.
>
> A fork gives me freedom to try crazy ideas without fear of breaking someone else's
> project or wasting anyone's time reviewing something that might not even work.

**For maintainers & contributors:** If you find something useful here — feel free to
cherry-pick it into upstream. No need to ask, MIT license covers it.

</details>

<details>
<summary><strong>What's different from the original mcp-server-qdrant?</strong></summary>

| Feature | Original | This Fork |
|---------|----------|-----------|
| **Snapshot storage** | Single JSON file | Sharded storage (v3) |
| **Change detection** | Sequential | Parallel (N workers) |
| **Hash distribution** | — | Consistent hashing |
| **Merkle tree** | Single level | Two-level (shard + meta) |
| **Delete operations** | Filter scan | Payload index (1000x faster) |
| **Batch pipeline** | Sequential | Parallel with backpressure |
| **Checkpointing** | — | Resume from interruption |
| **Git metadata** | — | Author, churn, task IDs |
| **Git blame caching** | — | L1 (memory) + L2 (disk) |
| **Task ID extraction** | — | From commit body (current blame, not full history) |
| **Ruby/Markdown AST** | — | Full support |
| **Concurrency control** | Fixed | Configurable via env |
| **Cache compatibility** | — | Auto-migration between versions |
| **Performance benchmarks** | — | Included |

</details>

---

## Quick Start

### Prerequisites

- Node.js 22+
- Podman or Docker with Compose support

### Installation

```bash
# Clone and install
git clone https://github.com/mhalder/qdrant-mcp-server.git
cd qdrant-mcp-server
npm install

# Start services (choose one)
podman compose up -d   # Using Podman
docker compose up -d   # Using Docker

# Pull the embedding model
podman exec ollama ollama pull nomic-embed-text  # Podman
docker exec ollama ollama pull nomic-embed-text  # Docker

# Build
npm run build
```

### Configuration

#### Add to Claude Code (recommended)

```bash
# Local setup (Qdrant + Ollama on localhost)
claude mcp add tea-rags -s user -- node /path/to/tea-rags-mcp/build/index.js \
  -e QDRANT_URL=http://localhost:6333 \
  -e EMBEDDING_BASE_URL=http://localhost:11434

# Remote server setup (Qdrant + Ollama on separate host)
claude mcp add tea-rags -s user -- node /path/to/tea-rags-mcp/build/index.js \
  -e QDRANT_URL=http://192.168.1.100:6333 \
  -e EMBEDDING_BASE_URL=http://192.168.1.100:11434

# Qdrant Cloud with API key
claude mcp add tea-rags -s user -- node /path/to/tea-rags-mcp/build/index.js \
  -e QDRANT_URL=https://your-cluster.qdrant.io:6333 \
  -e QDRANT_API_KEY=your-api-key-here \
  -e EMBEDDING_BASE_URL=http://localhost:11434
```

#### Remote Setup (HTTP transport)

> **⚠️ Security Warning**: When deploying the HTTP transport in production:
>
> - **Always** run behind a reverse proxy (nginx, Caddy) with HTTPS
> - Implement authentication/authorization at the proxy level
> - Use firewalls to restrict access to trusted networks
> - Never expose directly to the public internet without protection

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

**Using a different provider:**

```json
"env": {
  "EMBEDDING_PROVIDER": "openai",  // or "cohere", "voyage"
  "OPENAI_API_KEY": "sk-...",      // provider-specific API key
  "QDRANT_URL": "http://localhost:6333"
}
```

Restart after making changes.

See [Advanced Configuration](#advanced-configuration) section below for all options.

### Work with your agent

Once configured, you can use these tools with your AI assistant:

**Index your codebase (first time):**
```bash
# Full indexing - run once for new projects
index_codebase /path/to/your/project
```

**Incremental updates (after code changes):**
```bash
# Only re-indexes changed files - fast!
reindex_changes /path/to/your/project

# When to use: after git pull, after editing files, daily sync
```

**Check index status:**
```bash
get_index_status /path/to/your/project
# Returns: indexed files count, chunks, last update time
```

**Search your code:**
```bash
# Semantic search
search_code /path/to/project "authentication middleware"

# With git metadata filters (requires CODE_ENABLE_GIT_METADATA=true)
search_code /path/to/project "recent changes" --author "alice@example.com"
search_code /path/to/project "bug fixes" --minChurn 5
```

**Manage collections:**
```bash
list_collections                    # See all indexed projects
get_collection_info "code_abc123"   # Collection details
clear_index /path/to/project        # Remove index completely
```

## Advanced configuration
<details>
<summary><strong>⚙️ Environment variables, embedding configuration, performance tuning</strong></summary>

### Environment Variables

#### Core Configuration

| Variable                  | Description                             | Default               |
| ------------------------- | --------------------------------------- | --------------------- |
| `TRANSPORT_MODE`          | "stdio" or "http"                       | stdio                 |
| `HTTP_PORT`               | Port for HTTP transport                 | 3000                  |
| `HTTP_REQUEST_TIMEOUT_MS` | Request timeout for HTTP transport (ms) | 300000                |
| `EMBEDDING_PROVIDER`      | "ollama", "openai", "cohere", "voyage"  | ollama                |
| `QDRANT_URL`              | Qdrant server URL                       | http://localhost:6333 |
| `QDRANT_API_KEY`          | API key for Qdrant authentication       | -                     |
| `PROMPTS_CONFIG_FILE`     | Path to prompts configuration JSON      | prompts.json          |

#### Embedding Configuration

| Variable                            | Description                                       | Default           |
| ----------------------------------- | ------------------------------------------------- | ----------------- |
| `EMBEDDING_MODEL`                   | Model name                                        | Provider-specific |
| `EMBEDDING_BASE_URL`                | Custom API URL                                    | Provider-specific |
| `EMBEDDING_DIMENSION`               | Vector dimensions (auto-detected from model)      | Auto              |
| `EMBEDDING_BATCH_SIZE`              | Texts per embedding request (Ollama native batch) | 64                |
| `EMBEDDING_CONCURRENCY`             | Parallel embedding requests (for multiple GPUs)   | 1                 |
| `EMBEDDING_MAX_REQUESTS_PER_MINUTE` | Rate limit                                        | Provider-specific |
| `EMBEDDING_RETRY_ATTEMPTS`          | Retry count                                       | 3                 |
| `EMBEDDING_RETRY_DELAY`             | Initial retry delay (ms)                          | 1000              |
| `OPENAI_API_KEY`                    | OpenAI API key                                    | -                 |
| `COHERE_API_KEY`                    | Cohere API key                                    | -                 |
| `VOYAGE_API_KEY`                    | Voyage AI API key                                 | -                 |

#### Code Vectorization Configuration

| Variable                   | Description                                         | Default |
| -------------------------- | --------------------------------------------------- | ------- |
| `CODE_CHUNK_SIZE`          | Maximum chunk size in characters                    | 2500    |
| `CODE_CHUNK_OVERLAP`       | Overlap between chunks in characters                | 300     |
| `CODE_ENABLE_AST`          | Enable AST-aware chunking (tree-sitter)             | true    |
| `CODE_BATCH_SIZE`          | Number of chunks to embed in one batch              | 100     |
| `CODE_CUSTOM_EXTENSIONS`   | Additional file extensions (comma-separated)        | -       |
| `CODE_CUSTOM_IGNORE`       | Additional ignore patterns (comma-separated)        | -       |
| `CODE_DEFAULT_LIMIT`       | Default search result limit                         | 5       |
| `CODE_ENABLE_GIT_METADATA` | Enrich chunks with git blame (author, dates, tasks) | false   |

#### Qdrant Batch Pipeline Configuration

| Variable                   | Description                                                      | Default |
| -------------------------- | ---------------------------------------------------------------- | ------- |
| `QDRANT_FLUSH_INTERVAL_MS` | Auto-flush buffer interval (0 to disable timer)                  | 500     |
| `QDRANT_BATCH_ORDERING`    | Ordering mode: "weak", "medium", or "strong"                     | weak    |
| `DELETE_BATCH_SIZE`        | Paths per delete batch (with payload index, larger is efficient) | 500     |
| `DELETE_CONCURRENCY`       | Parallel delete requests (Qdrant-bound, not embedding-bound)     | 8       |

#### Performance & Debug Configuration

| Variable             | Description                                           | Default |
| -------------------- | ----------------------------------------------------- | ------- |
| `MAX_IO_CONCURRENCY` | Max parallel file I/O operations during cache sync    | 50      |
| `DEBUG`              | Enable debug timing logs (`true` or `1` to enable)    | false   |

### Data Directories

The server stores data in `~/.tea-rags-mcp/`:

| Directory | Purpose |
|-----------|---------|
| `snapshots/` | Sharded file hash snapshots for incremental indexing |
| `logs/` | Debug logs when `DEBUG=1` is enabled |

### Provider Comparison

| Provider   | Models                                                          | Dimensions     | Rate Limit | Notes                |
| ---------- | --------------------------------------------------------------- | -------------- | ---------- | -------------------- |
| **Ollama** | `nomic-embed-text`, `jina-embeddings-v2-base-code`, `mxbai-embed-large` | 768, 768, 1024 | None       | Local, no API key    |
| **OpenAI** | `text-embedding-3-small`, `text-embedding-3-large`              | 1536, 3072     | 3500/min   | Cloud API            |
| **Cohere** | `embed-english-v3.0`, `embed-multilingual-v3.0`                 | 1024           | 100/min    | Multilingual support |
| **Voyage** | `voyage-2`, `voyage-large-2`, `voyage-code-2`                   | 1024, 1536     | 300/min    | Code-specialized     |

#### Recommended: Jina Code Embeddings

For code search, we recommend **`jina-embeddings-v2-base-code`**:

```bash
ollama pull jina-embeddings-v2-base-code
export EMBEDDING_MODEL="jina-embeddings-v2-base-code"
```

| Aspect | Benefit |
|--------|---------|
| **Code-optimized** | Trained specifically on source code |
| **Multilingual** | 30+ programming languages |
| **Enterprise-proven** | Battle-tested on 3.5M+ LOC codebases |

</details>

---

## MCP Tools

### Collection Management

| Tool                  | Description                                                          |
| --------------------- | -------------------------------------------------------------------- |
| `create_collection`   | Create collection with specified distance metric (Cosine/Euclid/Dot) |
| `list_collections`    | List all collections                                                 |
| `get_collection_info` | Get collection details and statistics                                |
| `delete_collection`   | Delete collection and all documents                                  |

### Document Operations

| Tool               | Description                                                                   |
| ------------------ | ----------------------------------------------------------------------------- |
| `add_documents`    | Add documents with automatic embedding (supports string/number IDs, metadata) |
| `semantic_search`  | Natural language search with optional metadata filtering                      |
| `hybrid_search`    | Hybrid search combining semantic and keyword (BM25) search with RRF           |
| `delete_documents` | Delete specific documents by ID                                               |

### Code Vectorization

| Tool               | Description                                                                |
| ------------------ | -------------------------------------------------------------------------- |
| `index_codebase`   | Index a codebase for semantic code search with AST-aware chunking          |
| `search_code`      | Search indexed codebase using natural language queries                     |
| `reindex_changes`  | Incrementally re-index only changed files (detects added/modified/deleted) |
| `get_index_status` | Get indexing status and statistics for a codebase                          |
| `clear_index`      | Delete all indexed data for a codebase                                     |

### Resources

- `qdrant://collections` - List all collections
- `qdrant://collection/{name}` - Collection details

---

## Configurable Prompts

<details>
<summary><strong>Details</strong></summary>

Reusable text templates with parameters that AI assistants can invoke via MCP. Define once, use everywhere — no code changes needed.

**How it works:**
1. You create `prompts.json` with template definitions
2. MCP server registers them as available prompts
3. AI assistant (Claude Code, etc.) can invoke them by name with parameters
4. Template renders into a structured instruction for the AI

**Use cases:**
- Standardize team workflows (e.g., "analyze collection before optimization")
- Create project-specific search patterns (e.g., "find code related to ticket X")
- Build guided wizards for complex operations

### Setup

1. **Create a prompts configuration file** (e.g., `prompts.json` in the project root):

   See [`prompts.example.json`](prompts.example.json) for example configurations you can copy and customize.

2. **Configure the server** (optional — only needed for custom path):

```json
{
  "mcpServers": {
    "qdrant": {
      "env": {
        "PROMPTS_CONFIG_FILE": "/custom/path/to/prompts.json"
      }
    }
  }
}
```

3. **Use prompts** in your AI assistant:

```bash
# Claude Code
/mcp__qdrant__find_similar_docs papers "neural networks" 10
```

### Template Syntax

Templates use `{{variable}}` placeholders:
- Required arguments must be provided
- Optional arguments use defaults if not specified

### Example Prompts

See [`prompts.example.json`](prompts.example.json) for ready-to-use prompts including:
- `setup_rag_collection` — create RAG-optimized collections
- `analyze_collection` — collection insights and recommendations
- `compare_search_methods` — semantic vs hybrid search comparison

</details>

---

## Code Vectorization

Index and search your codebase using semantic code search. For detailed documentation, examples, and configuration options, see [docs/CODE_VECTORIZATION.md](docs/CODE_VECTORIZATION.md).

**Quick Start:**

```bash
# Index your codebase
/mcp__qdrant__index_codebase /path/to/your/project

# Search your code
/mcp__qdrant__search_code /path/to/your/project "authentication middleware"

# Update after changes
/mcp__qdrant__reindex_changes /path/to/your/project
```

<details>
<summary><strong>📊 Performance Benchmarks</strong></summary>

Benchmarked on hybrid setup: MacBook Pro M3 Pro (client) + Windows PC with 12GB VRAM (Qdrant + Ollama server).

| Codebase Size          | Files  | Indexing Time | Search Latency |
| ---------------------- | ------ | ------------- | -------------- |
| Small (10k LOC)        | ~30    | ~5s           | <100ms         |
| Medium (50k LOC)       | ~150   | ~15s          | <100ms         |
| Large (100k LOC)       | ~300   | ~30s          | <200ms         |
| Very Large (500k LOC)  | ~1,500 | ~2min         | <300ms         |
| Enterprise (3.5M LOC)  | ~10k   | ~10min        | <500ms         |

**Note**: Using Ollama `jina-embeddings-v2-base-code`. CPU-only embedding is 5-10x slower.

</details>

---

## Examples

See [docs/examples/](docs/examples/) directory for detailed guides:

- **[Basic Usage](docs/examples/basic/)** - Create collections, add documents, search
- **[Hybrid Search](docs/examples/hybrid-search/)** - Combine semantic and keyword search
- **[Knowledge Base](docs/examples/knowledge-base/)** - Structured documentation with metadata
- **[Advanced Filtering](docs/examples/filters/)** - Complex boolean filters
- **[Rate Limiting](docs/examples/rate-limiting/)** - Batch processing with cloud providers
- **[Code Search](docs/examples/code-search/)** - Index codebases and semantic code search

---

## Troubleshooting

<details>
<summary><strong>Common issues and solutions</strong></summary>

| Issue                          | Solution                                                                                  |
| ------------------------------ | ----------------------------------------------------------------------------------------- |
| **Qdrant not running**         | `podman compose up -d` or `docker compose up -d`                                          |
| **Collection missing**         | Create collection first before adding documents                                           |
| **Ollama not running**         | Verify with `curl http://localhost:11434`, start with `podman compose up -d`              |
| **Model missing**              | `podman exec ollama ollama pull nomic-embed-text`                                         |
| **Rate limit errors**          | Adjust `EMBEDDING_MAX_REQUESTS_PER_MINUTE` to match your provider tier                    |
| **API key errors**             | Verify correct API key in environment configuration                                       |
| **Qdrant unauthorized**        | Set `QDRANT_API_KEY` environment variable for secured instances                           |
| **Filter errors**              | Ensure Qdrant filter format, check field names match metadata                             |
| **Codebase not indexed**       | Run `index_codebase` before `search_code`                                                 |
| **Slow indexing**              | Use Ollama (local) for faster indexing, or increase `CODE_BATCH_SIZE`                     |
| **Files not found**            | Check `.gitignore` and `.contextignore` patterns                                          |
| **Search returns no results**  | Try broader queries, check if codebase is indexed with `get_index_status`                 |
| **Out of memory during index** | Reduce `CODE_CHUNK_SIZE` or `CODE_BATCH_SIZE`                                             |

</details>

---

## FAQ

<details>
<summary><strong>How do I know when indexing is complete?</strong></summary>

The MCP server returns a success response with statistics (files indexed, chunks created, time elapsed). You can also check status anytime with `get_index_status`.

</details>

<details>
<summary><strong>I accidentally cancelled the request. Is my indexing lost?</strong></summary>

No worries! Indexing continues in the background until completion. Check progress with `get_index_status`. Already processed chunks are saved via checkpointing.

</details>

<details>
<summary><strong>How do I stop indexing?</strong></summary>

Find and kill the process:
```bash
# Find the process
ps aux | grep tea-rags

# Kill it
kill -9 <PID>
```

</details>

<details>
<summary><strong>How do I resume interrupted indexing?</strong></summary>

Just run `index_codebase` again. Completed steps are cached — only remaining work will be processed.

</details>

<details>
<summary><strong>Where are cache snapshots and logs stored?</strong></summary>

All data is stored in `~/.tea-rags-mcp/`:
- `snapshots/` — file hash snapshots for incremental indexing
- `git-cache/` — git blame cache (L2 disk cache)
- `logs/` — debug logs (when `DEBUG=1`)

</details>

<details>
<summary><strong>How do I enable MCP logging?</strong></summary>

Run your agent with the DEBUG variable:
```bash
DEBUG=1 claude
```

Or add `DEBUG=true` to your MCP server configuration in `env` section.

</details>

---

## Performance Tuning

Automatically find optimal settings for your hardware:

```bash
npm run tune
```

This benchmarks your Qdrant + Ollama setup and creates `tuned_environment_variables.env` with optimal values for:

| Parameter | Description |
|-----------|-------------|
| `EMBEDDING_BATCH_SIZE` | Texts per embedding request |
| `EMBEDDING_CONCURRENCY` | Parallel embedding requests |
| `CODE_BATCH_SIZE` | Chunks per Qdrant upsert |
| `QDRANT_BATCH_ORDERING` | Ordering mode (weak/medium/strong) |

**Stopping criteria:** The benchmark automatically stops when performance degrades (20% drop, 3 consecutive drops, errors, or timeouts).

For detailed manual tuning guides, see [docs/PERFORMANCE_TUNING.md](docs/PERFORMANCE_TUNING.md).

---

## Development

```bash
npm run dev          # Development with auto-reload
npm run build        # Production build
npm run type-check   # TypeScript validation
npm test             # Run unit test suite (mocked, fast)
npm run test:coverage # Coverage report
npm run test-integration # Run real integration tests (requires Qdrant + Ollama)
```

### Testing

**Unit Tests**: 864+ tests with 97%+ coverage (mocked, fast)

**Integration Tests**: 233 tests across 18 suites against real Qdrant + Ollama

```bash
npm run test-integration           # Run all
TEST_SUITE=1 npm run test-integration  # Run specific suite (1-18)
SKIP_CLEANUP=1 npm run test-integration # Debug mode
```

**CI/CD**: GitHub Actions runs build, type-check, and tests on Node.js 22 LTS for every push/PR.

---

## Contributing

Contributions welcome! See [CONTRIBUTING.md](CONTRIBUTING.md) for:

- Development workflow
- Conventional commit format (`feat:`, `fix:`, `BREAKING CHANGE:`)
- Testing requirements (run `npm test`, `npm run type-check`, `npm run build`)

**Automated releases**: Semantic versioning via conventional commits - `feat:` → minor, `fix:` → patch, `BREAKING CHANGE:` → major.

---

## Acknowledgments

The author of Tea Rags MCP proudly continues the noble tradition of forking. 🍴

Huge thanks to **[mhalder/qdrant-mcp-server](https://github.com/mhalder/qdrant-mcp-server)** — this fork wouldn't exist without your solid foundation:

- 💎 Clean and extensible architecture
- 📚 Excellent documentation and examples
- 🧪 Solid test coverage
- 🤝 Open-source spirit and MIT license

And in the spirit of paying it forward, we also thank the ancestor of all forks — **[qdrant/mcp-server-qdrant](https://github.com/qdrant/mcp-server-qdrant)**. The circle of open source is complete. 🙏

The code vectorization feature is inspired by concepts from the excellent **[claude-context](https://github.com/zilliztech/claude-context)** project (MIT License, Zilliz).

*Feel free to fork this fork. It's forks all the way down.* 🐢

---

## License

MIT - see [LICENSE](LICENSE) file.

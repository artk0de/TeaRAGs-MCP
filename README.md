<img src="public/logo.png" width="50%">

<h1 align="left" style="margin-top: 0;">
  🚀 Tea Rags MCP
</h1>

[![CI](https://github.com/mhalder/qdrant-mcp-server/actions/workflows/ci.yml/badge.svg)](https://github.com/mhalder/qdrant-mcp-server/actions/workflows/ci.yml)
[![codecov](https://codecov.io/gh/mhalder/qdrant-mcp-server/branch/main/graph/badge.svg)](https://codecov.io/gh/mhalder/qdrant-mcp-server)

> **This is a fork of [mcp-server-qdrant](https://github.com/qdrant/mcp-server-qdrant)**

A high-performance Model Context Protocol (MCP) server for semantic search using Qdrant vector database. Optimized for fast codebase indexing and incremental re-indexing.

---

## 🙏 Acknowledgments

Huge thanks to the **[qdrant/mcp-server-qdrant](https://github.com/qdrant/mcp-server-qdrant)** team and all contributors to the original project!

Special appreciation for:

- 💎 Clean and extensible architecture
- 📚 Excellent documentation and examples
- 🧪 Solid test coverage
- 🤝 Open-source spirit and MIT license

This fork is built on the solid foundation of your work. Thank you for your contribution to the community! 💜

---

## ⚡ Fork Highlights

**Why tea-rags-mcp?**

- 🚀 **Optimized embedding pipeline** — indexing and re-indexing takes minutes, not hours
- 🔥 **1000x faster deletions** — payload indexes make filter-based deletes instant
- ⚡ **Parallel processing** — sharded snapshots, concurrent workers, batched operations
- 🎯 **Smart batching** — automatic batch formation with backpressure control
- 🛠️ **Production-ready** — auto-migration, checkpointing, resume from interruption
- 💎 **Ruby AST Aware** - supports ruby Ruby AST aware chunking

---

## 🍴 Why Fork?

Why a fork instead of PRs to the original?

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
Questions? Reach me at: `artk0re@icloud.com` 📬

**TL;DR:** This is an experimental playground. Use at your own risk.
For production, I recommend the [original project](https://github.com/qdrant/mcp-server-qdrant).

---

## ✨ What's New in This Fork

| Feature | Original | This Fork |
|---------|----------|-----------|
| **Snapshot storage** | Single JSON file | 🔀 Sharded storage (v3) |
| **Change detection** | Sequential | ⚡ Parallel (N workers) |
| **Hash distribution** | — | 🎯 Consistent hashing |
| **Merkle tree** | Single level | 🌳 Two-level (shard + meta) |
| **Concurrency control** | Fixed | 🎛️ `EMBEDDING_CONCURRENCY` env |
| **Delete operations** | Filter scan | ⚡ Payload index (1000x faster) |
| **Batch pipeline** | Sequential | 🔄 Parallel with backpressure |

### 🔀 Sharded Snapshots (v3 format)

File hashes are stored across multiple shards instead of a single file:

- Parallel read/write across shards
- Atomic updates via directory swap
- Checksum validation per shard

### ⚡ Parallel Change Detection

Change detection runs in parallel across all shards:

```bash

# Control parallelism (default: 4)

export EMBEDDING_CONCURRENCY=8
```

### 🎯 Consistent Hashing

When changing the number of workers, minimal files are redistributed:

- 4 → 8 workers: ~50% files stay in place (vs ~25% with modulo)
- Virtual nodes ensure even distribution

### 🌳 Two-Level Merkle Tree

Fast "any changes?" check:

1. Compare meta root hash (single read)
2. If changed — read only affected shards

### 📝 Future Improvements

- [ ] Auto-detection of optimal concurrency based on CPU/IO
- [ ] Compression for large shards
- [ ] File locking for concurrent access

---

## Features

- **Zero Setup**: Works out of the box with Ollama - no API keys required
- **Privacy-First**: Local embeddings and vector storage - data never leaves your machine
- **Code Vectorization**: Intelligent codebase indexing with AST-aware chunking and semantic code search
- **Multiple Providers**: Ollama (default), OpenAI, Cohere, and Voyage AI
- **Hybrid Search**: Combine semantic and keyword search for better results
- **Semantic Search**: Natural language search with metadata filtering
- **Incremental Indexing**: Efficient updates - only re-index changed files
- **Git Blame Metadata**: Enrich code with authorship, dates, churn metrics, and task IDs from commit history
- **Flexible Performance Tuning**: Configurable batch sizes, concurrency, and pipeline parameters for maximum resource utilization
- **Smart Caching**: Two-level cache (memory + disk) with content-hash invalidation for git blame and file snapshots
- **Configurable Prompts**: Create custom prompts for guided workflows without code changes
- **Rate Limiting**: Intelligent throttling with exponential backoff
- **Full CRUD**: Create, search, and manage collections and documents
- **Flexible Deployment**: Run locally (stdio) or as a remote HTTP server
- **API Key Authentication**: Connect to secured Qdrant instances (Qdrant Cloud, self-hosted with API keys)

<details>
<summary><strong>🔍 Feature Details</strong></summary>

#### Git Blame Metadata

Each code chunk is enriched with aggregated signals from `git blame`:

- **Dominant author** — who wrote most lines in the chunk (for ownership questions)
- **All authors** — everyone who contributed to this code
- **Timestamps** — first created and last modified dates
- **Age in days** — how stale is the code
- **Commit count** — churn indicator (high = frequently changed = potentially problematic)
- **Task IDs** — automatically extracted from commit messages (JIRA, GitHub, Azure DevOps patterns)

This enables powerful filters: find code by author, find legacy code, find high-churn areas, trace code to tickets.

#### Flexible Performance Tuning

Every bottleneck is configurable via environment variables:

| Layer | Variables | Purpose |
|-------|-----------|---------|
| Embedding | `EMBEDDING_BATCH_SIZE`, `EMBEDDING_CONCURRENCY` | GPU utilization, parallel requests |
| Pipeline | `CODE_BATCH_SIZE`, `BATCH_FORMATION_TIMEOUT_MS` | Batch accumulation strategy |
| Qdrant | `DELETE_BATCH_SIZE`, `DELETE_CONCURRENCY` | Bulk operations throughput |
| I/O | `MAX_IO_CONCURRENCY`, `FILE_PROCESSING_CONCURRENCY` | Parallel file reads |

The pipeline uses backpressure control — if Qdrant or embeddings slow down, file processing automatically pauses to prevent memory overflow.

#### Smart Caching

Two-level caching minimizes redundant work:

| Cache | Storage | Invalidation | Purpose |
|-------|---------|--------------|---------|
| Git blame | Memory (L1) + Disk (L2) | Content hash | Avoid re-running `git blame` for unchanged files |
| File snapshots | Sharded JSON | Merkle tree | Fast "any changes?" check for incremental indexing |
| Collection info | Memory | TTL | Reduce Qdrant API calls |

**Content-hash invalidation**: Cache keys include file content hash, so changing a file automatically invalidates its cached blame data — no stale data, no manual cache clearing.

</details>

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
> - Consider implementing rate limiting at the proxy level
> - Monitor server logs for suspicious activity

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

## Tools

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

## Configurable Prompts

Create custom prompts tailored to your specific use cases without modifying code. Prompts provide guided workflows for common tasks.

**Note**: By default, the server looks for `prompts.json` in the project root directory. If the file exists, prompts are automatically loaded. You can specify a custom path using the `PROMPTS_CONFIG_FILE` environment variable.

### Setup

1. **Create a prompts configuration file** (e.g., `prompts.json` in the project root):

   See [`prompts.example.json`](prompts.example.json) for example configurations you can copy and customize.

2. **Configure the server** (optional - only needed for custom path):

If you place `prompts.json` in the project root, no additional configuration is needed. To use a custom path:

```json
{
  "mcpServers": {
    "qdrant": {
      "command": "node",
      "args": ["/path/to/qdrant-mcp-server/build/index.js"],
      "env": {
        "QDRANT_URL": "http://localhost:6333",
        "PROMPTS_CONFIG_FILE": "/custom/path/to/prompts.json"
      }
    }
  }
}
```

3. **Use prompts** in your AI assistant:

**Claude Code:**

```bash
/mcp__qdrant__find_similar_docs papers "neural networks" 10
```

**VSCode:**

```bash
/mcp.qdrant.find_similar_docs papers "neural networks" 10
```

### Example Prompts

See [`prompts.example.json`](prompts.example.json) for ready-to-use prompts including:

- `find_similar_docs` - Semantic search with result explanation
- `setup_rag_collection` - Create RAG-optimized collections
- `analyze_collection` - Collection insights and recommendations
- `bulk_add_documents` - Guided bulk document insertion
- `search_with_filter` - Metadata filtering assistance
- `compare_search_methods` - Semantic vs hybrid search comparison
- `collection_maintenance` - Maintenance and cleanup workflows
- `migrate_to_hybrid` - Collection migration guide

### Template Syntax

Templates use `{{variable}}` placeholders:

- Required arguments must be provided
- Optional arguments use defaults if not specified
- Unknown variables are left as-is in the output

## Code Vectorization (1.1)

Intelligently index and search your codebase using semantic code search. Perfect for AI-assisted development, code exploration, and understanding large codebases.

### Features (1.1.1)

- **AST-Aware Chunking**: Intelligent code splitting at function/class boundaries using tree-sitter
- **Multi-Language Support**: 35+ file types including TypeScript, Python, Java, Go, Rust, C++, and more
- **Incremental Updates**: Only re-index changed files for fast updates
- **Smart Ignore Patterns**: Respects .gitignore, .dockerignore, and custom .contextignore files
- **Semantic Search**: Natural language queries to find relevant code
- **Metadata Filtering**: Filter by file type, path patterns, or language
- **Local-First**: All processing happens locally - your code never leaves your machine

### Quick Start (1.1.1)

**1. Index your codebase:**

```bash

# Via Claude Code MCP tool

/mcp__qdrant__index_codebase /path/to/your/project
```

**2. Search your code:**

```bash

# Natural language search

/mcp__qdrant__search_code /path/to/your/project "authentication middleware"

# Filter by file type

/mcp__qdrant__search_code /path/to/your/project "database schema" --fileTypes .ts,.js

# Filter by path pattern

/mcp__qdrant__search_code /path/to/your/project "API endpoints" --pathPattern src/api/**
```

**3. Update after changes:**

```bash

# Incrementally re-index only changed files

/mcp__qdrant__reindex_changes /path/to/your/project
```

### Usage Examples

#### Index a TypeScript Project

```typescript
// The MCP tool automatically:
// 1. Scans all .ts, .tsx, .js, .jsx files
// 2. Respects .gitignore patterns (skips node_modules, dist, etc.)
// 3. Chunks code at function/class boundaries
// 4. Generates embeddings using your configured provider
// 5. Stores in Qdrant with metadata (file path, line numbers, language)

index_codebase({
  path: "/workspace/my-app",
  forceReindex: false, // Set to true to re-index from scratch
});

// Output:
// ✓ Indexed 247 files (1,823 chunks) in 45.2s
```

#### Search for Authentication Code

```typescript
search_code({
  path: "/workspace/my-app",
  query: "how does user authentication work?",
  limit: 5,
});

// Results include file path, line numbers, and code snippets:
// [
//   {
//     filePath: "src/auth/middleware.ts",
//     startLine: 15,
//     endLine: 42,
//     content: "export async function authenticateUser(req: Request) { ... }",
//     score: 0.89,
//     language: "typescript"
//   },
//   ...
// ]
```

#### Search with Filters

```typescript
// Only search TypeScript files
search_code({
  path: "/workspace/my-app",
  query: "error handling patterns",
  fileTypes: [".ts", ".tsx"],
  limit: 10,
});

// Only search in specific directories
search_code({
  path: "/workspace/my-app",
  query: "API route handlers",
  pathPattern: "src/api/**",
  limit: 10,
});
```

#### Incremental Re-indexing

```typescript
// After making changes to your codebase
reindex_changes({
  path: "/workspace/my-app",
});

// Output:
// ✓ Updated: +3 files added, ~5 files modified, -1 files deleted
// ✓ Chunks: +47 added, -23 deleted in 8.3s
```

#### Check Indexing Status

```typescript
get_index_status({
  path: "/workspace/my-app",
});

// Output:
// {
//   status: "indexed",      // "not_indexed" | "indexing" | "indexed"
//   isIndexed: true,        // deprecated: use status instead
//   collectionName: "code_a3f8d2e1",
//   chunksCount: 1823,
//   filesCount: 247,
//   lastUpdated: "2025-01-30T10:15:00Z",
//   languages: ["typescript", "javascript", "json"]
// }
```

### Supported Languages

**Programming Languages** (35+ file types):

- **Web**: TypeScript, JavaScript, Vue, Svelte
- **Backend**: Python, Java, Go, Rust, Ruby, PHP
- **Systems**: C, C++, C#
- **Mobile**: Swift, Kotlin, Dart
- **Functional**: Scala, Clojure, Haskell, OCaml
- **Scripting**: Bash, Shell, Fish
- **Data**: SQL, GraphQL, Protocol Buffers
- **Config**: JSON, YAML, TOML, XML, Markdown

See [configuration](#code-vectorization-configuration) for full list and customization options.

### Custom Ignore Patterns

Create a `.contextignore` file in your project root to specify additional patterns to ignore:

```gitignore

# .contextignore

**/test/**
**/*.test.ts
**/*.spec.ts
**/fixtures/**
**/mocks/**
**/__tests__/**
```

### Best Practices

1. **Index Once, Update Incrementally**: Use `index_codebase` for initial indexing, then `reindex_changes` for updates
2. **Use Filters**: Narrow search scope with `fileTypes` and `pathPattern` for better results
3. **Meaningful Queries**: Use natural language that describes what you're looking for (e.g., "database connection pooling" instead of "db")
4. **Check Status First**: Use `get_index_status` to verify a codebase is indexed before searching
5. **Local Embedding**: Use Ollama (default) to keep everything local and private

### Git Metadata Enrichment

Enrich code search with git history information. When enabled, each code chunk is annotated with authorship, modification dates, and task IDs from commit messages.

**Enable git metadata:**

```bash
export CODE_ENABLE_GIT_METADATA=true
```

**What's captured (per chunk):**

| Signal | Description | Use Case |
|--------|-------------|----------|
| `dominantAuthor` | Author with most lines in chunk | "Find code written by John" |
| `authors[]` | All authors who touched the chunk | Team attribution |
| `lastModifiedAt` | Unix timestamp of latest change | "Code changed after 2024-01-01" |
| `firstCreatedAt` | Unix timestamp of oldest change | Code origin tracking |
| `ageDays` | Days since last modification | "Old code (>365 days)" |
| `commitCount` | Number of unique commits | Churn indicator (high = frequently changed) |
| `taskIds[]` | Extracted from commit messages | "Find code for TD-1234" |
| `lastCommitHash` | Most recent commit SHA | Audit trail |

**Search with git filters:**

```typescript
// Find code by author
search_code({
  path: "/workspace/my-app",
  query: "authentication logic",
  author: "John Doe",
});

// Find recently changed code
search_code({
  path: "/workspace/my-app",
  query: "payment processing",
  maxAgeDays: 30, // Changed in last 30 days
});

// Find old code (potential tech debt)
search_code({
  path: "/workspace/my-app",
  query: "database connection",
  minAgeDays: 365, // Not changed in a year
});

// Find code by task ID
search_code({
  path: "/workspace/my-app",
  query: "user registration",
  taskId: "TD-1234",
});

// Find high-churn code
search_code({
  path: "/workspace/my-app",
  query: "API handlers",
  minCommitCount: 10, // Changed 10+ times
});

// Combine filters
search_code({
  path: "/workspace/my-app",
  query: "error handling",
  author: "Jane",
  modifiedAfter: "2024-01-01",
  modifiedBefore: "2024-06-30",
});
```

**Task ID extraction:**

Task IDs are automatically extracted from commit summary lines:

| Pattern | Example | Extracted |
|---------|---------|-----------|
| JIRA/Linear | `feat: implement TD-1234 feature` | `TD-1234` |
| GitHub | `fix: resolve issue #123` | `#123` |
| Azure DevOps | `feat: add AB#456 functionality` | `AB#456` |
| GitLab MR | `merge !789 changes` | `!789` |

**Algorithm details:**

- One `git blame` call per file (cached by content hash)
- Aggregated signals only — no per-line storage overhead
- Commit messages are NOT stored (only extracted task IDs)
- Cache invalidates automatically when file content changes
- L1 (memory) + L2 (disk) caching for performance

<details>
<summary><strong>📋 Example Questions for Code Analysis with Git Metadata</strong></summary>

#### By Author

| Question | Filters |
|----------|---------|
| What code did John write? | `author="John"` |
| Who is the expert on the auth module? | `query="authorization"` → check `dominantAuthor` |
| Who can help me understand this code? | Search → find author with most contributions |
| Whose code needs review from last week? | `author="John"`, `maxAgeDays=7` |
| Whose code changes most frequently? | `author="X"`, `minCommitCount=5` |

#### By Code Age

| Question | Filters |
|----------|---------|
| What code hasn't been touched in a while? | `minAgeDays=90` |
| What changed in the last week? | `maxAgeDays=7` |
| What legacy code needs documentation? | `minAgeDays=60`, `query="service"` |
| What was done in this sprint? | `maxAgeDays=14` |
| What old code is still being used? | `minAgeDays=180`, `query="import"` |
| Which components haven't been updated in a year? | `minAgeDays=365` |

#### By Change Frequency (Churn)

| Question | Filters |
|----------|---------|
| What code is frequently rewritten? (problematic) | `minCommitCount=10` |
| Where are there many hotfixes? | `minCommitCount=5`, `query="fix"` |
| Which modules are most unstable? | `minCommitCount=8` |
| What needs refactoring? | `minCommitCount=6`, `minAgeDays=30` |
| Where do bugs appear most often? | `minCommitCount=7`, `query="error handling"` |

#### By Task/Ticket ID

| Question | Filters |
|----------|---------|
| What code relates to JIRA-1234? | `taskId="JIRA-1234"` |
| What was done for GitHub issue #567? | `taskId="#567"` |
| What code is linked to this requirement? | `taskId="REQ-100"` |
| Show everything related to feature X | `taskId="FEAT-X"` |
| Which files were affected by this task? | `taskId="TD-5678"` |

#### By Date Range

| Question | Filters |
|----------|---------|
| What changed after release 1.0? | `modifiedAfter="2024-03-01"` |
| What code existed before the refactoring? | `modifiedBefore="2024-01-01"` |
| What changed between releases? | `modifiedAfter="2024-01-01"`, `modifiedBefore="2024-06-01"` |
| What was done in Q1 2024? | `modifiedAfter="2024-01-01"`, `modifiedBefore="2024-04-01"` |

#### Combined Queries

| Question | Filters |
|----------|---------|
| Complex code that hasn't changed and needs docs | `query="complex"`, `minAgeDays=60` |
| John's recent code in the payment module | `author="John"`, `maxAgeDays=14`, `query="payment"` |
| Old high-churn code (risk!) | `minAgeDays=90`, `minCommitCount=5` |
| Code for a task that was frequently reworked | `taskId="X"`, `minCommitCount=3` |
| What a specific author did for a task | `author="John"`, `taskId="TD-123"` |
| Legacy code in critical modules | `minAgeDays=180`, `pathPattern="src/core/**"` |
| Recent changes in authentication | `maxAgeDays=7`, `query="authentication"` |
| Problematic areas in the last month | `maxAgeDays=30`, `minCommitCount=4` |

#### Analytical Questions

| Question | Approach |
|----------|----------|
| Where has technical debt accumulated? | `minAgeDays=90` + `minCommitCount=1` (changed but not refactored) |
| What code needs test coverage? | `minCommitCount=5` (frequently breaks) |
| Who owns which module? | Group by `pathPattern` + analyze `dominantAuthor` |
| What code lacks documentation? | `minAgeDays=60` + `documentationOnly=false` |
| What needs code review? | `maxAgeDays=7` + `minCommitCount=2` |

</details>

### Performance

Typical performance with GPU-accelerated embeddings (Ollama + CUDA/Metal):

| Codebase Size          | Files  | Indexing Time | Search Latency |
| ---------------------- | ------ | ------------- | -------------- |
| Small (10k LOC)        | ~30    | ~5s           | <100ms         |
| Medium (50k LOC)       | ~150   | ~15s          | <100ms         |
| Large (100k LOC)       | ~300   | ~30s          | <200ms         |
| Very Large (500k LOC)  | ~1,500 | ~2min         | <300ms         |
| Enterprise (3.5M LOC)  | ~10k   | ~10min        | <500ms         |

**Note**: Benchmarked with Ollama `nomic-embed-text` on RTX 4090 / Apple M-series. CPU-only embedding is 5-10x slower.

## Examples

See [examples/](examples/) directory for detailed guides:

- **[Basic Usage](examples/basic/)** - Create collections, add documents, search
- **[Hybrid Search](examples/hybrid-search/)** - Combine semantic and keyword search
- **[Knowledge Base](examples/knowledge-base/)** - Structured documentation with metadata
- **[Advanced Filtering](examples/filters/)** - Complex boolean filters
- **[Rate Limiting](examples/rate-limiting/)** - Batch processing with cloud providers
- **[Code Search](examples/code-search/)** - Index codebases and semantic code search

## Advanced Configuration

### Environment Variables

#### Core Configuration

| Variable                  | Description                             | Default               |
| ------------------------- | --------------------------------------- | --------------------- |
| `TRANSPORT_MODE`          | "stdio" or "http"                       | stdio                 |
| `HTTP_PORT`               | Port for HTTP transport                 | 3000                  |
| `HTTP_REQUEST_TIMEOUT_MS` | Request timeout for HTTP transport (ms) | 300000                |
| `EMBEDDING_PROVIDER`      | "ollama", "openai", "cohere", "voyage"  | ollama                |
| `QDRANT_URL`              | Qdrant server URL                       | <http://localhost:6333> |
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

**Note:** `CODE_BATCH_SIZE` controls both embedding batch size and Qdrant upsert buffer size for simplified configuration.

**Delete Optimization (v4 schema):** Collections created with schema v4+ have a `relativePath` payload index for fast filter-based deletes. Existing collections are auto-migrated on first `reindex_changes` call.

#### Performance & Debug Configuration

| Variable             | Description                                           | Default |
| -------------------- | ----------------------------------------------------- | ------- |
| `MAX_IO_CONCURRENCY` | Max parallel file I/O operations during cache sync    | 50      |
| `DEBUG`              | Enable debug timing logs (`true` or `1` to enable)    | false   |

**Performance Tuning Notes:**

- `MAX_IO_CONCURRENCY`: Controls parallel file reads during `reindex_changes`. For MacBook with NVMe SSD, 50-100 is optimal. Too high (500+) can saturate the kernel I/O scheduler.
- `DEBUG`: When enabled, logs detailed timing for cache initialization, shard processing, and pipeline stages.

### Data Directories

The server stores data in `~/.qdrant-mcp/`:

| Directory | Purpose |
|-----------|---------|
| `snapshots/` | Sharded file hash snapshots for incremental indexing |
| `logs/` | Debug logs when `DEBUG=1` is enabled |

**Snapshot Structure (v3):**

```text
~/.qdrant-mcp/snapshots/
└── code_<hash>/           # Collection-specific directory
    └── v3/                # Format version
        ├── meta.json      # Merkle root + metadata
        ├── shard-0.json   # File hashes for shard 0
        ├── shard-1.json   # File hashes for shard 1
        └── ...            # More shards based on EMBEDDING_CONCURRENCY
```

**Debug Logs:**
When `DEBUG=1`, pipeline operations are logged to `~/.qdrant-mcp/logs/pipeline-<timestamp>.log`:

- Batch formation and processing times
- Queue depth and backpressure events
- Embedding and Qdrant call durations
- Fallback triggers and error details

### Provider Comparison

| Provider   | Models                                                          | Dimensions     | Rate Limit | Notes                |
| ---------- | --------------------------------------------------------------- | -------------- | ---------- | -------------------- |
| **Ollama** | `nomic-embed-text` (default), `jina-embeddings-v2-base-code`, `mxbai-embed-large` | 768, 768, 1024 | None       | Local, no API key    |
| **OpenAI** | `text-embedding-3-small` (default), `text-embedding-3-large`    | 1536, 3072     | 3500/min   | Cloud API            |
| **Cohere** | `embed-english-v3.0` (default), `embed-multilingual-v3.0`       | 1024           | 100/min    | Multilingual support |
| **Voyage** | `voyage-2` (default), `voyage-large-2`, `voyage-code-2`         | 1024, 1536     | 300/min    | Code-specialized     |

#### Recommended: Jina Code Embeddings

For code search, we recommend **`jina-embeddings-v2-base-code`** over the default `nomic-embed-text`:

```bash
# Pull the model
ollama pull jina-embeddings-v2-base-code

# Configure
export EMBEDDING_MODEL="jina-embeddings-v2-base-code"
```

**Why Jina Code Embeddings?**

| Aspect | Benefit |
|--------|---------|
| **Code-optimized** | Trained specifically on source code, understands syntax and semantics |
| **Multilingual** | 30+ programming languages with consistent quality |
| **Enterprise-proven** | Battle-tested on 3.5M+ LOC codebases with excellent search relevance |
| **Same dimensions** | 768 dimensions — drop-in replacement for `nomic-embed-text` |

**Note:** Ollama models require pulling before use:

- Podman: `podman exec ollama ollama pull <model-name>`
- Docker: `docker exec ollama ollama pull <model-name>`

## Troubleshooting

| Issue                          | Solution                                                                                  |
| ------------------------------ | ----------------------------------------------------------------------------------------- |
| **Qdrant not running**         | `podman compose up -d` or `docker compose up -d`                                          |
| **Collection missing**         | Create collection first before adding documents                                           |
| **Ollama not running**         | Verify with `curl <http://localhost:11434`>, start with `podman compose up -d`              |
| **Model missing**              | `podman exec ollama ollama pull nomic-embed-text` or `docker exec ollama ollama pull ...` |
| **Rate limit errors**          | Adjust `EMBEDDING_MAX_REQUESTS_PER_MINUTE` to match your provider tier                    |
| **API key errors**             | Verify correct API key in environment configuration                                       |
| **Qdrant unauthorized**        | Set `QDRANT_API_KEY` environment variable for secured instances                           |
| **Filter errors**              | Ensure Qdrant filter format, check field names match metadata                             |
| **Codebase not indexed**       | Run `index_codebase` before `search_code`                                                 |
| **Slow indexing**              | Use Ollama (local) for faster indexing, or increase `CODE_BATCH_SIZE`                     |
| **Files not found**            | Check `.gitignore` and `.contextignore` patterns                                          |
| **Search returns no results**  | Try broader queries, check if codebase is indexed with `get_index_status`                 |
| **Out of memory during index** | Reduce `CODE_CHUNK_SIZE` or `CODE_BATCH_SIZE`                                             |

## Performance Tuning

### Recommended Configurations

Optimal parameters depend on your hardware and deployment setup:

#### Remote Server (Qdrant + Ollama on separate host)

Best for: Dedicated GPU server, shared team infrastructure

```bash
# Network-optimized: larger batches, moderate concurrency
export EMBEDDING_BATCH_SIZE=512
export CODE_BATCH_SIZE=768
export EMBEDDING_CONCURRENCY=4
export DELETE_BATCH_SIZE=500
export DELETE_CONCURRENCY=8
```

#### MacBook M1 (8-core, 8GB+ RAM)

Best for: Light development, small-to-medium codebases (<50k files)

```bash
# Memory-conscious: smaller batches, low concurrency
export EMBEDDING_BATCH_SIZE=128
export CODE_BATCH_SIZE=256
export EMBEDDING_CONCURRENCY=2
export DELETE_BATCH_SIZE=200
export DELETE_CONCURRENCY=4
export MAX_IO_CONCURRENCY=30
```

#### MacBook M3 Pro (12-core, 18GB+ RAM)

Best for: Professional development, medium codebases (<100k files)

```bash
# Balanced: moderate batches, good concurrency
export EMBEDDING_BATCH_SIZE=256
export CODE_BATCH_SIZE=512
export EMBEDDING_CONCURRENCY=4
export DELETE_BATCH_SIZE=500
export DELETE_CONCURRENCY=8
export MAX_IO_CONCURRENCY=50
```

#### MacBook M4 Max (16-core, 48GB+ RAM)

Best for: Large codebases, maximum local performance

```bash
# Performance-optimized: large batches, high concurrency
export EMBEDDING_BATCH_SIZE=512
export CODE_BATCH_SIZE=768
export EMBEDDING_CONCURRENCY=8
export DELETE_BATCH_SIZE=1000
export DELETE_CONCURRENCY=16
export MAX_IO_CONCURRENCY=100
```

### Quick Diagnostic

Run the diagnostic benchmark to automatically find optimal parameters for your setup:

```bash

# Set your endpoints

export QDRANT_URL="http://localhost:6333"
export EMBEDDING_BASE_URL="http://localhost:11434"
export EMBEDDING_MODEL="nomic-embed-text"

# Run diagnostic (takes ~30 seconds)

node benchmarks/diagnose.mjs
```

The diagnostic will test and recommend optimal values for:

- `EMBEDDING_BATCH_SIZE` - texts per embedding API request
- `CODE_BATCH_SIZE` - chunks per Qdrant upsert
- `EMBEDDING_CONCURRENCY` - parallel embedding requests

### Understanding Results

```text
Phase 1: Embedding Batch Size
  Testing EMBEDDING_BATCH_SIZE=64   ████████████████████ 124 emb/s
  Testing EMBEDDING_BATCH_SIZE=256  ████████████████████ 158 emb/s
  Testing EMBEDDING_BATCH_SIZE=512  ████████████████████ 174 emb/s  ← Best
  Testing EMBEDDING_BATCH_SIZE=1024 ███████████████░░░░░ 148 emb/s
  ↳ Stopping: performance degradation detected

  ✓ Optimal: EMBEDDING_BATCH_SIZE=512
```

- **Green bar (████)**: Performance close to best
- **Yellow bar**: Slight degradation
- **Degradation detected**: Batch size too large for GPU memory

### Benchmark Files

| File | Purpose |
|------|---------|
| `benchmarks/diagnose.mjs` | Quick auto-tuning (~30s) |
| `benchmarks/embedding-batch.mjs` | Detailed EMBEDDING_BATCH_SIZE analysis |
| `benchmarks/code-batch.mjs` | Detailed CODE_BATCH_SIZE analysis |
| `benchmarks/concurrency.mjs` | Concurrency + batch size matrix |
| `benchmarks/pipelining.mjs` | Sequential vs pipelined comparison |
| `benchmarks/qdrant-optimized.mjs` | Qdrant wait/ordering options |
| `benchmarks/accumulator-buffer.mjs` | Buffer size + auto-flush optimization |

### Batch Pipeline Optimization

The server uses an accumulator pattern for efficient Qdrant upserts:

```text
Embeddings ──► Buffer (accumulator) ──► Qdrant upsert
                 │                           │
                 └─ flush on size ───────────┘
                 └─ flush on timer (500ms) ──┘
                 └─ flush explicit ──────────┘
```

**How it works:**

- Points are accumulated in a buffer until `CODE_BATCH_SIZE` threshold
- Intermediate batches use `wait=false` (fire-and-forget) for speed
- Final flush uses `wait=true` for consistency
- Auto-flush timer prevents data from being stuck in buffer

Run the accumulator benchmark to find optimal settings:

```bash
QDRANT_URL=http://localhost:6333 \
EMBEDDING_BASE_URL=http://localhost:11434 \
node benchmarks/accumulator-buffer.mjs
```

### Typical Optimal Values

| Hardware | EMBEDDING_BATCH_SIZE | CODE_BATCH_SIZE |
|----------|---------------------|-----------------|
| CPU only | 32-64 | 128-256 |
| GPU 4GB | 128-256 | 256-384 |
| GPU 8GB+ | 512-1024 | 512-768 |
| GPU 12GB+ | 1024-2048 | 768+ |

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

#### Unit Tests (Mocked)

**864 tests** across test files with **97%+ coverage**:

- **Unit Tests**: QdrantManager (56), Ollama (41), OpenAI (25), Cohere (29), Voyage (31), Factory (43), Prompts (50), Transport (15), MCP Server (19)
- **Integration Tests (Mocked)**: Code indexer (56), scanner (15), chunker (24), synchronizer (42), snapshot (26), merkle tree (28)

**CI/CD**: GitHub Actions runs build, type-check, and tests on Node.js 22 LTS for every push/PR.

#### Real Integration Tests

**233 tests** across 18 modular test suites testing against real Qdrant and Ollama:

```bash
# Run all integration tests
npm run test-integration

# Run a specific suite (1-18)
TEST_SUITE=1 npm run test-integration  # Embeddings
TEST_SUITE=18 npm run test-integration # Git Metadata

# Skip cleanup for debugging
SKIP_CLEANUP=1 npm run test-integration
```

**Test Suites**:
1. Embeddings (single, batch, parallel)
2. Qdrant Operations (CRUD, filters, batch delete)
3. PointsAccumulator (batch pipeline)
4. File Indexing Lifecycle
5. Hash & Snapshot Consistency
6. Ignore Patterns
7. Chunk Boundaries & Line Numbers
8. Multi-Language Support
9. Ruby AST Chunking (Rails patterns)
10. Search Accuracy
11. Edge Cases
12. Batch Pipeline in CodeIndexer
13. Concurrent Operations
14. Parallel File Sync & Sharded Snapshots
15. Pipeline & WorkerPool
16. Schema Migration & Delete Optimization
17. ForceReindex & Parallel Indexing
18. Git Metadata Integration

**Requirements**: Running Qdrant (default: `http://localhost:6333`) and Ollama (default: `http://localhost:11434`).

## Contributing

Contributions welcome! See [CONTRIBUTING.md](CONTRIBUTING.md) for:

- Development workflow
- Conventional commit format (`feat:`, `fix:`, `BREAKING CHANGE:`)
- Testing requirements (run `npm test`, `npm run type-check`, `npm run build`)

**Automated releases**: Semantic versioning via conventional commits - `feat:` → minor, `fix:` → patch, `BREAKING CHANGE:` → major.

## Acknowledgments

The code vectorization feature is inspired by and builds upon concepts from the excellent [claude-context](https://github.com/zilliztech/claude-context) project (MIT License, Copyright 2025 Zilliz).

## License

MIT - see [LICENSE](LICENSE) file.

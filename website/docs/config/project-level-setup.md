---
title: Set Up Your Project
sidebar_position: 1
---

# Set Up Your Project

Configure TeaRAGs on a per-project basis using environment variables.

:::info Future: .mcp.json Configuration
Project-level `.mcp.json` configuration file is planned for future release ([tea-rags-mcp-h64](https://github.com/mhalder/tea-rags-mcp/issues)). Currently, use environment variables for project-specific settings.
:::

## Why Project-Level Configuration?

Different codebases have different characteristics:

| Project Type | Custom Settings |
|--------------|-----------------|
| **Monorepo** | Smaller chunk size, exclude build artifacts, multiple ignore patterns |
| **Documentation site** | Larger chunks, disable git enrichment, markdown-only |
| **Enterprise legacy** | Enable git enrichment, custom file extensions, exclude vendor dirs |
| **Microservice** | Fast indexing, minimal enrichment, specific search defaults |

## Current Approach: Environment Variables

Set environment variables before starting the MCP server or in your MCP server configuration.

### Global Configuration

Edit `~/.config/claude/claude_desktop_config.json` (or equivalent):

```json
{
  "mcpServers": {
    "tea-rags": {
      "command": "node",
      "args": ["/path/to/tea-rags-mcp/build/index.js"],
      "env": {
        "CODE_CHUNK_SIZE": "2500",
        "CODE_CHUNK_OVERLAP": "300",
        "CODE_ENABLE_GIT_METADATA": "false",
        "QDRANT_URL": "http://localhost:6333",
        "EMBEDDING_BASE_URL": "http://localhost:11434"
      }
    }
  }
}
```

### Per-Project Workflows

For different projects, you can:

1. **Use `.contextignore`** - Exclude project-specific paths
2. **Use query parameters** - Override settings in MCP tool calls
3. **Switch MCP server configs** - Create multiple server entries with different env vars

## Configuration Categories

### Chunking Settings

Control how code is split into searchable chunks.

| Environment Variable | Type | Default | Description |
|---------------------|------|---------|-------------|
| `CODE_CHUNK_SIZE` | number | 2500 | Maximum chunk size in characters |
| `CODE_CHUNK_OVERLAP` | number | 300 | Overlap between chunks in characters |

**Use cases:**
- **Large chunks (3000+)**: Documentation sites, architectural documents, low file count
- **Small chunks (1500-2000)**: Dense code, many small functions, better precision

**Example:**
```json
{
  "env": {
    "CODE_CHUNK_SIZE": "2000",
    "CODE_CHUNK_OVERLAP": "250"
  }
}
```

### Indexing Settings

Configure what gets indexed and how.

| Environment Variable | Type | Default | Description |
|---------------------|------|---------|-------------|
| `CODE_ENABLE_GIT_METADATA` | boolean | false | Enable git enrichment (19 signals per chunk) |

**Use cases:**
- **Enable git enrichment**: Enterprise projects, legacy codebases, need ownership/churn data
- **Disable git enrichment**: Documentation sites, fast prototyping

:::tip Git Enrichment Performance
Git enrichment runs concurrently with embedding and does not increase indexing time. The process is parallelized across multiple workers:

- `CHUNKER_POOL_SIZE=4` — Parallel AST parsing workers
- `FILE_PROCESSING_CONCURRENCY=50` — Parallel file reads
- `GIT_CHUNK_CONCURRENCY=10` — Parallel git blame operations for chunk-level churn

**Recommended:** Keep defaults for production use.
:::

**Example:**
```json
{
  "env": {
    "CODE_ENABLE_GIT_METADATA": "true"
  }
}
```

### Search Settings

Configure search behavior.

Currently, search settings are specified via **query parameters** in MCP tool calls:

```javascript
// search_code tool
{
  "path": "/path/to/project",
  "query": "authentication logic",
  "limit": 10,
  "rerank": "stable"
}
```

Available rerank presets:
- `relevance` - Default semantic similarity
- `recent` - Boost recently modified code
- `stable` - Boost low-churn, stable code
- `hotspots` - High-churn, bug-prone areas
- `ownership` - Single-author code (knowledge silos)

### Embedding Settings

Configure embedding provider and batching.

| Environment Variable | Type | Default | Description |
|---------------------|------|---------|-------------|
| `EMBEDDING_BASE_URL` | string | `http://localhost:11434` | Ollama server URL |
| `EMBEDDING_MODEL` | string | `unclemusclez/jina-embeddings-v2-base-code:latest` | Embedding model name |
| `EMBEDDING_BATCH_SIZE` | number | Auto-tuned | Chunks per embedding batch |
| `INGEST_PIPELINE_CONCURRENCY` | number | Auto-tuned | Pipeline worker concurrency |

**Example:**
```json
{
  "env": {
    "EMBEDDING_MODEL": "nomic-embed-text:latest",
    "EMBEDDING_BATCH_SIZE": "512",
    "INGEST_PIPELINE_CONCURRENCY": "1"
  }
}
```

## Common Configurations

### Monorepo

```json
{
  "mcpServers": {
    "tea-rags-monorepo": {
      "command": "node",
      "args": ["/path/to/tea-rags-mcp/build/index.js"],
      "env": {
        "CODE_CHUNK_SIZE": "2000",
        "CODE_CHUNK_OVERLAP": "200",
        "CODE_ENABLE_GIT_METADATA": "true"
      }
    }
  }
}
```

**Why:**
- Smaller chunks (2000) for better precision across many packages
- Git enrichment to track ownership across teams

**Additional:** Create `.contextignore` in monorepo root:
```
packages/*/node_modules
packages/*/dist
packages/*/build
tools/**
scripts/**
```

### Documentation Site

```json
{
  "mcpServers": {
    "tea-rags-docs": {
      "command": "node",
      "args": ["/path/to/tea-rags-mcp/build/index.js"],
      "env": {
        "CODE_CHUNK_SIZE": "3500",
        "CODE_CHUNK_OVERLAP": "500",
        "CODE_ENABLE_GIT_METADATA": "false"
      }
    }
  }
}
```

**Why:**
- Large chunks (3500) for complete documentation sections
- No git enrichment (documentation churn is normal)

**Additional:** Create `.contextignore`:
```
node_modules/**
.docusaurus/**
build/**
```

### Legacy Enterprise Codebase

```json
{
  "mcpServers": {
    "tea-rags-legacy": {
      "command": "node",
      "args": ["/path/to/tea-rags-mcp/build/index.js"],
      "env": {
        "CODE_CHUNK_SIZE": "2500",
        "CODE_CHUNK_OVERLAP": "300",
        "CODE_ENABLE_GIT_METADATA": "true"
      }
    }
  }
}
```

**Why:**
- Git enrichment to find code owners and knowledge silos
- Use `rerank: "ownership"` in searches to identify domain experts

**Additional:** Create `.contextignore`:
```
vendor/**
third-party/**
*.generated.*
```

### Microservice

```json
{
  "mcpServers": {
    "tea-rags-microservice": {
      "command": "node",
      "args": ["/path/to/tea-rags-mcp/build/index.js"],
      "env": {
        "CODE_CHUNK_SIZE": "2000",
        "CODE_CHUNK_OVERLAP": "200",
        "CODE_ENABLE_GIT_METADATA": "false"
      }
    }
  }
}
```

**Why:**
- Smaller chunks for focused microservice code
- No git enrichment (fast iteration, small team)
- Use `rerank: "recent"` in searches for actively developed code

**Additional:** Create `.contextignore`:
```
vendor/**
mocks/**
*.pb.go
```

## Priority Order

Settings are resolved in this order (highest priority first):

1. **Query parameters** — passed directly to search/index tools
2. **Environment variables** — MCP server configuration
3. **Defaults** — built-in TeaRAGs defaults

**Example:**

```bash
# Global setting (lowest priority)
export CODE_CHUNK_SIZE=2500

# Query parameter (highest priority)
/index_codebase /path/to/project --chunkSize 1500
```

Result: `chunkSize=1500` (query parameter wins)

## File Location: .contextignore

Place `.contextignore` in the **root of your project** — the same directory you pass to indexing tools.

```
/path/to/project/
├── .contextignore     ← Ignore patterns
├── src/
├── tests/
└── package.json
```

TeaRAGs automatically detects `.contextignore` when indexing that directory.

## Validation

Invalid environment variables are logged but **do not block indexing**. Defaults are used for invalid values.

Enable debug mode to see configuration resolution:

```bash
export DEBUG=1
```

Logs show:
- Which environment variables were loaded
- Which settings were overridden
- Validation errors (if any)

Check logs in `~/.tea-rags-mcp/logs/`

## Best Practices

### 1. Use .contextignore

**Do:** Create `.contextignore` in each project
```bash
# In project root
cat > .contextignore <<EOF
node_modules/**
dist/**
build/**
vendor/**
*.min.js
EOF
```

### 2. Document Your Configuration

Add comments in MCP config or project README:
```markdown
## TeaRAGs Configuration

- `CODE_CHUNK_SIZE: 2000` — Dense microservice code, smaller chunks for precision
- `CODE_ENABLE_GIT_METADATA: false` — Fast iteration, small team, no ownership tracking needed
```

### 3. Test Configuration

After changing settings, reindex and verify:
```bash
# Reindex with new settings
/index_codebase /path/to/project

# Check index status
/get_index_status /path/to/project

# Test search
/search_code /path/to/project "your query"
```

### 4. Start Minimal

Don't override everything. Start with the minimum:
```json
{
  "env": {
    "CODE_CHUNK_SIZE": "2000"
  }
}
```

Add more settings only when needed.

## Troubleshooting

### Settings Not Applied

**Check:**
1. Environment variables are set in MCP server config
2. MCP server was restarted after config changes
3. Variable names match exactly (case-sensitive)
4. Values are valid (numbers as strings, booleans as "true"/"false")

### Invalid Settings Ignored

Enable debug mode:
```bash
export DEBUG=1
```

Check logs in `~/.tea-rags-mcp/logs/` for validation errors.

### Query Parameters Not Overriding

Remember priority order:
- Query parameters > Environment variables > Defaults

If environment variable is set globally, query parameters still override it.

## Next Steps

- **[Configuration Variables](/config/environment-variables)** — see all available settings
- **[Performance Tuning](/config/performance-tuning)** — optimize chunk size and batch settings
- **[Indexing Repositories](/usage/indexing-repositories)** — learn about `.contextignore` patterns

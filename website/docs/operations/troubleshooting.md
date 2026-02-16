---
title: Troubleshooting
sidebar_position: 3
---

# Troubleshooting

## Common Issues

| Issue | Solution |
|-------|----------|
| **Qdrant not running** | `podman compose up -d` or `docker compose up -d` |
| **Collection missing** | Create collection first before adding documents |
| **Ollama not running** | Verify with `curl http://localhost:11434`, start with `podman compose up -d` |
| **Model missing** | `podman exec ollama ollama pull nomic-embed-text` |
| **Rate limit errors** | Adjust `EMBEDDING_MAX_REQUESTS_PER_MINUTE` to match your provider tier |
| **API key errors** | Verify correct API key in environment configuration |
| **Qdrant unauthorized** | Set `QDRANT_API_KEY` environment variable for secured instances |
| **Filter errors** | Ensure Qdrant filter format, check field names match metadata |
| **Codebase not indexed** | Run `index_codebase` before `search_code` |
| **Slow indexing** | Use Ollama (local) for faster indexing, or increase `EMBEDDING_BATCH_SIZE` |
| **Files not found** | Check `.gitignore` and `.contextignore` patterns |
| **Search returns no results** | Try broader queries, check if codebase is indexed with `get_index_status` |
| **Out of memory during index** | Reduce `CODE_CHUNK_SIZE` or `EMBEDDING_BATCH_SIZE` |

## FAQ

### How do I know when indexing is complete?

The MCP server returns a success response with statistics (files indexed, chunks created, time elapsed). You can also check status anytime with `get_index_status`.

### I accidentally cancelled the request. Is my indexing lost?

No worries! Indexing continues in the background until completion. Check progress with `get_index_status`. Already processed chunks are saved via checkpointing.

### How do I stop indexing?

Find and kill the process:

```bash
ps aux | grep tea-rags
kill -9 <PID>
```

### How do I resume interrupted indexing?

Just run `index_codebase` again. Completed steps are cached -- only remaining work will be processed.

### Where are cache snapshots and logs stored?

All data is stored in `~/.tea-rags-mcp/`:

- `snapshots/` -- file hash snapshots for incremental indexing
- `git-cache/` -- git blame cache (L2 disk cache)
- `logs/` -- debug logs (when `DEBUG=1`)

### How do I enable MCP logging?

Run your agent with the DEBUG variable:

```bash
DEBUG=1 claude
```

Or add `DEBUG=true` to your MCP server configuration in `env` section.

# Performance Tuning

Detailed guide to optimizing Tea Rags MCP for your hardware and use case.

## Performance Benchmarks

Benchmarked on hybrid setup: MacBook Pro M3 Pro (client) + Windows PC with 12GB VRAM (Qdrant + Ollama server).

| Codebase Size | Files | Indexing Time | Search Latency |
|---------------|-------|---------------|----------------|
| Small (10k LOC) | ~30 | ~5s | <100ms |
| Medium (50k LOC) | ~150 | ~15s | <100ms |
| Large (100k LOC) | ~300 | ~30s | <200ms |
| Very Large (500k LOC) | ~1,500 | ~2min | <300ms |
| Enterprise (3.5M LOC) | ~10k | ~10min | <500ms |

**Note**: Using Ollama `jina-embeddings-v2-base-code`. CPU-only embedding is 5-10x slower.

## Embedding Performance

### Provider Comparison

| Provider | Speed | Cost | Privacy | Best For |
|----------|-------|------|---------|----------|
| **Ollama** (GPU) | Fastest | Free | Full | Production |
| **Ollama** (CPU) | 5-10x slower | Free | Full | Dev/testing |
| **OpenAI** | Fast | $$ | Cloud | Quick setup |
| **Voyage** | Fast | $$ | Cloud | Code-specific |

### GPU Acceleration

For optimal performance, run Ollama with GPU:

```bash
# Check GPU availability
ollama run nomic-embed-text "test" --verbose

# Recommended: Use code-specialized model
ollama pull jina-embeddings-v2-base-code
export EMBEDDING_MODEL="jina-embeddings-v2-base-code"
```

### Batch Size Tuning

| VRAM | Recommended `EMBEDDING_BATCH_SIZE` |
|------|-----------------------------------|
| 4GB | 32 |
| 8GB | 64 (default) |
| 12GB+ | 128 |
| CPU only | 16 |

```bash
export EMBEDDING_BATCH_SIZE=128  # For 12GB+ VRAM
```

### Concurrency Tuning

For multiple GPUs or high-end hardware:

```bash
# Multiple embedding requests in parallel
export EMBEDDING_CONCURRENCY=2  # For multi-GPU setups
```

## Indexing Performance

### Change Detection

Change detection runs in parallel. Tune based on your disk:

```bash
# For SSD
export MAX_IO_CONCURRENCY=100

# For HDD or network drives
export MAX_IO_CONCURRENCY=20
```

### Batch Pipeline

Control how chunks are sent to Qdrant:

```bash
# Flush interval (ms) - lower = more responsive, higher = more efficient
export QDRANT_FLUSH_INTERVAL_MS=500  # default

# Batch ordering - tradeoff between consistency and speed
export QDRANT_BATCH_ORDERING=weak     # Fastest
export QDRANT_BATCH_ORDERING=medium   # Balanced
export QDRANT_BATCH_ORDERING=strong   # Safest
```

### Delete Operations

Optimized delete batching for large codebases:

```bash
# Paths per delete batch (with payload index)
export DELETE_BATCH_SIZE=500

# Parallel delete requests
export DELETE_CONCURRENCY=8
```

## Search Performance

### Qdrant Optimization

For large collections, ensure Qdrant has enough resources:

```yaml
# docker-compose.yml
services:
  qdrant:
    image: qdrant/qdrant:latest
    deploy:
      resources:
        limits:
          memory: 4G  # Increase for large codebases
```

### Query Optimization

1. **Use filters** - Narrow search scope with `fileTypes`, `pathPattern`
2. **Limit results** - Request only needed results
3. **Hybrid search** - Enable for better precision on technical queries

### Caching

Git metadata uses two-level caching:

| Cache | Location | Purpose |
|-------|----------|---------|
| L1 (Memory) | In-process | Hot data, instant access |
| L2 (Disk) | `~/.tea-rags-mcp/` | Persistent, survives restarts |

Cache is invalidated automatically when file content changes.

## Hardware Recommendations

### Minimum (Development)

- 4GB RAM
- SSD storage
- CPU embedding (slow but works)

### Recommended (Production)

- 8GB RAM
- GPU with 8GB+ VRAM
- SSD storage
- Dedicated Qdrant instance

### Enterprise (Large Codebases)

- 16GB+ RAM
- GPU with 12GB+ VRAM
- NVMe SSD
- Clustered Qdrant

## Tuning Checklist

### Initial Setup

- [ ] GPU detected by Ollama
- [ ] Code-specialized embedding model pulled
- [ ] `EMBEDDING_BATCH_SIZE` set for your VRAM
- [ ] SSD storage for Qdrant data

### Large Codebase (500k+ LOC)

- [ ] Increase `EMBEDDING_BATCH_SIZE`
- [ ] Set `MAX_IO_CONCURRENCY=100`
- [ ] Increase Qdrant memory limits
- [ ] Use `.contextignore` to exclude noise

### Slow Search

- [ ] Check Qdrant logs for errors
- [ ] Verify collection has payload indexes
- [ ] Reduce result limit
- [ ] Use more specific filters

### Memory Issues

- [ ] Reduce `CODE_CHUNK_SIZE`
- [ ] Reduce `CODE_BATCH_SIZE`
- [ ] Increase Qdrant memory
- [ ] Index subdirectories separately

## Monitoring

### Debug Mode

Enable detailed timing logs:

```bash
export DEBUG=1
```

Logs are written to `~/.tea-rags-mcp/logs/`.

### Index Status

Monitor indexing progress:

```bash
/mcp__qdrant__get_index_status /path/to/project
```

Returns:
- Current status (not_indexed, indexing, indexed)
- Chunk count
- Last update time
- Collection statistics

## Common Issues

### Slow Initial Indexing

| Cause | Solution |
|-------|----------|
| CPU embedding | Use GPU-accelerated Ollama |
| Cloud provider rate limits | Switch to Ollama |
| Large files | Exclude with `.contextignore` |
| Many small files | Increase `CODE_BATCH_SIZE` |

### Memory Exhaustion

| Cause | Solution |
|-------|----------|
| Large chunks | Reduce `CODE_CHUNK_SIZE` |
| Large batches | Reduce `CODE_BATCH_SIZE` |
| Qdrant memory | Increase container limits |

### Slow Search

| Cause | Solution |
|-------|----------|
| No filters | Add `fileTypes`, `pathPattern` |
| Large collection | Use hybrid search |
| Network latency | Run Qdrant locally |

## Configuration Summary

```bash
# Recommended for 12GB VRAM, large codebase
export EMBEDDING_MODEL="jina-embeddings-v2-base-code"
export EMBEDDING_BATCH_SIZE=128
export EMBEDDING_CONCURRENCY=1
export CODE_CHUNK_SIZE=2500
export CODE_BATCH_SIZE=100
export MAX_IO_CONCURRENCY=100
export QDRANT_BATCH_ORDERING=weak
export DEBUG=0  # Set to 1 for troubleshooting
```

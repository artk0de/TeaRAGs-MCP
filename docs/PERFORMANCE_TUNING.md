# Performance Tuning

Detailed guide to optimizing Tea Rags MCP for your hardware and use case.

## 🎯 Auto-Tuning (Recommended)

The easiest way to optimize is to run the auto-tuning benchmark:

```bash
npm run tune
```

This will:
1. Test different batch sizes, concurrency levels, and ordering modes
2. Automatically stop when optimal values are found
3. Generate `tuned_environment_variables.env` with recommended settings
4. Show estimated indexing times for various project sizes

### Benchmark Configuration

Configure the benchmark via environment variables:

| Variable | Description | Default |
|----------|-------------|---------|
| `QDRANT_URL` | Qdrant server URL | `http://localhost:6333` |
| `EMBEDDING_BASE_URL` | Ollama server URL | `http://localhost:11434` |
| `EMBEDDING_MODEL` | Embedding model name | `unclemusclez/jina-embeddings-v2-base-code:latest` |
| `EMBEDDING_DIMENSION` | Vector dimension | Auto-detected from model response |
| `CODE_CHUNK_SIZE` | Size of test chunks in characters | `2500` (realistic GPU load) |
| `TUNE_SAMPLE_SIZE` | Total number of test chunks to generate | `4096` |
| `BATCH_TEST_SAMPLES` | Samples per batch size test | `256` (balance speed/accuracy) |

**Important Notes:**
- `CODE_CHUNK_SIZE=2500` simulates realistic code chunk workload (85-90% GPU utilization)
- `BATCH_TEST_SAMPLES=256` provides good accuracy while keeping tests fast (~5s per test)
- Vector dimension is auto-detected by making a test embedding call - no manual configuration needed

**Local setup** (defaults work out of the box):
```bash
npm run tune
```

**Remote GPU setup**:
```bash
EMBEDDING_BASE_URL=http://192.168.1.100:11434 npm run tune
```

**Full remote setup**:
```bash
QDRANT_URL=http://192.168.1.100:6333 \
EMBEDDING_BASE_URL=http://192.168.1.100:11434 \
npm run tune
```

**Custom model**:
```bash
EMBEDDING_MODEL=nomic-embed-text npm run tune
```

Increase `TUNE_SAMPLE_SIZE` for more accurate results (at the cost of longer benchmark time):

```bash
# More accurate results for production tuning
TUNE_SAMPLE_SIZE=4096 npm run tune

# Quick check with fewer samples
TUNE_SAMPLE_SIZE=1024 npm run tune
```

### Output

The benchmark creates `tuned_environment_variables.env` in the project root:

```bash
# Tea Rags MCP - Tuned Environment Variables
# Generated: 2026-02-01T16:22:01.258Z
# Hardware: http://localhost:11434 (jina-embeddings-v2-base-code)
# Duration: 60s
# Sample size: 2048 chunks

# Embedding configuration
EMBEDDING_BATCH_SIZE=128
EMBEDDING_CONCURRENCY=2

# Qdrant storage configuration
CODE_BATCH_SIZE=384
QDRANT_BATCH_ORDERING=weak
QDRANT_FLUSH_INTERVAL_MS=100

# Qdrant deletion configuration
QDRANT_DELETE_BATCH_SIZE=1000
QDRANT_DELETE_CONCURRENCY=8

# Performance metrics (for reference)
# Embedding rate: 136 emb/s
# Storage rate: 7288 chunks/s
# Deletion rate: 157538 del/s

# Estimated indexing times:
# Small CLI tool       (10K LoC): 2s
# Medium library       (50K LoC): 11s
# Large library        (100K LoC): 21s
# Enterprise app       (500K LoC): 1m 47s
# Large codebase       (1.0M LoC): 3m 34s
# VS Code              (3.5M LoC): 12m 29s
# Kubernetes           (5.0M LoC): 17m 50s
# Linux kernel         (10.0M LoC): 35m 40s
```

### Stopping Criteria

The benchmark automatically stops testing each parameter when:
- Performance drops 20% from the best result found
- 3 consecutive degradations occur
- Test timeout (45s) exceeded
- Error rate exceeds 10%

This ensures the benchmark completes quickly (~60-90 seconds) while finding optimal values

## 🎯 Embeddings Benchmark

For GPU-specific optimization and testing embedding throughput only:

```bash
npm run benchmark-embeddings
```

This focused benchmark:
- Tests **only** embedding parameters (`EMBEDDING_BATCH_SIZE` and `EMBEDDING_CONCURRENCY`)
- Skips Qdrant storage tests (faster, ~30-45 seconds)
- Focuses on GPU utilization and embedding throughput
- Shows embeddings per second (emb/s) instead of chunks/sec

### When to Use

Use `benchmark-embeddings` when you:
- Want to optimize GPU utilization without testing Qdrant
- Are comparing different embedding models
- Need to tune for CPU vs GPU performance
- Want quick feedback on embedding performance

Use `tune` (full benchmark) when you:
- Need complete end-to-end optimization
- Want to optimize both embedding AND storage
- Are setting up production configuration

### Output Differences

**`npm run tune`** (full benchmark):
```
Embedding:  54 chunks/sec
Storage:    6617 chunks/sec
Bottleneck: embedding (54 chunks/sec)
```

**`npm run benchmark-embeddings`** (embedding-only):
```
Embedding rate:     54 emb/s
Time per embedding: 18.52 ms
```

### Example: Testing Different Models

```bash
# Test jina-embeddings-v2-base-code (768 dims)
EMBEDDING_MODEL=jina-embeddings-v2-base-code npm run benchmark-embeddings

# Test mxbai-embed-large (1024 dims)
EMBEDDING_MODEL=mxbai-embed-large:latest npm run benchmark-embeddings

# Test nomic-embed-text (768 dims)
EMBEDDING_MODEL=nomic-embed-text npm run benchmark-embeddings
```

### Quick GPU Test

```bash
# Quick 64-sample test for fast feedback
TUNE_SAMPLE_SIZE=64 npm run benchmark-embeddings
```

## Deployment Topologies

### 🏠 Fully Local Setup

Everything runs on your machine:

```
┌─────────────────────────────────────┐
│          Your Machine               │
│  ┌─────────┐  ┌───────┐  ┌───────┐  │
│  │ Claude  │→ │Ollama │→ │Qdrant │  │
│  │  Code   │  │(GPU)  │  │(Docker)│ │
│  └─────────┘  └───────┘  └───────┘  │
└─────────────────────────────────────┘
```

**Pros:** Lowest latency, fastest storage, fully offline
**Cons:** Uses local GPU/CPU resources

**Typical tuned values:**
```bash
EMBEDDING_BATCH_SIZE=64
EMBEDDING_CONCURRENCY=2
CODE_BATCH_SIZE=192
QDRANT_BATCH_ORDERING=weak
QDRANT_FLUSH_INTERVAL_MS=100
QDRANT_DELETE_BATCH_SIZE=750
QDRANT_DELETE_CONCURRENCY=4
```

### ⭐ Remote GPU + Local Qdrant (Recommended)

Embedding on a dedicated GPU server, Qdrant runs locally in Docker:

```
┌──────────────────────────┐         ┌─────────────────┐
│      Your Machine        │   LAN   │   GPU Server    │
│  ┌─────────┐  ┌───────┐  │ ──────→ │   ┌───────┐     │
│  │ Claude  │→ │Qdrant │  │         │   │Ollama │     │
│  │  Code   │  │(Docker)│ │ ←────── │   │(GPU)  │     │
│  └─────────┘  └───────┘  │         │   └───────┘     │
└──────────────────────────┘         └─────────────────┘
```

**Pros:** Best of both worlds — fast GPU embedding + fast local storage
**Cons:** Requires local Docker for Qdrant

**Typical tuned values:**
```bash
EMBEDDING_BATCH_SIZE=48
EMBEDDING_CONCURRENCY=4
CODE_BATCH_SIZE=192
QDRANT_BATCH_ORDERING=strong
QDRANT_FLUSH_INTERVAL_MS=100
QDRANT_DELETE_BATCH_SIZE=750
QDRANT_DELETE_CONCURRENCY=4
```

### 🌐 Full Remote Setup

Both Qdrant and Ollama on a dedicated server (e.g., Windows PC with GPU):

```
┌──────────────┐         ┌─────────────────────┐
│ Your Machine │   LAN   │    GPU Server       │
│  ┌─────────┐ │ ──────→ │ ┌───────┐ ┌───────┐ │
│  │ Claude  │ │         │ │Ollama │ │Qdrant │ │
│  │  Code   │ │ ←────── │ │(GPU)  │ │       │ │
│  └─────────┘ │         │ └───────┘ └───────┘ │
└──────────────┘         └─────────────────────┘
```

**Pros:** Dedicated GPU, doesn't affect local machine resources
**Cons:** Network latency significantly impacts storage throughput

**Typical tuned values:**
```bash
EMBEDDING_BATCH_SIZE=48
EMBEDDING_CONCURRENCY=4
CODE_BATCH_SIZE=128
QDRANT_BATCH_ORDERING=medium
QDRANT_FLUSH_INTERVAL_MS=250
QDRANT_DELETE_BATCH_SIZE=750
QDRANT_DELETE_CONCURRENCY=4
```

### Performance Comparison

| Metric | 🏠 Fully Local | ⭐ Remote GPU + Local Qdrant | 🌐 Full Remote |
|--------|----------------|------------------------------|----------------|
| **Qdrant latency** | <1ms | <1ms | 5-50ms |
| **Storage rate** | 7136 ch/s | 7288 ch/s | 1994 ch/s |
| **Embedding rate** | 142 emb/s | 177 emb/s | 173 emb/s |
| **Optimal ordering** | `weak` | `strong` | `medium` |
| **Flush interval** | 100ms | 100ms | 250ms |

> **Why is Full Remote storage slower?**
> Each batch upsert requires a network round-trip (request → processing → response). Even on local LAN with 1-5ms latency, this adds up when sending thousands of batches. Local Docker uses loopback interface with microsecond latency.

### Recommended Setup

**⭐ Remote GPU + Local Qdrant** is the recommended setup for most users:

| Factor | Why This Setup Wins |
|--------|---------------------|
| **Total indexing time** | Fastest overall (~9.6 min for VS Code 3.5M LoC) |
| **Storage performance** | Local Qdrant = microsecond latency, 7288 ch/s |
| **Embedding performance** | Dedicated GPU = 177 emb/s |
| **Resource usage** | Only Docker for Qdrant locally (lightweight) |
| **Flexibility** | GPU server can serve multiple machines |

**When to choose other setups:**

- **Fully Local**: When you have a powerful GPU on your development machine and want to work fully offline
- **Full Remote**: When you cannot run Docker locally (e.g., corporate restrictions) or need to index from multiple thin clients

## Performance Benchmarks

### Estimated Indexing Times

| Codebase | LoC | 🏠 Fully Local | ⭐ Remote GPU + Local Qdrant | 🌐 Full Remote |
|----------|-----|----------------|------------------------------|----------------|
| Small CLI tool | 10K | ~2s | ~2s | ~2s |
| Medium library | 50K | ~10s | ~8s | ~8s |
| Large library | 100K | ~20s | ~16s | ~16s |
| Enterprise app | 500K | ~1m 41s | ~1m 20s | ~1m 23s |
| Large codebase | 1M | ~3m 22s | ~2m 40s | ~2m 46s |
| VS Code | 3.5M | ~11m 47s | ~9m 23s | ~9m 39s |
| Kubernetes | 5M | ~16m 50s | ~13m 23s | ~13m 47s |
| Linux kernel | 10M | ~33m 40s | ~26m 47s | ~27m 33s |

**Note**: Times based on `jina-embeddings-v2-base-code` model. CPU-only embedding is 5-10x slower.

**Benchmark hardware:**
- Local: Apple M3 Pro, Docker Qdrant, local Ollama
- Remote GPU: NVIDIA GPU server (Windows) via LAN, jina-embeddings-v2-base-code
- Measured rates: Local 142 emb/s, Remote GPU + Local Qdrant 177 emb/s, Full Remote 173 emb/s

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
export QDRANT_DELETE_BATCH_SIZE=500

# Parallel delete requests
export QDRANT_DELETE_CONCURRENCY=8
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

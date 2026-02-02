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
| `MEDIAN_CODE_CHUNK_SIZE` | Median chunk size in characters | `500` (matches production collections) |
| `MAX_TOTAL_CHUNKS` | Maximum chunks per batch test | `4096` |

**Important Notes:**
- `MEDIAN_CODE_CHUNK_SIZE=500` matches median chunk size in real production collections
- Embedding calibration uses adaptive chunk count: `min(batch×2, MAX_TOTAL_CHUNKS)` per batch size
- Vector dimension is auto-detected by making a test embedding call - no manual configuration needed
- Three-phase plateau detection algorithm finds stable optimal configurations, not theoretical peaks

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

Increase `MAX_TOTAL_CHUNKS` for more accurate results (at the cost of longer benchmark time):

```bash
# More accurate results for production tuning
MAX_TOTAL_CHUNKS=8192 npm run tune

# Quick check with fewer samples
MAX_TOTAL_CHUNKS=2048 npm run tune
```

### Output

The benchmark creates `tuned_environment_variables.env` in the project root:

```bash
# Tea Rags MCP - Tuned Environment Variables
# Generated: 2026-02-01T16:22:01.258Z
# Hardware: http://localhost:11434 (jina-embeddings-v2-base-code)
# Duration: 60s
# Max chunks: 4096

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

## 🎯 Embeddings Benchmark

For GPU-specific optimization using three-phase plateau detection:

```bash
npm run benchmark-embeddings
```

### Three-Phase Calibration Algorithm

This benchmark uses a sophisticated plateau-detection algorithm designed for production robustness:

#### **Phase 1: Batch Plateau Detection** (CONCURRENCY=1)
- Tests batch sizes: [256, 512, 1024, 2048, 3072, 4096]
- Uses adaptive chunk count: `min(batch×2, MAX_TOTAL_CHUNKS)` per batch
- Stops when improvement < 3% (plateau detected) or timeout exceeded
- Plateau timeout: calculated from previous throughput to detect degradation early

#### **Phase 2: Concurrency Testing** (on plateau only)
- Tests concurrency: [1, 2, 4] on plateau batches only
- Plateau timeout: calculated from baseline (CONC=1) throughput
- Stops testing higher concurrency if timeout exceeded (degradation)
- Reuses CONC=1 results from Phase 1 (no redundant testing)

#### **Phase 3: Robust Selection**
- Selects from configurations within 2% of maximum throughput
- **Prefers**: Lower concurrency → Lower batch size → Higher throughput
- Avoids overfitting to noise, reduces tail-risk

### Key Principles

The algorithm follows engineering best practices:

1. **Adaptive Workload**: Each batch size tests `min(batch×2, MAX_TOTAL_CHUNKS)` chunks
2. **Plateau Over Peak**: Seeks stable performance range, not theoretical maximum
3. **Noise Tolerance**: Differences < 2-3% considered measurement noise
4. **Robustness**: Prefers simpler configs (lower concurrency/batch) when performance is equivalent

### When to Use

Use `benchmark-embeddings` when you:
- Want to understand GPU/CPU characteristics without Qdrant
- Are comparing different embedding models
- Need to diagnose embedding bottlenecks
- Want to see the full calibration process with detailed output

Use `tune` (full benchmark) when you:
- Need complete end-to-end optimization (embedding + Qdrant)
- Want production-ready configuration file
- Are setting up new deployment

### Example Output (Remote GPU)

```
Phase 1: Batch Plateau Detection (CONCURRENCY=1)
   512 chunks @ batch 256              143 chunks/s  (3.6s)  +100.0%
  1024 chunks @ batch 512  (max 11.1s) 145 chunks/s  (7.1s)  +1.4%
  → Plateau detected, stopping
  Plateau batches: [256, 512]

Phase 2: Concurrency Effect Test
  BATCH=256
    CONC=1  (from Phase 1)  143 chunks/s
    CONC=2  (1024 chunks, max 11.1s)  STABLE  152 chunks/s  +6.3%
    CONC=4  (2048 chunks, max 22.1s)  STABLE  153 chunks/s  +0.7%
    → Concurrency plateau, stopping
  BATCH=512
    CONC=1  (from Phase 1)  145 chunks/s
    CONC=2  (2048 chunks, max 21.8s)  STABLE  147 chunks/s  +1.4%
    → Concurrency plateau, stopping

Phase 3: Configuration Selection
  Acceptable configurations: 5/5
  Max throughput: 153 chunks/s

  Recommended configurations:
  🏠 Local GPU:  BATCH_SIZE=512  CONCURRENCY=2  (153 chunks/s)
  🌐 Remote GPU: BATCH_SIZE=256  CONCURRENCY=4  (153 chunks/s)

  Detected setup: 🌐 Remote
  Selected: BATCH_SIZE=256, CONCURRENCY=4
```

**Hardware:** Remote AMD Radeon 7800M GPU via LAN, jina-embeddings-v2-base-code

### Testing Different Models

```bash
# Test jina-embeddings-v2-base-code (768 dims) - default
npm run benchmark-embeddings

# Test different model
EMBEDDING_MODEL=mxbai-embed-large:latest npm run benchmark-embeddings

# Remote GPU
EMBEDDING_BASE_URL=http://192.168.1.100:11434 npm run benchmark-embeddings
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
**Cons:** Uses local GPU/CPU resources, slower embedding than remote GPU

**Calibrated values (M3 Pro, jina-embeddings-v2-base-code):**
```bash
EMBEDDING_BATCH_SIZE=512
EMBEDDING_CONCURRENCY=1
CODE_BATCH_SIZE=192
QDRANT_BATCH_ORDERING=weak
QDRANT_FLUSH_INTERVAL_MS=100
QDRANT_DELETE_BATCH_SIZE=1500
QDRANT_DELETE_CONCURRENCY=12
# Embedding: 87 chunks/s, Storage: 6273 chunks/s
```

**Why these values:**
- `EMBEDDING_BATCH_SIZE=512` + `CONCURRENCY=1`: GPU-bound workload, concurrency adds overhead without benefit
- `QDRANT_BATCH_ORDERING=weak`: Local Qdrant doesn't need strong ordering guarantees
- `QDRANT_FLUSH_INTERVAL_MS=100`: Fast flushes for local SSD

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

**Calibrated values (Remote AMD 7800M + local Qdrant):**
```bash
EMBEDDING_BATCH_SIZE=256
EMBEDDING_CONCURRENCY=6
CODE_BATCH_SIZE=512
QDRANT_BATCH_ORDERING=strong
QDRANT_FLUSH_INTERVAL_MS=250
QDRANT_DELETE_BATCH_SIZE=500
QDRANT_DELETE_CONCURRENCY=16
# Embedding: 156 chunks/s, Storage: 6966 chunks/s
```

**Why these values:**
- `EMBEDDING_BATCH_SIZE=256` + `CONCURRENCY=6`: Network latency hidden by concurrent requests
- `QDRANT_BATCH_ORDERING=strong`: Higher ordering ensures data consistency
- Higher storage rate (6966 chunks/s) because Qdrant is local

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
**Cons:** Network latency significantly impacts storage throughput (~4x slower than local)

**Calibrated values (Remote AMD 7800M + remote Qdrant):**
```bash
EMBEDDING_BATCH_SIZE=256
EMBEDDING_CONCURRENCY=4
CODE_BATCH_SIZE=256
QDRANT_BATCH_ORDERING=weak
QDRANT_FLUSH_INTERVAL_MS=500
QDRANT_DELETE_BATCH_SIZE=1000
QDRANT_DELETE_CONCURRENCY=12
# Embedding: 154 chunks/s, Storage: 1810 chunks/s
```

**Why these values:**
- `EMBEDDING_BATCH_SIZE=256` + `CONCURRENCY=4`: Balance between hiding latency and avoiding queue buildup
- `QDRANT_BATCH_ORDERING=weak`: Reduce round-trips over network
- `QDRANT_FLUSH_INTERVAL_MS=500`: Larger flush windows amortize network latency
- Storage is bottlenecked by network (1810 chunks/s vs 6966 for local)

### Performance Comparison

| Metric | 🏠 Fully Local (M3 Pro) | ⭐ Remote GPU + Local Qdrant | 🌐 Full Remote |
|--------|-------------------------|------------------------------|----------------|
| Optimal batch | 512 | 256 | 256 |
| Optimal concurrency | 1 | 6 | 4 |
| Optimal ordering | `weak` | `strong` | `weak` |
| **Qdrant latency** | **<1ms** | **<1ms** | 5-50ms |
| **Storage rate** | 6273 ch/s | **6966 ch/s** | 1810 ch/s |
| **Embedding rate** | 87 ch/s | **156 ch/s** | 154 ch/s |
| **VS Code (3.5M LoC)** | 13m 36s | **7m 39s** | 8m 13s |

> **Why is Full Remote storage slower?**
> Each batch upsert requires a network round-trip (request → processing → response). Even on local LAN with 1-5ms latency, this adds up when sending thousands of batches. Local Docker uses loopback interface with microsecond latency.

> **Why different EMBEDDING_BATCH_SIZE and CONCURRENCY?**
> - **Local GPU (512/1)**: GPU-bound workload. Larger batches = less overhead. Concurrency adds no benefit.
> - **Remote GPU (256/4-6)**: Network latency is significant. Smaller batches + higher concurrency hides latency by overlapping network I/O with GPU compute. While one batch transfers, GPU processes another.

### Recommended Setup

**⭐ Remote GPU + Local Qdrant** is the recommended setup for most users:

| Factor | Why This Setup Wins |
|--------|---------------------|
| **Total indexing time** | Fastest overall (~7m 39s for VS Code 3.5M LoC) |
| **Storage performance** | Local Qdrant = microsecond latency, 6966 ch/s |
| **Embedding performance** | Dedicated GPU = 156 ch/s (1.8x faster than local M3) |
| **Resource usage** | Only Docker for Qdrant locally (lightweight) |
| **Flexibility** | GPU server can serve multiple machines |

**When to choose other setups:**

- **Fully Local**: When you have a powerful GPU on your development machine and want to work fully offline. M3 Pro achieves 87 ch/s which is still fast for most projects.
- **Full Remote**: When you cannot run Docker locally (e.g., corporate restrictions) or need to index from multiple thin clients. Network latency reduces storage to 1810 ch/s but embedding remains fast at 154 ch/s.

## Performance Benchmarks

### Estimated Indexing Times

| Codebase | LoC | Chunks | 🏠 Local (87 ch/s) | ⭐ Remote GPU (156 ch/s) | 🌐 Full Remote (154 ch/s) |
|----------|-----|--------|-------------------|-------------------------|---------------------------|
| Small CLI tool | 10K | 200 | 2s | 1s | 1s |
| Medium library | 50K | 1K | 12s | 7s | 7s |
| Large library | 100K | 2K | 23s | 13s | 14s |
| Enterprise app | 500K | 10K | 1m 57s | 1m 6s | 1m 10s |
| Large codebase | 1M | 20K | 3m 53s | 2m 11s | 2m 21s |
| **VS Code** | **3.5M** | **70K** | **13m 36s** | **7m 39s** | **8m 13s** |
| Kubernetes | 5M | 100K | 19m 25s | 10m 55s | 11m 45s |
| Linux kernel | 10M | 200K | 38m 51s | 21m 51s | 23m 29s |

**Note**: Based on CODE_CHUNK_SIZE=2500, AVG_LOC_PER_CHUNK=50, jina-embeddings-v2-base-code. CPU-only embedding is 5-10x slower.

**Benchmark hardware:**
- Local: Apple M3 Pro, Docker Qdrant, local Ollama
- Remote GPU: AMD Radeon RX 7800M (external eGPU) via LAN
- Model: unclemusclez/jina-embeddings-v2-base-code:latest

**Measured rates:**
| Setup | Embedding Rate | Storage Rate | Bottleneck |
|-------|---------------|--------------|------------|
| 🏠 Local | 87 ch/s | 6273 ch/s | Embedding |
| ⭐ Remote GPU | **156 ch/s** | **6966 ch/s** | Embedding |
| 🌐 Full Remote | 154 ch/s | 1810 ch/s | Embedding |

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
export EMBEDDING_MODEL="jina-unclemusclez/jina-embeddings-v2-base-code:latest-v2-base-code"
```

### Batch Size Tuning

**Key Insight**: Optimal batch size depends on whether Ollama is local or remote.

| Setup | Recommended `EMBEDDING_BATCH_SIZE` | Why |
|-------|-----------------------------------|-----|
| Local GPU | 512 | Minimize per-batch overhead |
| Remote GPU | 256 | Smaller batches + concurrency hides latency |
| CPU only | 64-128 | Balance memory vs throughput |

```bash
# Local GPU
export EMBEDDING_BATCH_SIZE=512
export EMBEDDING_CONCURRENCY=1

# Remote GPU
export EMBEDDING_BATCH_SIZE=256
export EMBEDDING_CONCURRENCY=4
```

### Concurrency Tuning

**Key Insight**: Concurrency is **only beneficial for remote GPU**. Local GPU sees no improvement from concurrency — it adds overhead without benefit.

| Setup | Recommended `EMBEDDING_CONCURRENCY` | Why |
|-------|-------------------------------------|-----|
| Local GPU | 1 | GPU-bound, concurrency adds overhead |
| Remote GPU | 4-6 | Hide network latency with parallel requests |

```bash
# For local GPU — don't use concurrency
export EMBEDDING_CONCURRENCY=1

# For remote GPU — use concurrency to hide network latency
export EMBEDDING_CONCURRENCY=4
```

### Performance Insights

Based on extensive benchmarking across different setups:

1. **Local M3 Pro is GPU-bound**: Adding concurrency does not improve throughput. BATCH=512 + CONC=1 achieves peak performance (87 ch/s).

2. **Remote GPU benefits from concurrency**: While one batch transfers over network, GPU processes another. CONC=4-6 hides ~90% of network latency.

3. **Storage rate is consistent for local Qdrant**: ~6300-7000 ch/s regardless of where Ollama runs. This confirms storage is not the bottleneck.

4. **Network latency crushes remote Qdrant storage**: 6966 ch/s → 1810 ch/s (3.8x drop). Always run Qdrant locally if possible.

5. **Plateau detection is reliable**: The algorithm stops testing early when improvements drop below 3%, saving significant benchmark time.

6. **Embedding is always the bottleneck**: Even at 156 ch/s (remote GPU), embedding is 40x slower than storage (6966 ch/s). Invest in GPU, not Qdrant infrastructure.

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

### Local GPU Setup (M3 Pro or similar)

```bash
export EMBEDDING_MODEL="unclemusclez/jina-embeddings-v2-base-code:latest"
export EMBEDDING_BATCH_SIZE=512
export EMBEDDING_CONCURRENCY=1
export CODE_BATCH_SIZE=192
export QDRANT_BATCH_ORDERING=weak
export QDRANT_FLUSH_INTERVAL_MS=100
export QDRANT_DELETE_BATCH_SIZE=1500
export QDRANT_DELETE_CONCURRENCY=12
# Expected: 87 ch/s embedding, 6273 ch/s storage
```

### Remote GPU Setup (AMD Radeon 7800M via LAN)

```bash
export EMBEDDING_BASE_URL=http://your-gpu-server:11434
export EMBEDDING_MODEL="unclemusclez/jina-embeddings-v2-base-code:latest"
export EMBEDDING_BATCH_SIZE=256
export EMBEDDING_CONCURRENCY=6
export CODE_BATCH_SIZE=512
export QDRANT_BATCH_ORDERING=strong
export QDRANT_FLUSH_INTERVAL_MS=250
export QDRANT_DELETE_BATCH_SIZE=500
export QDRANT_DELETE_CONCURRENCY=16
# Expected: 156 ch/s embedding, 6966 ch/s storage
```

### Full Remote Setup (GPU + Qdrant on remote server)

```bash
export QDRANT_URL=http://your-server:6333
export EMBEDDING_BASE_URL=http://your-server:11434
export EMBEDDING_MODEL="unclemusclez/jina-embeddings-v2-base-code:latest"
export EMBEDDING_BATCH_SIZE=256
export EMBEDDING_CONCURRENCY=4
export CODE_BATCH_SIZE=256
export QDRANT_BATCH_ORDERING=weak
export QDRANT_FLUSH_INTERVAL_MS=500
export QDRANT_DELETE_BATCH_SIZE=1000
export QDRANT_DELETE_CONCURRENCY=12
# Expected: 154 ch/s embedding, 1810 ch/s storage
```

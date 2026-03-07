---
title: Performance Tuning
sidebar_position: 5
---

import MermaidTeaRAGs from '@site/src/components/MermaidTeaRAGs';

# Performance Tuning

## Auto-Tuning Benchmark

Don't guess — let the benchmark find optimal settings for your hardware:

```bash
npm run tune
```

Creates `tuned_environment_variables.env` with optimal values in ~60-90 seconds.

**For local setup**, just run `npm run tune` — defaults work out of the box:

- `QDRANT_URL` defaults to `http://localhost:6333`
- `EMBEDDING_BASE_URL` defaults to `http://localhost:11434`
- `EMBEDDING_MODEL` defaults to `unclemusclez/jina-embeddings-v2-base-code:latest`

**For remote setup**, configure via environment variables:

```bash
QDRANT_URL=http://192.168.1.100:6333 \
EMBEDDING_BASE_URL=http://192.168.1.100:11434 \
npm run tune
```

The benchmark tests 7 parameters and shows estimated indexing times:

```
Phase 1: Embedding Batch Size ... Optimal: 128
Phase 2: Embedding Concurrency ... Optimal: 2
Phase 3: Qdrant Batch Size ... Optimal: 384
```

Then add tuned values to your MCP config:

```bash
claude mcp add tea-rags -s user -- node /path/to/tea-rags-mcp/build/index.js \
  -e QDRANT_URL=http://localhost:6333 \
  -e EMBEDDING_BATCH_SIZE=256 \
  -e INGEST_PIPELINE_CONCURRENCY=2 \
  -e QDRANT_UPSERT_BATCH_SIZE=384
```

## Embeddings-Only Benchmark

For GPU-specific optimization without Qdrant (embedding calibration only):

```bash
npm run benchmark-embeddings
```

This benchmark uses a **three-phase plateau detection algorithm** designed for production robustness.

### Three-Phase Calibration Algorithm

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

Use `npm run benchmark-embeddings` when you:
- Want to understand GPU/CPU characteristics without Qdrant
- Are comparing different embedding models
- Need to diagnose embedding bottlenecks
- Want to see the full calibration process with detailed output

Use `npm run tune` (full benchmark) when you:
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

## Indexing Benchmarks

| Codebase | LoC | Local Setup | Remote GPU |
|----------|-----|------------|------------|
| Small CLI tool | 10K | ~2s | ~2s |
| Medium library | 50K | ~11s | ~9s |
| Large library | 100K | ~21s | ~17s |
| Enterprise app | 500K | ~2 min | ~1.5 min |
| Large codebase | 1M | ~3.5 min | ~3 min |
| VS Code | 3.5M | ~12 min | ~10 min |
| Kubernetes | 5M | ~18 min | ~15 min |
| Linux kernel | 10M | ~36 min | ~29 min |

## Deployment Topologies

### 🏠 Fully Local Setup

Everything runs on your machine — lowest latency, fully offline.

<MermaidTeaRAGs>
{`
flowchart LR
    subgraph machine["💻 Your Machine"]
        claude["🤖 Coding Agent"]
        ollama["✨ Ollama<br/><small>GPU</small>"]
        qdrant["🗄️ Qdrant<br/><small>Docker</small>"]

        claude -->|embedding| ollama
        ollama -->|vectors| claude
        claude -->|storage| qdrant
    end
`}
</MermaidTeaRAGs>

**Best for:** Powerful local GPU (M3 Pro or better), offline work, minimal setup.

### ⭐ Remote GPU + Local Qdrant (Recommended)

Embedding on dedicated GPU server, Qdrant runs locally in Docker.

<MermaidTeaRAGs>
{`
flowchart LR
    subgraph dev["💻 Development Machine"]
        claude["🤖 Coding Agent"]
        qdrant["🗄️ Qdrant<br/><small>Docker</small>"]
    end

    subgraph gpu["🖥️ GPU Server<br/><small>LAN</small>"]
        ollama["✨ Ollama<br/><small>GPU</small>"]
    end

    claude -->|embedding| ollama
    ollama -.->|vectors| claude
    claude -->|storage| qdrant
`}
</MermaidTeaRAGs>

**Best for:** Most users — fast GPU embedding + fast local storage.
**Fastest overall:** ~7m 39s for VS Code (3.5M LoC).

### 🌐 Full Remote Setup

Both Qdrant and Ollama on dedicated server.

<MermaidTeaRAGs>
{`
flowchart LR
    claude["🤖 Coding Agent<br/><small>Your Machine</small>"]

    subgraph gpu["🖥️ GPU Server<br/><small>LAN</small>"]
        ollama["✨ Ollama<br/><small>GPU</small>"]
        qdrant["🗄️ Qdrant"]
    end

    claude -->|embedding| ollama
    ollama -.->|vectors| claude
    claude -->|storage| qdrant
`}
</MermaidTeaRAGs>

**Best for:** Cannot run Docker locally, indexing from multiple thin clients.
**Trade-off:** Network latency reduces storage rate (~4x slower than local).

## Performance Comparison

| Metric | 🏠 Fully Local | ⭐ Remote GPU + Local Qdrant | 🌐 Full Remote |
|--------|---------------|------------------------------|----------------|
| Optimal batch | 512 | 256 | 256 |
| Optimal concurrency | 1 | 6 | 4 |
| Embedding rate | 87 ch/s | **156 ch/s** | 154 ch/s |
| Storage rate | 6273 ch/s | **6966 ch/s** | 1810 ch/s |
| VS Code (3.5M LoC) | 13m 36s | **7m 39s** | 8m 13s |

:::tip Why Remote GPU + Local Qdrant is Fastest
Network latency crushes remote Qdrant storage: 6966 ch/s → 1810 ch/s (3.8x drop). Always run Qdrant locally if possible. Embedding benefits from dedicated GPU (1.8x faster than M3 Pro), and concurrency hides network latency.
:::

## Key Performance Insights

### Batch Size

**Rule of thumb:**
- **Local GPU**: Use large batches (512) + CONCURRENCY=1 to minimize per-batch overhead
- **Remote GPU**: Use smaller batches (256) + CONCURRENCY=4-6 to hide network latency

```bash
# Local GPU — GPU-bound, concurrency adds overhead
export EMBEDDING_BATCH_SIZE=512
export INGEST_PIPELINE_CONCURRENCY=1

# Remote GPU — network latency hidden by parallel requests
export EMBEDDING_BATCH_SIZE=256
export INGEST_PIPELINE_CONCURRENCY=4
```

### Concurrency

**Critical insight:** Concurrency is **only beneficial for remote GPU**. Local GPU sees no improvement — it adds overhead without benefit.

| Setup | Concurrency | Why |
|-------|-------------|-----|
| Local GPU | 1 | GPU-bound, parallel requests add overhead |
| Remote GPU | 4-6 | Hide network latency with overlapping I/O |

### Qdrant Ordering

| Mode | Use case | Performance |
|------|----------|-------------|
| `weak` | Local Qdrant, single indexer | Fastest |
| `medium` | Balanced | Default |
| `strong` | Remote Qdrant, multiple indexers | Safest, highest consistency |

```bash
# Local setup
export QDRANT_BATCH_ORDERING=weak

# Remote GPU + Local Qdrant
export QDRANT_BATCH_ORDERING=strong

# Full remote
export QDRANT_BATCH_ORDERING=weak
```

### Bottleneck Analysis

**Embedding is always the bottleneck:**
- Embedding: 87-156 ch/s
- Storage: 1810-6966 ch/s

Even at 156 ch/s (remote GPU), embedding is **40x slower** than storage. Invest in GPU, not Qdrant infrastructure.

## Tuning Guidelines

### For Large Codebases (500K+ LOC)

- ✅ Run `npm run tune` to find optimal batch sizes
- ✅ Increase `MAX_IO_CONCURRENCY=100` for SSD
- ✅ Increase Qdrant memory limits in docker-compose.yml
- ✅ Use `.contextignore` to exclude node_modules, build artifacts

### For Slow Search

- ✅ Use filters: `fileTypes`, `pathPattern` to narrow scope
- ✅ Limit results to needed count
- ✅ Enable hybrid search for technical queries
- ✅ Verify Qdrant has payload indexes

### For Memory Issues

- ⚠️ Reduce `CODE_CHUNK_SIZE` (default 2500)
- ⚠️ Reduce `QDRANT_UPSERT_BATCH_SIZE`
- ⚠️ Increase Qdrant memory in docker-compose.yml
- ⚠️ Index subdirectories separately

## Monitoring & Debug

Enable detailed timing logs:

```bash
export DEBUG=1
```

Logs are written to `~/.tea-rags-mcp/logs/`.

Check index status:

```bash
/mcp__qdrant__get_index_status /path/to/project
```

Returns: status, chunk count, last update time, collection statistics.

## Hardware Recommendations

### Minimum (Development)
- 4GB RAM, SSD, CPU embedding (slow but works)

### Recommended (Production)
- 8GB RAM, GPU with 8GB+ VRAM, SSD, Dedicated Qdrant

### Enterprise (Large Codebases)
- 16GB+ RAM, GPU with 12GB+ VRAM, NVMe SSD, Clustered Qdrant

---

<details>
<summary><strong>Pre-configured Settings by Setup</strong></summary>

### 🏠 Local Setup (MacBook M3 Pro)

```bash
EMBEDDING_BATCH_SIZE=512
INGEST_PIPELINE_CONCURRENCY=1
QDRANT_UPSERT_BATCH_SIZE=192
QDRANT_BATCH_ORDERING=weak
QDRANT_FLUSH_INTERVAL_MS=100
QDRANT_DELETE_BATCH_SIZE=1500
QDRANT_DELETE_CONCURRENCY=12
# Embedding: 87 ch/s, Storage: 6273 ch/s
```

**Why these values:**
- `BATCH_SIZE=512` + `CONCURRENCY=1`: GPU-bound workload, concurrency adds overhead
- `QDRANT_BATCH_ORDERING=weak`: Local Qdrant doesn't need strong ordering
- `FLUSH_INTERVAL_MS=100`: Fast flushes for local SSD

### ⭐ Remote GPU + Local Qdrant (AMD 7800M)

```bash
EMBEDDING_BATCH_SIZE=256
INGEST_PIPELINE_CONCURRENCY=6
QDRANT_UPSERT_BATCH_SIZE=512
QDRANT_BATCH_ORDERING=strong
QDRANT_FLUSH_INTERVAL_MS=250
QDRANT_DELETE_BATCH_SIZE=500
QDRANT_DELETE_CONCURRENCY=16
# Embedding: 156 ch/s, Storage: 6966 ch/s
```

**Why these values:**
- `BATCH_SIZE=256` + `CONCURRENCY=6`: Network latency hidden by concurrent requests
- `QDRANT_BATCH_ORDERING=strong`: Higher ordering ensures data consistency
- Higher storage rate (6966 ch/s) because Qdrant is local

### 🌐 Full Remote Setup

```bash
EMBEDDING_BATCH_SIZE=256
INGEST_PIPELINE_CONCURRENCY=4
QDRANT_UPSERT_BATCH_SIZE=256
QDRANT_BATCH_ORDERING=weak
QDRANT_FLUSH_INTERVAL_MS=500
QDRANT_DELETE_BATCH_SIZE=1000
QDRANT_DELETE_CONCURRENCY=12
# Embedding: 154 ch/s, Storage: 1810 ch/s
```

**Why these values:**
- `BATCH_SIZE=256` + `CONCURRENCY=4`: Balance between hiding latency and avoiding queue buildup
- `QDRANT_BATCH_ORDERING=weak`: Reduce round-trips over network
- `FLUSH_INTERVAL_MS=500`: Larger flush windows amortize network latency
- Storage bottlenecked by network (1810 ch/s vs 6966 for local)

</details>

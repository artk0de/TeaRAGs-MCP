---
title: "Performance Diagnostics"
sidebar_position: 2
---

# Performance Diagnostics

How to answer "is the index healthy, is search fast enough, where is time being spent". TeaRAGs exposes three diagnostic surfaces: **index status**, **index metrics**, and **debug logs**.

## Index Status

`get_index_status` reports the operational state of an indexed codebase in one call. Use it as the first diagnostic before anything else.

Returned fields (selected):

| Field | What it tells you |
|-------|-------------------|
| `indexed` | Whether the codebase has a collection at all |
| `collectionName` | Physical collection name (alias-resolved) |
| `chunkCount` / `fileCount` | Size of the index |
| `embeddingModel` | The model the collection was built with |
| `schemaVersion` | Qdrant payload schema version |
| `hybridEnabled` | Whether sparse vectors are present |
| `enrichment.progress` | `{ done, total, pending, failed }` per enrichment provider |
| `enrichment.lastEnrichedAt` | Freshness of `git.*` signals |
| `indexingInProgress` | `true` if another session is actively indexing |

Interpreting combinations:

- `indexed: false` → run `/tea-rags:index` or `index_codebase`
- `indexed: true`, `enrichment.progress.pending > 0` → enrichment still running; `git.*` signals incomplete. Wait or proceed with base-similarity search.
- `indexingInProgress: true` → parallel session running. **Never `clear_index` to "fix" this** — let the other session finish.
- `embeddingModel` doesn't match current config → collection was built with a different model. You'll need to reindex to switch models (different vector dimensions).

## Index Metrics

`get_index_metrics` is the deep diagnostic. It returns per-language, per-scope (`source`/`test`) percentile thresholds for every numeric signal. Source: `ExploreFacade#getIndexMetrics`.

```json
{
  "signals": {
    "typescript": {
      "git.file.commitCount": {
        "source": {
          "count": 4823,
          "p25": 1, "p50": 3, "p75": 8, "p95": 20,
          "labelMap": { "low": 1, "typical": 3, "high": 8, "extreme": 20 }
        },
        "test": {
          "count": 1104,
          "p50": 2, "p95": 6,
          "labelMap": { "low": 1, "typical": 2, "high": 4, "extreme": 6 }
        }
      }
    }
  }
}
```

### What to look at

| Question | Field to inspect |
|----------|------------------|
| How big is this codebase? | `count` per language — tells you chunk counts to budget search against |
| What "high churn" means here | `labelMap.high` for `git.file.commitCount` |
| Is the codebase polyglot? | Multiple languages each > 10% of total chunks |
| Are test files skewing things? | Compare `source` vs `test` scopes — very different thresholds confirm the split is meaningful |
| Health of the enrichment pipeline | `pendingEnrichment` / `stalePct` per provider |

### Polyglot detection rule

If two or more languages each have > 10% of total chunks, treat the codebase as **polyglot**. Search strategy changes: always filter by `language` to avoid the dominant language occupying every result slot. See the search cascade rules for the full procedure.

## DEBUG Mode

`DEBUG=1` (or `DEBUG=true`) enables full logging:

```bash
DEBUG=1 claude
# or inside MCP config:
# "env": { "DEBUG": "true" }
```

This turns on:

- **Full stack traces** in error responses (only the top line ships in production)
- **Per-stage timing** for indexing (chunking, embedding, upsert, enrichment)
- **Provider-level logs** (Ollama model-info probes, OpenAI retry counts, Qdrant batch sizes)
- **Enrichment coordinator** — which file failed, which commit was skipped

Logs land in `~/.tea-rags/logs/`. Rotate or clean periodically — debug mode is verbose.

## Where Time Goes

Rough breakdown for a first-time index of ~100k chunks (Apple M3 Pro, Ollama local):

| Stage | % of total | Dominant cost |
|-------|-----------|---------------|
| File scan | ~1% | IO on `.gitignore` tree walk |
| Chunking | ~10% | Tree-sitter AST parse + language hook dispatch |
| Embedding | ~70% | GPU inference (or CPU if WebGPU unavailable) |
| Upsert | ~10% | Qdrant HTTP + sparse vector build |
| Enrichment (background, not on critical path) | — | isomorphic-git log read + jsdiff |

**Optimization knobs** (see [Performance Tuning](/config/performance-tuning) for details):

- `EMBEDDING_TUNE_BATCH_SIZE` — the biggest lever. Larger batches = fewer GPU round-trips.
- `INGEST_TUNE_CHUNKER_POOL_SIZE` — parallelism for AST parsing; bump when chunking dominates (rare).
- `INGEST_TUNE_FILE_CONCURRENCY` — how many files in flight through the pipeline at once.
- `TRAJECTORY_GIT_CHUNK_CONCURRENCY` — parallel commits processed during chunk-churn overlay.

## Provider-Specific Indicators

**Ollama slow?**

- Check if the model fits in GPU VRAM. If it spills to CPU, throughput drops 10–50×.
- `ollama ps` shows active models and whether they're on GPU.
- Consider `jina-embeddings-v2-small-en` (smaller dimensions) or ONNX with WebGPU.

**OpenAI rate-limited?**

- `INFRA_EMBEDDING_OPENAI_RATE_LIMIT` retries are hidden — if latency is high but no errors surface, you're probably throttled.
- Tier 1 (500 RPM, 1M TPM) indexes ~800k LoC in 45 min; above that, upgrade tier or switch to local.

**Embedded Qdrant sluggish?**

- Check `~/.tea-rags/qdrant/daemon.port` and `daemon.pid` are current.
- `rm ~/.tea-rags/qdrant/daemon.*` forces fresh spawn if daemon is unresponsive.
- Storage over 50 GB on SSD is fine; on spinning disks, moving `QDRANT_EMBEDDED_STORAGE_PATH` to SSD helps.

## Health Checks for Agents

Before relying on trajectory signals, agents should run this check:

```text
get_index_status
  → enrichment.progress.pending == 0     (enrichment finished)
  → enrichment.lastEnrichedAt < 24h ago  (fresh)
```

If enrichment is lagging, fall back to similarity-only rerank (`relevance` preset) or wait.

## Related

- [Failure Model](/operations/failure-model) — what each error code means
- [Performance Tuning](/config/performance-tuning) — how to change the knobs
- [Environment Variables](/config/environment-variables) — full list of tuning variables

---
title: Data Model
sidebar_position: 3
---

# Data Model

TeaRAGs stores everything in a single Qdrant collection per indexed codebase. Every indexed point is a **chunk** — a function, class, markdown section, or block — with a dense vector (and optionally a sparse vector for hybrid search) plus a rich payload of structural and git-derived signals.

This page is the authoritative field catalog. Source of truth: `src/core/domains/trajectory/static/payload-signals.ts` (base), `src/core/domains/trajectory/git/payload-signals.ts` (git), and `StaticPayloadBuilder#buildPayload()`.

## Collection Structure

A Qdrant collection contains:

1. **Chunk points** — one per indexed chunk, carrying vector(s) + payload (all fields below).
2. **Schema metadata point** — a reserved point with `_type: "schema_metadata"` holding collection-level bookkeeping (see [Schema Versioning](#schema-versioning) below).

Collection naming is derived from the codebase absolute path hash — see `src/core/infra/collection-name.ts` (`resolveCollectionName`).

## Chunk Payload

Organized by namespace: base (structural), `git.file.*` (file-level git signals), `git.chunk.*` (chunk-level git signals).

### Base — Always Present

Written by `StaticPayloadBuilder` on every chunk:

| Field | Type | Description |
|-------|------|-------------|
| `content` | string | The actual code or documentation text |
| `contentSize` | number | Character count of `content` |
| `relativePath` | string | Path relative to the codebase root |
| `fileExtension` | string | Extension with dot (e.g. `".ts"`) |
| `language` | string | Programming language (e.g. `"typescript"`, `"ruby"`, `"markdown"`) |
| `codebasePath` | string | Absolute path of the codebase root (used for resolution) |
| `startLine` | number | First line of the chunk in its file |
| `endLine` | number | Last line of the chunk in its file |
| `chunkIndex` | number | Chunk position within the file (0-based) |

### Base — Conditional

Written only when relevant — absent for chunks where they don't apply:

| Field | Type | When written | Description |
|-------|------|--------------|-------------|
| `name` | string | Code chunks with an identifier | Class/function/symbol name |
| `chunkType` | string | Chunks emitted by AST chunker | `"function"`, `"class"`, `"interface"`, `"block"` |
| `symbolId` | string | Named code chunks | Unique ID: `Class#method` (instance), `Class.method` (static), `functionName` (top-level), `doc:<hash>` (docs) |
| `parentSymbolId` | string | Methods inside a class | Parent class/module name |
| `parentType` | string | Methods inside a class | Parent AST node type (`"class_declaration"`, etc.) |
| `isDocumentation` | boolean | Markdown / doc chunks | `true` for doc sections |
| `isTest` | boolean | Test files | `true` when file matches test naming for the language |
| `imports` | string[] | Code chunks with file-level imports | File-level imports inherited by every chunk of the file |
| `headingPath` | `{depth, text}[]` | Doc chunks | Heading hierarchy leading to this chunk (used by `documentationRelevance` preset) |
| `navigation` | `{prevSymbolId?, nextSymbolId?}` | Chunks with adjacent symbols | Enables chunk-to-chunk navigation without re-reading the file |
| `methodLines` | number | Function chunks | Original method line count before chunk splitting (used by `decomposition` preset) |
| `methodDensity` | number | Function chunks | Characters per line, dampened for small chunks — a code density heuristic |

### `git.file.*` — File-Level Git Signals

Written by the git enrichment pipeline (phase 1) on **every chunk of the file**. All chunks of the same file share identical `git.file.*` values. See [Git Enrichment Pipeline](/architecture/git-enrichment-pipeline) for computation details.

#### Primary signals (used by reranker)

| Field | Type | Label thresholds | Description |
|-------|------|------------------|-------------|
| `git.file.commitCount` | number | low / typical / high / extreme | Total commits modifying this file |
| `git.file.ageDays` | number | recent / typical / old / legacy | Days since last modification |
| `git.file.dominantAuthor` | string | — | Author with most commits |
| `git.file.authors` | string[] | — | All contributing authors |
| `git.file.dominantAuthorPct` | number | shared / mixed / concentrated / silo | % of commits by dominant author (0–100) |
| `git.file.fileChurnCount` | number | minimal / moderate / significant / massive | Total lines churned (added + deleted) |
| `git.file.relativeChurn` | number | normal / high | `(linesAdded + linesDeleted) / currentLines` |
| `git.file.recencyWeightedFreq` | number | normal / burst | Recency-weighted commit frequency |
| `git.file.changeDensity` | number | calm / active / intense | Commits per month |
| `git.file.churnVolatility` | number | stable / erratic | Standard deviation of commit-interval days |
| `git.file.bugFixRate` | number | healthy / concerning / critical | % of commits classified as bug fixes (0–100) |
| `git.file.contributorCount` | number | solo / team / crowd | Distinct contributors |
| `git.file.taskIds` | string[] | — | Task/ticket IDs extracted from commit messages (JIRA, GitHub, AzDO) |

#### Provenance fields (not used by rerank, kept for debugging)

| Field | Type | Description |
|-------|------|-------------|
| `git.file.dominantAuthorEmail` | string | Email of dominant author |
| `git.file.lastModifiedAt` | number | Unix timestamp of last commit |
| `git.file.firstCreatedAt` | number | Unix timestamp of first commit |
| `git.file.lastCommitHash` | string | SHA of the last commit touching the file |
| `git.file.linesAdded` | number | Cumulative lines added across all commits |
| `git.file.linesDeleted` | number | Cumulative lines deleted across all commits |
| `git.file.enrichedAt` | ISO string | When this payload was enriched |

### `git.chunk.*` — Chunk-Level Git Signals

Written by the git enrichment pipeline (phase 2) **only when chunk-level analysis applies** — files with more than one chunk, more than one commit, and within `TRAJECTORY_GIT_CHUNK_MAX_AGE_MONTHS`. Merged into the existing `git.*` payload via dot-notation to avoid clobbering file-level data.

| Field | Type | Label thresholds | Description |
|-------|------|------------------|-------------|
| `git.chunk.churnRatio` | number | normal / concentrated | Chunk's share of file churn (0–1) |
| `git.chunk.commitCount` | number | low / typical / high / extreme | Commits touching this specific chunk |
| `git.chunk.ageDays` | number | recent / typical / old / legacy | Days since last modification to the chunk |
| `git.chunk.contributorCount` | number | solo / crowd | Distinct contributors to the chunk |
| `git.chunk.bugFixRate` | number | healthy / concerning / critical | Chunk-level bug-fix rate (0–100) |
| `git.chunk.relativeChurn` | number | normal / high | Churn relative to chunk size |
| `git.chunk.recencyWeightedFreq` | number | normal / burst | Chunk-level recency-weighted frequency |
| `git.chunk.changeDensity` | number | active / intense | Chunk commits per month |
| `git.chunk.churnVolatility` | number | stable / erratic | Standard deviation of chunk commit intervals |
| `git.chunk.taskIds` | string[] | — | Task IDs from commits touching this chunk |
| `git.chunk.lastModifiedAt` | number | — | Unix timestamp of the last chunk-touching commit |
| `git.chunk.enrichedAt` | ISO string | — | When the chunk overlay was enriched |

:::note Chunk vs file alpha-blending
The reranker blends chunk and file signals via confidence-weighted alpha — see [`ChunkChurnSignal`](/architecture/overview) and related derived signals. When chunk data is missing (single-chunk file, short history, old commit), file-level signals carry 100% of the weight automatically.
:::

## Vectors

Each chunk point stores:

- **Dense vector** — embedding of `content`, dimension depends on provider (ONNX default 768, OpenAI `text-embedding-3-small` 1536, etc.). Used for semantic similarity.
- **Sparse vector** (optional) — BM25-style term frequencies. Enabled when `enableHybrid=true` (default). Powers `hybrid_search`.

Collections created before hybrid became the default still work dense-only — use `reindex_changes` to migrate (it auto-enables hybrid).

## Labels and Percentile Stats

Numeric signals declare `stats.labels` mapping percentiles to human-readable names (e.g. `p75 → "high"`). The indexer computes per-codebase percentile thresholds and stores them in the [`StatsCache`](/architecture/overview), scoped by `(language, signal, source|test)`.

The reranker uses these thresholds to attach labels to ranking overlays:

```json
{
  "commitCount": { "value": 12, "label": "high" }
}
```

Thresholds differ per codebase — a TypeScript file with 8 commits is "high" in one project and "typical" in another. Retrieve the full threshold table via `get_index_metrics` or the `tea-rags://schema/signal-labels` resource.

## Schema Versioning

Every collection contains one reserved point (ID `SCHEMA_METADATA_ID`) with payload:

```json
{
  "_type": "schema_metadata",
  "schemaVersion": 4,
  "sparseVersion": 1,
  "migratedAt": "2026-04-20T14:58:39.612Z",
  "indexes": ["language", "relativePath", "git.file.commitCount", "..."]
}
```

The server bumps `schemaVersion` when the Qdrant payload **indexes** change (adding a new indexed field). On startup, [`SchemaManager`](/architecture/overview) reads the stored version and reconciles indexes.

**New payload fields** (without new indexes) are handled by the separate [`SchemaDriftMonitor`](/architecture/overview): it detects that code defines a field the stored points lack, warns the agent that a full reindex will populate them, and lets the user pick when to reindex. See [Schema Drift vs Migrations](/architecture/overview) for the philosophy.

## Where Code Lives

| Concern | Source |
|---------|--------|
| Base payload builder | `src/core/domains/trajectory/static/provider.ts` (`StaticPayloadBuilder`) |
| Base signal catalog | `src/core/domains/trajectory/static/payload-signals.ts` (`BASE_PAYLOAD_SIGNALS`) |
| Git signal catalog | `src/core/domains/trajectory/git/payload-signals.ts` (`gitPayloadSignalDescriptors`) |
| Git enrichment pipeline | `src/core/domains/trajectory/git/` + `src/core/domains/ingest/pipeline/enrichment/` |
| Schema versioning | `src/core/adapters/qdrant/schema-manager.ts` (`SchemaManager`) |
| Percentile thresholds | `src/core/infra/stats-cache.ts` (`StatsCache`) |

## Related

- [Git Enrichment Pipeline](/architecture/git-enrichment-pipeline) — how `git.*` signals are computed
- [Overview](/architecture/overview) — component map and data flow
- [Reranking](/introduction/core-concepts/reranking) — how payload fields become scoring inputs
- [Filters (advanced)](/usage/advanced/filters) — how to query these fields in search

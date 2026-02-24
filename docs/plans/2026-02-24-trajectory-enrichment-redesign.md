# Trajectory Enrichment Redesign

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Decompose god objects (git-log-reader 1122 lines, git-metadata-service 776 lines, enrichment-module 304 lines) into a clean enrichment framework with `EnrichmentProvider` interface, generic coordinator, and git as the first concrete implementation.

**Architecture:** Three-layer separation — `adapters/git/` (basic git operations), `trajectory/enrichment/` (generic framework + interface), `trajectory/enrichment/git/` (git enrichment implementation). Payload structure uses `{provider.key}.{file|chunk}.{metric}` nesting for level-based filtering.

---

## EnrichmentProvider Interface

```typescript
// ingest/trajectory/enrichment/types.ts

interface EnrichmentProvider {
  /** Namespace key for Qdrant payload: { [key].file: ..., [key].chunk: ... } */
  readonly key: string;  // "git", "codegraph", "complexity"

  /** File-level enrichment (prefetch at T=0, or backfill for specific paths) */
  buildFileMetadata(
    root: string,
    options?: { paths?: string[] },
  ): Promise<Map<string, Record<string, unknown>>>

  /** Chunk-level enrichment (post-flush) */
  buildChunkMetadata(
    root: string,
    chunkMap: Map<string, ChunkLookupEntry[]>,
  ): Promise<Map<string, Map<string, Record<string, unknown>>>>
}
```

## Qdrant Payload Structure

```json
{
  "git": {
    "file": { "dominantAuthor": "Alice", "commitCount": 5, "ageDays": 10 },
    "chunk": { "commitCount": 3, "churnRatio": 0.6, "contributorCount": 2 }
  }
}
```

Coordinator writes: `{ [provider.key]: { file: fileData } }` and `{ [provider.key]: { chunk: chunkData } }`.

Qdrant filters work as `git.file.commitCount`, `git.chunk.churnRatio`.

## Target Directory Structure

```
src/core/adapters/git/                         <- basic git operations layer
  client.ts       — execFileAsync, isomorphic-git wrappers, getHead, resolveRepoRoot
  parsers.ts      — parseNumstatOutput, parsePathspecOutput (pure)
  types.ts        — CommitInfo, RawNumstatEntry

src/core/ingest/trajectory/enrichment/         <- generic enrichment framework
  types.ts        — EnrichmentProvider interface
  coordinator.ts  — timing orchestrator (queuing, Qdrant writes under {key}.{level})
  applier.ts      — generic batch payload writer (provider-agnostic)
  utils.ts        — extractTaskIds (generic text parsing, not git-specific)
  git/                                         <- git enrichment implementation
    provider.ts     — GitEnrichmentProvider implements EnrichmentProvider
    file-reader.ts  — buildFileMetadataMap (CLI -> iso-git fallback + caching)
    chunk-reader.ts — buildChunkChurnMap (decomposed from 267-line god method)
    metrics.ts      — computeFileMetadata, isBugFixCommit, overlaps (pure)
    cache.ts        — HEAD-based memoization (file + chunk caches)
    types.ts        — FileChurnData, ChunkChurnOverlay, GitFileMetadata
```

## Deletions

- `trajectory/git/git-metadata-service.ts` (776 lines) — deprecated blame-per-file algorithm
- `tests/code/git/git-metadata-service.test.ts` — tests for deprecated service
- Deprecated types from `types.ts`: GitChunkMetadata, BlameCache, BlameLineData, BlameCacheFile, GitMetadataOptions
- `trajectory/git/git-log-reader.ts` (1122 lines) — decomposed into adapters/git/ + enrichment/git/
- `trajectory/enrichment-module.ts` (304 lines) — replaced by coordinator.ts
- `trajectory/enrichment/chunk-churn.ts` — dissolved into coordinator + git/chunk-reader
- `trajectory/enrichment/metadata-applier.ts` — replaced by generic applier.ts
- `trajectory/git/index.ts` — barrel re-exports, replaced by new structure

## Decomposition Map

### git-log-reader.ts (1122 lines) splits into:

| Responsibility | Lines | Destination |
|---|---|---|
| `execFileAsync` usage, CLI arg building | ~50 | `adapters/git/client.ts` |
| isomorphic-git wrappers (buildViaIsomorphicGit, listAllFiles, diffTrees, readBlobAsString) | ~120 | `adapters/git/client.ts` |
| parseNumstatOutput, parsePathspecOutput | ~130 | `adapters/git/parsers.ts` |
| CommitInfo type | ~10 | `adapters/git/types.ts` |
| getHead, resolveRepoRoot | ~30 | `adapters/git/client.ts` |
| buildFileMetadataMap (orchestration + CLI/iso-git dispatch) | ~100 | `enrichment/git/file-reader.ts` |
| buildFileMetadataForPaths | ~40 | `enrichment/git/file-reader.ts` |
| buildChunkChurnMap + _buildChunkChurnMapUncached (267-line god method) | ~300 | `enrichment/git/chunk-reader.ts` |
| _getCommitsViaIsomorphicGit | ~50 | `enrichment/git/chunk-reader.ts` |
| getCommitsByPathspec, getCommitsByPathspecSingle, getCommitsByPathspecBatched | ~100 | `enrichment/git/chunk-reader.ts` (uses adapters/git/client) |
| fileMetadataCache, chunkChurnCache, withTimeout | ~40 | `enrichment/git/cache.ts` |
| computeFileMetadata, isBugFixCommit, overlaps, extractTaskIds | ~170 | `enrichment/git/metrics.ts` (except extractTaskIds -> enrichment/utils.ts) |
| FileChurnData, ChunkChurnOverlay, GitFileMetadata | ~80 | `enrichment/git/types.ts` |

### enrichment-module.ts (304 lines) becomes coordinator.ts:

| What | Stays/Moves |
|---|---|
| prefetchGitLog timing logic | -> coordinator.prefetch() — calls provider.buildFileMetadata() |
| onChunksStored pending queue | -> coordinator.onChunksStored() — calls applier |
| startChunkChurn | -> coordinator.startChunkEnrichment() — calls provider.buildChunkMetadata() |
| awaitCompletion + metrics | -> coordinator.awaitCompletion() |
| updateEnrichmentMarker | -> coordinator (Qdrant marker writes) |
| resolveGitRepoRoot | -> adapters/git/client.ts |
| Git-specific wiring (new GitLogReader, etc.) | -> enrichment/git/provider.ts |

### chunk-churn.ts (156 lines) dissolves:

| What | Destination |
|---|---|
| ignoreFilter logic | coordinator.ts |
| buildChunkChurnMap call | provider.buildChunkMetadata() |
| Qdrant batch writes | coordinator.ts / applier.ts |
| chunkEnrichment marker | coordinator.ts |

### metadata-applier.ts (178 lines) becomes generic applier.ts:

| What | Change |
|---|---|
| Group items by filePath | stays (generic) |
| computeFileMetadata call | replaced by provider-returned ready payloads |
| { git: metadata } payload key | replaced by { [provider.key]: { file: data } } |
| batchSetPayload | stays (generic) |
| backfillMissedFiles | coordinator calls provider.buildFileMetadata({ paths }) |
| Path match diagnostics | stays in applier |

## Data Flow

```
T=0: coordinator.prefetch(root)
       -> provider.buildFileMetadata(root) [async, fire-and-forget]

Per-batch: coordinator.onChunksStored(collection, root, items)
       -> applier.apply(collection, fileMetadataMap, items, provider.key)
           -> qdrant.batchSetPayload({ [key]: { file: data } })

Post-flush: coordinator.startChunkEnrichment(collection, root, chunkMap)
       -> provider.buildChunkMetadata(root, chunkMap)
       -> qdrant.batchSetPayload({ [key]: { chunk: data } })

Completion: coordinator.awaitCompletion(collection)
       -> provider.buildFileMetadata(root, { paths: missedPaths })  [backfill]
       -> timing metrics + enrichment marker
```

## Related Tasks

- `tea-rags-mcp-i6a`: Add `metaLevel: file/chunk/full` filter to semantic_search endpoint (blocked by this redesign)
- Payload structure change is **breaking** for existing indexed data — requires reindex after deployment

## Migration Notes

- Existing Qdrant payload `{ git: { dominantAuthor, ... } }` changes to `{ git: { file: { dominantAuthor, ... } } }`
- All Qdrant filter references in search tools need updating: `git.commitCount` -> `git.file.commitCount`
- tea-rags MCP search_code rerank presets that reference git metadata fields need updating

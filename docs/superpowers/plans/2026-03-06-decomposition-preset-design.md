# Decomposition Preset Design

## Goal

Rerank preset for finding decomposition candidates — large and/or dense
methods/blocks that should be split into smaller units.

## New Components

### 1. `contentSize` in Qdrant payload (indexing)

- Field: `contentSize: number` — `content.length` in characters
- Written when creating Qdrant points
- Requires reindexing

### 2. `ChunkDensitySignal` (structural derived signal)

- Formula: `contentSize / (endLine - startLine)`
- `defaultBound = 0` — purely adaptive p95, no floor
- If spread (p95 - p5) < epsilon — signal zeroes out
- Location: `src/core/search/rerank/derived-signals/chunk-density.ts`

### 3. `DecompositionPreset` (generic preset, not trajectory)

- Tools: `["semantic_search", "search_code"]`
- Weights: `{ similarity: 0.3, chunkSize: 0.35, chunkDensity: 0.35 }`
- Overlay mask: `{ derived: ["chunkSize", "chunkDensity"] }`
- Location: `src/core/search/rerank/presets/decomposition.ts`

## Architecture Decisions

- Preset is **generic** (not trajectory) — depends only on structural signals,
  not git
- `chunkDensity` is a structural signal (next to `chunk-size.ts`,
  `similarity.ts`)
- No `blockPenalty` — block chunks are valid decomposition candidates
- No static floor — p95 adapts to codebase language automatically
- If spread (p95 - p5) < epsilon, signal does not discriminate → weight zeroed

## Weight Rationale

- **similarity 0.3** — search stays semantic but does not dominate
- **chunkSize 0.35** — line count, primary "method too long" indicator
- **chunkDensity 0.35** — chars/line, equal weight with chunkSize
- 200 lines × average density ≈ 50 lines × high density in final score

## Affected Files

- `src/core/ingest/pipeline/chunk-pipeline.ts` — add `contentSize` to payload
- `src/core/search/rerank/derived-signals/chunk-density.ts` — new file
- `src/core/search/rerank/derived-signals/index.ts` — register signal
- `src/core/search/rerank/presets/decomposition.ts` — new file
- `src/core/search/rerank/presets/index.ts` — register preset

## Future Extensions (not in this PR)

- `siblingCount` in payload — method count per class
- `ClassComplexityPreset` — class decomposition with aggregation by `parentName`

# methodLines payload field + decomposition signal normalization

**Date:** 2026-03-07 **Branch:** feat/onnx-embedding-provider **Status:**
Approved

## Problems

1. `ChunkDensitySignal` returns raw chars/line (50-120+) instead of normalized
   0-1 — `sources: []` and `defaultBound = 0` bypass normalization
2. When a method is split into sub-chunks, original method size is lost —
   `ChunkSizeSignal` sees sub-chunk line count, not method line count
3. `splitOversizedChunk` in class-body-chunker gives all sub-chunks identical
   `startLine`/`endLine` from parent chunk

## Solution

New `methodLines` field in `CodeChunk.metadata` — line count of the original
method/block before splitting. Stored in Qdrant payload. `ChunkSizeSignal` and
`ChunkDensitySignal` read from payload instead of computing from
`startLine`/`endLine`.

## Components

### 1. CodeChunk.metadata.methodLines (core/types.ts)

New optional field `methodLines?: number`.

### 2. Tree-sitter chunker (pipeline/chunker/tree-sitter.ts)

- Regular chunks: `methodLines = endLine - startLine`
- Child node fallback (lines 196-215): `methodLines = childNode span`
- Top-level fallback (lines 297-315): `methodLines = node span`

### 3. Character chunker (pipeline/chunker/character.ts)

Does not set `methodLines` (no AST context).

### 4. splitOversizedChunk fix (hooks/typescript/class-body-chunker.ts:252-294)

Fix: each sub-chunk gets correct `startLine`/`endLine` based on actual content
lines. `methodLines` not set (body chunks, not methods).

### 5. Chunk pipeline payload (chunk-pipeline.ts)

Add `methodLines` to Qdrant payload from `chunk.metadata.methodLines`.

### 6. ChunkSizeSignal (search/rerank/derived-signals/chunk-size.ts)

- `sources: ["methodLines"]` (enables adaptive bounds)
- `defaultBound = 500` (fallback floor)
- `extract`: reads `rawSignals.methodLines`, normalizes by adaptive bound

### 7. ChunkDensitySignal (search/rerank/derived-signals/chunk-density.ts)

- `sources: []` (density is a computed ratio, not a raw source)
- `defaultBound = 120` (static bound, chars per line)
- `extract`: `contentSize / methodLines`, normalizes by `defaultBound`

## Data flow

```
AST node (100 lines) -> tree-sitter splits -> sub-chunk A (40 lines), sub-chunk B (60 lines)
                                               methodLines = 100    methodLines = 100

Payload: { startLine: 10, endLine: 49, methodLines: 100, contentSize: 3200 }

ChunkSizeSignal:    normalize(100, adaptiveBound)  -> 0.0-1.0
ChunkDensitySignal: normalize(3200/100, 120)       -> 0.0-1.0
```

## Unchanged

- Decomposition preset weights (similarity: 0.3, chunkSize: 0.35, chunkDensity:
  0.35)
- Reranker scoring logic
- Other derived signals

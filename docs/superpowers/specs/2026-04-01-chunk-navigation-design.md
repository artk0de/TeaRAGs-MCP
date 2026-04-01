# Chunk Navigation Design

## Problem

After semantic search finds a chunk, the agent has no way to read surrounding
context without falling back to `Read` tool on raw files. For documentation
chunks this is especially painful — they have no `symbolId` usable in
`find_symbol`, and reading raw markdown loses all chunk boundaries and metadata.

## Solution

Add `navigation` field to every chunk payload in Qdrant with `prevSymbolId` /
`nextSymbolId` links. Agent navigates via `find_symbol` calls, moving in either
direction from any found chunk.

For documentation chunks, generate deterministic hash-based `symbolId` to make
them addressable by `find_symbol`.

## symbolId Changes

### Code chunks (no change)

Format: `"Class.method"`, `"functionName"` — readable, AST-derived, unique
enough within a file. Cross-file disambiguation handled by `pathPattern`.

### Documentation chunks (new)

Format: `"doc:" + sha256(input).slice(0, 12)` (12 hex = 6 bytes).

Input construction:

| Chunk type            | Hash input                                     | Example            |
| --------------------- | ---------------------------------------------- | ------------------ |
| Section with headings | `relativePath + "#" + headingPath.join(" > ")` | `doc:a3f8b2c1e4d7` |
| Preamble              | `relativePath + "#preamble"`                   | `doc:2b5d9c4e7f1a` |
| No headingPath        | `relativePath + "#" + chunkIndex`              | `doc:9e3b7c2f4a1d` |

12 hex chosen for collision resistance: ~281 trillion values, safe up to 1M+
chunks.

### Why hash for docs, readable for code

- Code symbolId is valuable for direct search: `find_symbol("Reranker")` finds
  the class and all methods. Hashing would break this.
- Doc symbolId serves only navigation — agent gets it from search results or
  `navigation` links, never types it manually.
- Hash solves: non-English headings, special characters, long strings, duplicate
  headings across files (relativePath in hash input guarantees uniqueness).

## navigation Field

Added to **all** chunk payloads (code and documentation):

```json
{
  "symbolId": "doc:a3f8b2c1e4d7",
  "navigation": {
    "prevSymbolId": "doc:7e2f1a09b3c2",
    "nextSymbolId": "Reranker.rerank"
  }
}
```

Rules:

- First chunk of file: `prevSymbolId` absent
- Last chunk of file: `nextSymbolId` absent
- Links use the neighbor's actual `symbolId` (hash for doc, readable for code)
- NOT stripped by `stripInternalFields` — always visible to agent

## Pipeline Changes

### MarkdownChunker (`chunker/hooks/markdown/chunker.ts`)

Replace current readable symbolId generation with hash-based:

- Section chunks:
  `symbolId = "doc:" + sha256(relativePath + "#" + headingPath.join(" > ")).slice(0, 12)`
- Preamble:
  `symbolId = "doc:" + sha256(relativePath + "#preamble").slice(0, 12)`
- Code blocks / no heading:
  `symbolId = "doc:" + sha256(relativePath + "#" + chunkIndex).slice(0, 12)`

Requires `relativePath` to be available in MarkdownChunker context.

### file-processor.ts

After `chunkerPool.processFile()` returns all chunks for a file:

1. Iterate chunks sorted by `chunkIndex`
2. For each chunk, set `metadata.navigation = { prevSymbolId, nextSymbolId }`
   based on neighbors' `symbolId`
3. Pass `headingPath` through to payload (currently dropped — bug fix)

This is the correct location because all chunks of a file are available at once.

### StaticPayloadBuilder (`trajectory/static/provider.ts`)

Write two new fields to Qdrant payload:

- `navigation: { prevSymbolId?: string, nextSymbolId?: string }`
- `headingPath: { depth: number, text: string }[]` (currently missing — bug fix)

### stripInternalFields (`dto/sanitize.ts`)

No change needed. `navigation` is NOT in `INTERNAL_PAYLOAD_FIELDS` — it passes
through automatically. `headingPath` remains internal (already stripped).

## No Migration Required

`schemaDrift` will detect missing `navigation` field in existing indexes and
prompt for reindexation. Users reindex when convenient. Must be covered by
integration test.

## search-cascade Rule

Add navigation guidance to search-cascade:

```
Found a chunk and need surrounding context?
├─ Check navigation.prevSymbolId / navigation.nextSymbolId
├─ Call find_symbol with the symbolId to get adjacent chunk
├─ Found middle of file? Navigate both directions as needed
├─ Don't read entire file — take only what you need
└─ No navigation field? Index predates this feature — use Read as fallback
```

## Testing

- Unit: MarkdownChunker generates `doc:` hash symbolId
- Unit: file-processor sets correct navigation links
- Unit: StaticPayloadBuilder writes navigation and headingPath
- Unit: stripInternalFields does NOT strip navigation
- Integration: schemaDrift detects missing navigation in old index
- Integration: find_symbol resolves doc hash symbolId
- Integration: navigation chain traversal (prev/next)

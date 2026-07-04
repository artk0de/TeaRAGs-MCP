# Chunk Quality Improvements: TS Class Splitting, 0-Line Fix, Small Chunk Merging

**Date:** 2026-03-04 **Status:** Approved

## Problem

Chunk quality analysis revealed 4 issues:

1. **0-line chunks** (10 chunks): single-line `type X = ...` produce
   `startLine == endLine` (0 lines). Root cause: tree-sitter
   `endPosition.row == startPosition.row` for single-line nodes, code does
   `row + 1` for both.
2. **TypeScript classes not split**: no `childChunkTypes` or
   `alwaysExtractChildren` in TS config. Classes up to 715 lines indexed as 1
   chunk — methods not searchable.
3. **Fragmented small declarations**: type aliases and small interfaces (3-4
   lines) produce individual chunks. 15 tiny chunks per file = search noise.
4. **isDocumentation**: needs verification (likely not a bug — .md files weren't
   in semantic search sample).

## Architecture

```
src/core/ingest/pipeline/chunker/
  config.ts                           ← Add childChunkTypes + hooks for TS
  tree-sitter.ts                      ← 0-line fix + top-level merging
  hooks/
    typescript/                       ← NEW directory (mirrors ruby/)
      index.ts                        ← typescriptHooks: ChunkingHook[]
      comment-capture.ts              ← AST-based JSDoc/comment capture
      class-body-chunker.ts           ← AST-based body grouping by modifier
```

Hook infrastructure (`HookContext`, `ChunkingHook`, `BodyChunkResult`) reused
without changes.

## Design

### 1. 0-Line Chunk Fix

Helper method in `TreeSitterChunker`:

```typescript
private computeEndLine(node: Parser.SyntaxNode): number {
  // tree-sitter endPosition.row is inclusive, ensure at least 1 line span
  return Math.max(node.startPosition.row + 2, node.endPosition.row + 1);
}
```

Applied at all 5 chunk creation points in `tree-sitter.ts`.

### 2. TypeScript Config

```typescript
typescript: {
  // ... existing loadModule, extractLanguage, chunkableTypes ...
  childChunkTypes: ["method_definition"],
  alwaysExtractChildren: true,
  hooks: typescriptHooks,
},
```

### 3. TypeScript Comment Capture Hook

AST-based (unlike Ruby's text-based approach). Uses `previousNamedSibling` on
class_body children:

- Iterate validChildren (method_definitions)
- Walk `previousNamedSibling` while type === "comment"
- Collect all comment rows → `excludedRows`
- Build `methodPrefixes[i]` = concatenated comment text
- Set `methodStartLines[i]` = first comment line

Handles `//`, `/** ... */`, `/* ... */` — all are `comment` AST nodes in
tree-sitter TS.

### 4. TypeScript Class Body Chunker Hook

AST-based classification using `class_body` named children (not text keywords):

| AST node type               | Modifiers         | Group               |
| --------------------------- | ----------------- | ------------------- |
| `public_field_definition`   | none              | `properties`        |
| `public_field_definition`   | `static`          | `static_members`    |
| `public_field_definition`   | `abstract`        | `abstract_members`  |
| `public_field_definition`   | `decorator` child | `decorated_members` |
| `class_static_block`        | —                 | `static_members`    |
| `abstract_method_signature` | —                 | `abstract_members`  |
| everything else             | —                 | `other`             |

Algorithm:

1. Find `class_body` in containerNode
2. Iterate namedChildren, skip method_definition + comment (already handled)
3. Classify remaining nodes by type + modifiers
4. Group adjacent same-type nodes
5. Each group → BodyChunkResult with prepended class header
6. Split oversized groups at line boundaries

### 5. Top-Level Small Chunk Merging

Language-agnostic post-processing in `TreeSitterChunker.chunk()`:

- After main loop, scan chunks sequentially
- Candidates: chunks with `lines <= 5`, no `parentName`, type in
  `[type_alias_declaration, interface_declaration, enum_declaration]` (mapped to
  block/interface chunkTypes)
- Merge adjacent candidates (gap <= 2 blank lines)
- Merged chunk: `chunkType = "block"`, `name = "FirstName..."`, combined content
- Respects `maxChunkSize` limit
- Private method `mergeSmallChunks(chunks): CodeChunk[]`

### 6. isDocumentation Verification

Post-implementation verification query. Not a code change.

## Impact

- Monster chunks (8 classes > 300 lines) → split into method-level chunks
- Tiny chunks (41 chunks <= 3 lines) → merged into meaningful blocks
- 0-line chunks (10) → fixed to minimum 1 line
- `ChunkSizeSignal` now produces correct values for single-line nodes

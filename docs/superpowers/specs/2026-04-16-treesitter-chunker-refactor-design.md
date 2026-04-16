# Refactor: TreeSitterChunker#chunk — Branch Extraction

## Problem

`TreeSitterChunker#chunk()` in
`src/core/domains/ingest/pipeline/chunker/tree-sitter.ts:147-336` is 189 lines —
the largest method in core. Three distinct branches (child extraction, oversized
fallback, single node) are inlined in a for-loop, making the flow hard to
follow.

## Solution

Extract three private methods for each branch. The main `chunk()` method becomes
a router: parse → find nodes → for each node, pick strategy.

### Extracted methods

```typescript
// Handle nodes where children should be extracted (shouldExtractChildren=true).
// Covers: hook chain execution, child processing, body chunk extraction,
// and fallback to character chunking when no valid children found.
// Currently: if (shouldExtractChildren) block at ~line 190-300.
private async chunkWithChildExtraction(
  node: SyntaxNode,
  langConfig: LanguageConfig,
  code: string,
  filePath: string,
  language: string,
  chunks: CodeChunk[],
): Promise<void>

// Handle oversized nodes without valid children — character-based fallback.
// Currently: if (isTooLarge) block inside shouldExtractChildren, ~line 275-295.
// Note: this is called FROM chunkWithChildExtraction when validChildren is empty
// but node is too large. Not a top-level branch in chunk().
private async chunkOversizedNode(
  node: SyntaxNode,
  parentName: string,
  code: string,
  filePath: string,
  language: string,
  chunks: CodeChunk[],
): Promise<void>

// Handle regular single-node chunking (no child extraction needed).
// Currently: final else after shouldExtractChildren, ~line 310-330.
private chunkSingleNode(
  node: SyntaxNode,
  index: number,
  code: string,
  filePath: string,
  language: string,
  chunks: CodeChunk[],
): void
```

### Resulting chunk() method

```typescript
async chunk(code: string, filePath: string, language: string): Promise<CodeChunk[]> {
  const definition = LANGUAGE_DEFINITIONS[language];
  if (definition?.skipTreeSitter && definition.isDocumentation) {
    return this.markdownChunker.chunk(code, filePath, language);
  }

  const langConfig = await this.getLanguageConfig(language);
  if (!langConfig) {
    return this.fallbackChunker.chunk(code, filePath, language);
  }

  try {
    const tree = langConfig.parser.parse(code);
    const chunks: CodeChunk[] = [];
    const nodes = this.findChunkableNodes(tree.rootNode, langConfig.chunkableTypes, langConfig.hooks, code, filePath);

    for (const [index, node] of nodes.entries()) {
      const content = code.substring(node.startIndex, node.endIndex);
      if (content.length < 50) continue;

      const hasChildTypes = langConfig.childChunkTypes && langConfig.childChunkTypes.length > 0;
      const isTooLarge = content.length > this.config.maxChunkSize * 2;
      const shouldExtractChildren = hasChildTypes && (isTooLarge || langConfig.alwaysExtractChildren);

      if (shouldExtractChildren) {
        await this.chunkWithChildExtraction(node, langConfig, code, filePath, language, chunks);
      } else {
        this.chunkSingleNode(node, index, code, filePath, language, chunks);
      }
    }

    if (chunks.length === 0 && code.length > 100) {
      return this.fallbackChunker.chunk(code, filePath, language);
    }
    return this.mergeSmallChunks(chunks);
  } catch (error) {
    console.error(`Tree-sitter parsing failed for ${filePath}:`, error);
    return this.fallbackChunker.chunk(code, filePath, language);
  }
}
```

## Scope

- Files modified: `src/core/domains/ingest/pipeline/chunker/tree-sitter.ts`
- No new files
- No behavior change — pure extract-method
- All existing tests must pass without modification

## Risks

- `chunkWithChildExtraction` calls `chunkOversizedNode` internally (nested
  branch). This is intentional — oversized is a sub-case of child extraction,
  not a top-level routing decision.
- `chunks` array mutation pattern is consistent with existing `processChildren`.
- `v8 ignore` comment for defensive code path must be preserved in the extracted
  method.

## Success Criteria

- `chunk()` body is <= 30 lines (currently 189)
- `chunkWithChildExtraction` <= 80 lines
- `chunkOversizedNode` <= 20 lines
- `chunkSingleNode` <= 15 lines
- All existing TreeSitterChunker tests pass

# TreeSitterChunker#chunk Refactor Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use
> superpowers:subagent-driven-development (recommended) or
> superpowers:executing-plans to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extract branch logic from `TreeSitterChunker#chunk()` into private
methods, reducing it from 189 lines to ~30 lines.

**Architecture:** Three extract-method refactorings within the same class.
`chunkOversizedNode` is called from within `chunkWithChildExtraction`, not from
the main router.

**Tech Stack:** TypeScript, Vitest

**Spec:**
`docs/superpowers/specs/2026-04-16-treesitter-chunker-refactor-design.md`

---

### Task 1: Extract chunkWithChildExtraction

**Files:**

- Modify: `src/core/domains/ingest/pipeline/chunker/tree-sitter.ts:147-336`
- Test: `tests/core/domains/ingest/pipeline/chunker/tree-sitter-chunker.test.ts`
  (existing)

- [ ] **Step 1: Extract chunkOversizedNode (lines 283-304)**

Add as private method:

```typescript
/**
 * Fallback for oversized nodes without valid children — character-based chunking.
 */
private async chunkOversizedNode(
  node: Parser.SyntaxNode,
  parentName: string | undefined,
  parentType: string,
  code: string,
  filePath: string,
  language: string,
  chunks: CodeChunk[],
): Promise<void> {
  const content = code.substring(node.startIndex, node.endIndex);
  const nodeMethodLines = node.endPosition.row - node.startPosition.row + 1;
  const subChunks = await this.fallbackChunker.chunk(content, filePath, language);
  for (const subChunk of subChunks) {
    chunks.push({
      ...subChunk,
      startLine: node.startPosition.row + 1 + subChunk.startLine - 1,
      endLine: node.startPosition.row + 1 + subChunk.endLine - 1,
      metadata: {
        ...subChunk.metadata,
        chunkIndex: chunks.length,
        parentSymbolId: parentName,
        parentType,
        methodLines: nodeMethodLines,
      },
    });
  }
}
```

- [ ] **Step 2: Extract chunkWithChildExtraction (lines 188-306)**

Add as private method. This encompasses the entire `if (shouldExtractChildren)`
block:

```typescript
/**
 * Handle nodes where children should be extracted (classes, modules, large containers).
 * Returns true if the node was handled, false if it should fall through to single-node chunking.
 */
private async chunkWithChildExtraction(
  node: Parser.SyntaxNode,
  langConfig: LanguageConfig,
  code: string,
  filePath: string,
  language: string,
  chunks: CodeChunk[],
): Promise<boolean> {
  const parentName = this.extractName(node, code, langConfig.nameExtractor);
  const parentType = node.type;

  const childNodes = this.findChildChunkableNodes(
    node,
    langConfig.childChunkTypes ?? [],
    langConfig.hooks,
    code,
    filePath,
  );

  const validChildren = childNodes.filter((c) => code.substring(c.startIndex, c.endIndex).length >= 50);

  if (validChildren.length > 0) {
    const ctx = createHookContext(
      node,
      validChildren,
      code,
      { maxChunkSize: this.config.maxChunkSize },
      filePath,
    );
    for (const hook of langConfig.hooks ?? []) {
      hook.process(ctx);
    }

    const containerHeader = this.extractContainerHeader(node, code);
    await this.processChildren(
      validChildren,
      ctx,
      langConfig,
      code,
      filePath,
      language,
      parentName,
      parentType,
      chunks,
      [containerHeader],
    );

    if (langConfig.alwaysExtractChildren) {
      const hasHookChain = langConfig.hooks && langConfig.hooks.length > 0;
      if (hasHookChain) {
        for (const result of ctx.bodyChunks) {
          const bodyContent = `${containerHeader}\n${result.content}`;
          chunks.push({
            content: bodyContent,
            startLine: result.startLine,
            endLine: result.endLine,
            metadata: {
              filePath,
              language,
              chunkIndex: chunks.length,
              chunkType: (result.chunkType as CodeChunk["metadata"]["chunkType"]) ?? "block",
              name: result.name ?? parentName,
              parentSymbolId: result.parentSymbolId ?? parentName,
              parentType,
              symbolId: result.symbolId ?? this.buildSymbolId(parentName),
              lineRanges: result.lineRanges,
            },
          });
        }
      } /* v8 ignore next 19 -- defensive: all languages with alwaysExtractChildren have hooks */ else {
        const bodyContent = this.extractContainerBody(node, validChildren, code);
        if (bodyContent && bodyContent.trim().length >= 50) {
          chunks.push({
            content: bodyContent.trim(),
            startLine: node.startPosition.row + 1,
            endLine: this.computeEndLine(node),
            metadata: {
              filePath,
              language,
              chunkIndex: chunks.length,
              chunkType: "block",
              name: parentName,
              parentSymbolId: parentName,
              parentType,
              symbolId: this.buildSymbolId(parentName),
            },
          });
        }
      }
    }
    return true;
  }

  // No valid children found
  const content = code.substring(node.startIndex, node.endIndex);
  const isTooLarge = content.length > this.config.maxChunkSize * 2;
  if (isTooLarge) {
    await this.chunkOversizedNode(node, parentName, parentType, code, filePath, language, chunks);
    return true;
  }

  // alwaysExtractChildren but no valid children — fall through to single chunk
  return false;
}
```

- [ ] **Step 3: Extract chunkSingleNode (lines 308-323)**

```typescript
/**
 * Handle regular single-node chunking (no child extraction).
 */
private chunkSingleNode(
  node: Parser.SyntaxNode,
  index: number,
  code: string,
  filePath: string,
  language: string,
  chunks: CodeChunk[],
): void {
  const content = code.substring(node.startIndex, node.endIndex);
  const nodeName = this.extractName(node, code);
  chunks.push({
    content: content.trim(),
    startLine: node.startPosition.row + 1,
    endLine: this.computeEndLine(node),
    metadata: {
      filePath,
      language,
      chunkIndex: index,
      chunkType: this.getChunkType(node.type),
      name: nodeName,
      symbolId: this.buildSymbolId(nodeName),
      methodLines: this.computeEndLine(node) - (node.startPosition.row + 1),
    },
  });
}
```

- [ ] **Step 4: Rewrite chunk() as router**

```typescript
async chunk(code: string, filePath: string, language: string): Promise<CodeChunk[]> {
  const definition = LANGUAGE_DEFINITIONS[language];
  if (definition && (definition as LanguageDefinition & { skipTreeSitter?: boolean }).skipTreeSitter) {
    if (definition.isDocumentation) {
      return this.markdownChunker.chunk(code, filePath, language);
    }
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
        const handled = await this.chunkWithChildExtraction(node, langConfig, code, filePath, language, chunks);
        if (handled) continue;
      }

      this.chunkSingleNode(node, index, code, filePath, language, chunks);
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

- [ ] **Step 5: Run tests**

Run:
`npx vitest run tests/core/domains/ingest/pipeline/chunker/tree-sitter-chunker.test.ts`
Expected: All tests pass

- [ ] **Step 6: Run full test suite**

Run: `npx vitest run` Expected: All tests pass

- [ ] **Step 7: Commit**

```bash
git add src/core/domains/ingest/pipeline/chunker/tree-sitter.ts
git commit -m "refactor(chunker): extract branch methods from TreeSitterChunker#chunk"
```

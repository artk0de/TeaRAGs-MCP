# Refactor: MarkdownChunker#chunk — Phase Extraction

## Problem

`MarkdownChunker#chunk()` in
`src/core/domains/ingest/pipeline/chunker/hooks/markdown/chunker.ts:52-189` is
137 lines with bugFixRate=63% (concerning). Every second commit is a bug fix.
The method handles parsing, section building, code block chunking, preamble
extraction, and whole-document fallback inline.

## Solution

Extract three private methods from the inline logic blocks. The main `chunk()`
method becomes a short orchestrator.

### Extracted methods

```typescript
// Extract code blocks as chunks, handling oversized blocks via character fallback.
// Currently: for-loop at ~line 80-140 in chunk().
private async buildCodeBlockChunks(
  chunks: CodeChunk[],
  codeBlocks: CodeBlockInfo[],
  sectionHeadings: HeadingInfo[],
  allHeadings: HeadingInfo[],
  filePath: string,
  language: string,
): Promise<void>

// Extract preamble (content before first heading, after frontmatter).
// Currently: if-block at ~line 142-170 in chunk().
private buildPreambleChunk(
  chunks: CodeChunk[],
  tree: Root,
  sectionHeadings: HeadingInfo[],
  lines: string[],
  codeBlockLineRanges: LineRange[],
  filePath: string,
  language: string,
): void

// Whole-document fallback when no chunks were produced.
// Currently: if-block at ~line 172-188 in chunk().
private buildWholeDocumentFallback(
  chunks: CodeChunk[],
  tree: Root,
  lines: string[],
  filePath: string,
  language: string,
): void
```

### Resulting chunk() method

```typescript
async chunk(code: string, filePath: string, language: string): Promise<CodeChunk[]> {
  const chunks: CodeChunk[] = [];
  const lines = code.split("\n");
  const tree = remark().use(remarkGfm).use(remarkFrontmatter, ["yaml"]).parse(code);

  const headings = this.collectHeadings(tree.children);
  const codeBlocks = this.collectCodeBlocks(tree.children);
  const sectionHeadings = headings.filter((h) => h.depth <= SECTION_HEADING_DEPTH);
  const codeBlockLineRanges = codeBlocks.map((b) => ({ startLine: b.startLine, endLine: b.endLine }));

  await this.buildSectionChunks(chunks, sectionHeadings, headings, lines, codeBlockLineRanges, filePath, language);
  await this.buildCodeBlockChunks(chunks, codeBlocks, sectionHeadings, headings, filePath, language);
  this.buildPreambleChunk(chunks, tree, sectionHeadings, lines, codeBlockLineRanges, filePath, language);
  this.buildWholeDocumentFallback(chunks, tree, lines, filePath, language);

  return chunks;
}
```

## Scope

- Files modified:
  `src/core/domains/ingest/pipeline/chunker/hooks/markdown/chunker.ts`
- No new files
- No behavior change — pure extract-method
- All existing tests must pass without modification

## Risks

- `buildCodeBlockChunks` mutates the `chunks` array (same pattern as existing
  `buildSectionChunks`). Consistent with current style.
- Re-indexing of `chunkIndex` in `buildPreambleChunk` (unshift + reindex loop)
  must stay intact.

## Success Criteria

- `chunk()` body is <= 20 lines
- Three new private methods, each < 50 lines
- All existing MarkdownChunker tests pass
- bugFixRate should decrease in subsequent commits (measurable after ~5 commits)

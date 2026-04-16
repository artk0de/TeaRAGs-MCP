# MarkdownChunker#chunk Refactor Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use
> superpowers:subagent-driven-development (recommended) or
> superpowers:executing-plans to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extract inline phases from `MarkdownChunker#chunk()` into private
methods, reducing it from 137 lines to ~15 lines.

**Architecture:** Three extract-method refactorings within the same class. No
new files, no behavior change.

**Tech Stack:** TypeScript, Vitest

**Spec:**
`docs/superpowers/specs/2026-04-16-markdown-chunker-refactor-design.md`

---

### Task 1: Extract buildCodeBlockChunks

**Files:**

- Modify:
  `src/core/domains/ingest/pipeline/chunker/hooks/markdown/chunker.ts:52-189`
- Test:
  `tests/core/domains/ingest/pipeline/chunker/hooks/markdown/chunker.test.ts`
  (existing)

- [ ] **Step 1: Extract the code block for-loop (lines 71-119) into a private
      method**

Add after `buildSectionChunks` method:

```typescript
/**
 * Create code block chunks, splitting oversized blocks via character fallback.
 */
private async buildCodeBlockChunks(
  chunks: CodeChunk[],
  codeBlocks: CodeBlockInfo[],
  sectionHeadings: HeadingInfo[],
  allHeadings: HeadingInfo[],
  filePath: string,
  language: string,
): Promise<void> {
  for (const block of codeBlocks) {
    if (block.value.length < MIN_CODE_BLOCK_SIZE) continue;
    if (this.isMermaid(block)) continue;

    const parentHeading = this.findNearestHeading(sectionHeadings, block.startLine);
    const codeBlockName = block.lang ? `Code: ${block.lang}` : "Code block";
    const codeBlockMeta = {
      name: codeBlockName,
      symbolId: codeBlockName,
      isDocumentation: true as const,
      headingPath: parentHeading ? this.buildHeadingPath(allHeadings, parentHeading) : [],
      ...(parentHeading && {
        parentSymbolId: parentHeading.text,
        parentType: `h${parentHeading.depth}`,
      }),
    };

    // Oversized code block → split via character fallback
    if (block.value.length > this.config.maxChunkSize) {
      const subChunks = await this.fallbackChunker.chunk(block.value, filePath, block.lang || "code");
      for (const subChunk of subChunks) {
        chunks.push({
          ...subChunk,
          startLine: block.startLine + 1 + subChunk.startLine - 1,
          endLine: block.startLine + 1 + subChunk.endLine - 1,
          metadata: {
            ...subChunk.metadata,
            chunkIndex: chunks.length,
            chunkType: "block",
            ...codeBlockMeta,
          },
        });
      }
      continue;
    }

    chunks.push({
      content: block.value,
      startLine: block.startLine + 1,
      endLine: block.endLine - 1,
      metadata: {
        filePath,
        language: block.lang || "code",
        chunkIndex: chunks.length,
        chunkType: "block",
        ...codeBlockMeta,
      },
    });
  }
}
```

- [ ] **Step 2: Extract buildPreambleChunk (lines 121-160)**

```typescript
/**
 * Extract preamble content before first section heading, after frontmatter.
 */
private buildPreambleChunk(
  chunks: CodeChunk[],
  children: Content[],
  sectionHeadings: HeadingInfo[],
  lines: string[],
  codeBlockLineRanges: { startLine: number; endLine: number }[],
  filePath: string,
  language: string,
): void {
  if (sectionHeadings.length === 0) return;

  const firstContentLine = this.findFirstContentLine(children);
  const preambleEndLine = sectionHeadings[0].startLine - 1;

  if (firstContentLine <= 0 || firstContentLine > preambleEndLine) return;

  const preambleLines: string[] = [];
  for (let line = firstContentLine - 1; line < preambleEndLine; line++) {
    const lineNum = line + 1;
    const inCodeBlock = codeBlockLineRanges.some((r) => lineNum >= r.startLine && lineNum <= r.endLine);
    if (!inCodeBlock) {
      preambleLines.push(lines[line]);
    }
  }
  const preamble = preambleLines.join("\n").trim();

  if (preamble.length < MIN_SECTION_SIZE) return;

  chunks.unshift({
    content: preamble,
    startLine: firstContentLine,
    endLine: preambleEndLine,
    metadata: {
      filePath,
      language,
      chunkIndex: 0,
      chunkType: "block",
      name: "Preamble",
      symbolId: "Preamble",
      isDocumentation: true,
      headingPath: [],
    },
  });
  // Re-index
  for (let i = 1; i < chunks.length; i++) {
    chunks[i].metadata.chunkIndex = i;
  }
}
```

- [ ] **Step 3: Extract buildWholeDocumentFallback (lines 162-186)**

```typescript
/**
 * Whole-document fallback when no chunks were produced. Strips frontmatter.
 */
private buildWholeDocumentFallback(
  chunks: CodeChunk[],
  children: Content[],
  lines: string[],
  filePath: string,
  language: string,
): void {
  if (chunks.length > 0) return;

  const firstContentLine = this.findFirstContentLine(children);
  const startLine = firstContentLine > 0 ? firstContentLine : 1;
  const content = lines
    .slice(startLine - 1)
    .join("\n")
    .trim();

  if (content.length < MIN_SECTION_SIZE) return;

  chunks.push({
    content,
    startLine,
    endLine: lines.length,
    metadata: {
      filePath,
      language,
      chunkIndex: 0,
      chunkType: "block",
      isDocumentation: true,
      headingPath: [],
    },
  });
}
```

- [ ] **Step 4: Rewrite chunk() as orchestrator**

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
  this.buildPreambleChunk(chunks, tree.children, sectionHeadings, lines, codeBlockLineRanges, filePath, language);
  this.buildWholeDocumentFallback(chunks, tree.children, lines, filePath, language);

  return chunks;
}
```

- [ ] **Step 5: Run tests**

Run:
`npx vitest run tests/core/domains/ingest/pipeline/chunker/hooks/markdown/chunker.test.ts`
Expected: All tests pass

- [ ] **Step 6: Run full test suite**

Run: `npx vitest run` Expected: All tests pass

- [ ] **Step 7: Commit**

```bash
git add src/core/domains/ingest/pipeline/chunker/hooks/markdown/chunker.ts
git commit -m "refactor(chunker): extract phase methods from MarkdownChunker#chunk"
```

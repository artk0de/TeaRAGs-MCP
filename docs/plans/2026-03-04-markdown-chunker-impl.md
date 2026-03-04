# MarkdownChunker Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Extract markdown chunking into a dedicated `MarkdownChunker` class with 4 quality fixes: frontmatter handling, code block dedup, parentName for code blocks, Mermaid filtering.

**Architecture:** New `MarkdownChunker` class in `chunker/hooks/markdown/` replaces `chunkMarkdownSimple()` in `TreeSitterChunker`. Uses remark + remark-gfm + remark-frontmatter for AST parsing. Section chunks contain prose only (code blocks excluded). Code blocks ≥50 chars become separate chunks with `parentName` from nearest h1/h2.

**Tech Stack:** remark, remark-gfm, remark-frontmatter (new dep), vitest

**Design:** `docs/plans/2026-03-04-markdown-chunker-design.md`

---

### Task 1: Install remark-frontmatter dependency

**Files:**
- Modify: `package.json`

**Step 1: Install the dependency**

Run: `npm install remark-frontmatter`

**Step 2: Verify installation**

Run: `grep remark-frontmatter package.json`
Expected: `"remark-frontmatter": "^5.x.x"` in dependencies

**Step 3: Commit**

```bash
git add package.json package-lock.json
git commit -m "chore: add remark-frontmatter dependency"
```

---

### Task 2: Create MarkdownChunker class with frontmatter fix (TDD)

**Files:**
- Create: `src/core/ingest/pipeline/chunker/hooks/markdown/chunker.ts`
- Create: `src/core/ingest/pipeline/chunker/hooks/markdown/index.ts`
- Create: `tests/core/ingest/pipeline/chunker/hooks/markdown/chunker.test.ts`

**Step 1: Write failing tests for frontmatter handling**

Create `tests/core/ingest/pipeline/chunker/hooks/markdown/chunker.test.ts`:

```typescript
import { describe, expect, it } from "vitest";
import { MarkdownChunker } from "../../../../../../src/core/ingest/pipeline/chunker/hooks/markdown/chunker.js";

const defaultConfig = { maxChunkSize: 5000 };

describe("MarkdownChunker", () => {
  const chunker = new MarkdownChunker(defaultConfig);

  describe("frontmatter handling", () => {
    it("should exclude YAML frontmatter from chunks", async () => {
      const code = [
        "---",
        "title: My Document",
        "sidebar_position: 1",
        "---",
        "",
        "# Introduction",
        "",
        "This is the introduction with enough content to exceed the minimum threshold.",
      ].join("\n");

      const chunks = await chunker.chunk(code, "doc.md", "markdown");

      // No chunk should contain frontmatter YAML
      for (const chunk of chunks) {
        expect(chunk.content).not.toContain("sidebar_position");
        expect(chunk.content).not.toContain("title: My Document");
      }

      // Should still have the section chunk
      const intro = chunks.find((c) => c.metadata.name === "Introduction");
      expect(intro).toBeDefined();
    });

    it("should not create a preamble chunk from frontmatter-only content before heading", async () => {
      const code = [
        "---",
        "title: RFC 0003",
        "slug: /rfc/0003",
        "---",
        "",
        "# Overview",
        "",
        "The overview section has enough content to be a valid chunk by itself.",
      ].join("\n");

      const chunks = await chunker.chunk(code, "rfc.md", "markdown");

      // No preamble — frontmatter is the only thing before the heading
      const preamble = chunks.find((c) => c.metadata.name === "Preamble");
      expect(preamble).toBeUndefined();
    });

    it("should create preamble from real content after frontmatter", async () => {
      const code = [
        "---",
        "title: Guide",
        "---",
        "",
        "This is real introductory content that appears after frontmatter but before any heading.",
        "",
        "# First Section",
        "",
        "Content for the first section that exceeds the minimum threshold for chunking.",
      ].join("\n");

      const chunks = await chunker.chunk(code, "guide.md", "markdown");

      const preamble = chunks.find((c) => c.metadata.name === "Preamble");
      expect(preamble).toBeDefined();
      expect(preamble!.content).toContain("real introductory content");
      expect(preamble!.content).not.toContain("title: Guide");
    });
  });

  describe("basic section chunking", () => {
    it("should create section chunks from h1/h2 headings", async () => {
      const code = [
        "# Introduction",
        "",
        "Introduction content with enough text to exceed the minimum chunk threshold.",
        "",
        "## Getting Started",
        "",
        "Getting started content with enough text to exceed the minimum chunk threshold.",
        "",
        "## Usage",
        "",
        "Usage content with enough text to exceed the minimum chunk threshold value.",
      ].join("\n");

      const chunks = await chunker.chunk(code, "doc.md", "markdown");

      const names = chunks.filter((c) => c.metadata.language === "markdown").map((c) => c.metadata.name);
      expect(names).toContain("Introduction");
      expect(names).toContain("Getting Started");
      expect(names).toContain("Usage");
    });

    it("should include h3+ content in parent h1/h2 section", async () => {
      const code = [
        "## Getting Started",
        "",
        "Overview of getting started process.",
        "",
        "### Installation",
        "",
        "Run npm install to install all dependencies required for the project.",
        "",
        "### Configuration",
        "",
        "Configure the project by editing the configuration file as needed.",
      ].join("\n");

      const chunks = await chunker.chunk(code, "doc.md", "markdown");

      const section = chunks.find((c) => c.metadata.name === "Getting Started");
      expect(section).toBeDefined();
      expect(section!.content).toContain("Installation");
      expect(section!.content).toContain("Configuration");

      // h3 headings should NOT create separate chunks
      const names = chunks.map((c) => c.metadata.name);
      expect(names).not.toContain("Installation");
      expect(names).not.toContain("Configuration");
    });

    it("should set isDocumentation on all chunks", async () => {
      const code = [
        "# Title",
        "",
        "Content that is long enough to exceed the fifty character minimum threshold.",
      ].join("\n");

      const chunks = await chunker.chunk(code, "doc.md", "markdown");
      for (const chunk of chunks) {
        expect(chunk.metadata.isDocumentation).toBe(true);
      }
    });

    it("should set symbolId equal to section name", async () => {
      const code = [
        "# My Section",
        "",
        "Content that is long enough to exceed the fifty character minimum threshold.",
      ].join("\n");

      const chunks = await chunker.chunk(code, "doc.md", "markdown");
      const section = chunks.find((c) => c.metadata.name === "My Section");
      expect(section!.metadata.symbolId).toBe("My Section");
    });

    it("should skip sections under 50 chars", async () => {
      const code = [
        "# Short",
        "",
        "Tiny.",
        "",
        "# Detailed Section",
        "",
        "This section has enough content to exceed the fifty character minimum threshold.",
      ].join("\n");

      const chunks = await chunker.chunk(code, "doc.md", "markdown");
      expect(chunks.find((c) => c.metadata.name === "Short")).toBeUndefined();
      expect(chunks.find((c) => c.metadata.name === "Detailed Section")).toBeDefined();
    });

    it("should treat whole document as one chunk when no headings", async () => {
      const code = [
        "This is a document with no headings but enough content to exceed the minimum.",
        "It should become a single chunk covering the entire document content.",
      ].join("\n");

      const chunks = await chunker.chunk(code, "notes.md", "markdown");
      expect(chunks.length).toBe(1);
      expect(chunks[0].metadata.chunkType).toBe("block");
      expect(chunks[0].metadata.isDocumentation).toBe(true);
    });

    it("should return empty array for tiny documents", async () => {
      const chunks = await chunker.chunk("Short.", "tiny.md", "markdown");
      expect(chunks.length).toBe(0);
    });
  });
});
```

**Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/core/ingest/pipeline/chunker/hooks/markdown/chunker.test.ts`
Expected: FAIL — module not found

**Step 3: Implement MarkdownChunker with frontmatter support**

Create `src/core/ingest/pipeline/chunker/hooks/markdown/chunker.ts`:

```typescript
import type { Content } from "mdast";
import { remark } from "remark";
import remarkFrontmatter from "remark-frontmatter";
import remarkGfm from "remark-gfm";

import type { ChunkerConfig, CodeChunk } from "../../../../types.js";
import type { CodeChunker } from "../../base.js";
import { CharacterChunker } from "../../character.js";

interface HeadingInfo {
  depth: number;
  text: string;
  startLine: number;
  endLine: number;
}

interface CodeBlockInfo {
  lang: string | undefined;
  value: string;
  startLine: number;
  endLine: number;
}

/** Minimum character threshold for Mermaid heuristic detection */
const MERMAID_KEYWORDS = /(?:flowchart|graph|sequenceDiagram|classDiagram|stateDiagram|erDiagram|gantt|pie|gitGraph|subgraph)/;

/** Section heading depth — h1/h2 are section boundaries, h3+ rolls up */
const SECTION_HEADING_DEPTH = 2;

/** Minimum chars for a code block to become its own chunk */
const MIN_CODE_BLOCK_SIZE = 50;

/** Minimum chars for a section or preamble chunk */
const MIN_SECTION_SIZE = 50;

export class MarkdownChunker {
  private readonly config: { maxChunkSize: number };
  private readonly fallbackChunker: CodeChunker;

  constructor(config: { maxChunkSize: number }, fallbackChunker?: CodeChunker) {
    this.config = config;
    this.fallbackChunker = fallbackChunker ?? new CharacterChunker({
      chunkSize: Math.floor(config.maxChunkSize / 2),
      chunkOverlap: 300,
      maxChunkSize: config.maxChunkSize,
    });
  }

  async chunk(code: string, filePath: string, language: string): Promise<CodeChunk[]> {
    const chunks: CodeChunk[] = [];
    const lines = code.split("\n");

    // Parse with frontmatter support
    const tree = remark().use(remarkGfm).use(remarkFrontmatter, ["yaml"]).parse(code);

    const headings = this.collectHeadings(tree.children);
    const codeBlocks = this.collectCodeBlocks(tree.children);
    const sectionHeadings = headings.filter((h) => h.depth <= SECTION_HEADING_DEPTH);

    // Build set of code block line ranges for exclusion from sections
    const codeBlockLineRanges = codeBlocks
      .filter((b) => !this.isMermaid(b) && b.value.length >= MIN_CODE_BLOCK_SIZE)
      .map((b) => ({ startLine: b.startLine, endLine: b.endLine }));

    // Create section chunks (prose only — code blocks excluded)
    for (let i = 0; i < sectionHeadings.length; i++) {
      const heading = sectionHeadings[i];
      const sectionEndLine = i + 1 < sectionHeadings.length
        ? sectionHeadings[i + 1].startLine - 1
        : lines.length;

      // Extract section lines, excluding code block ranges
      const sectionLines: string[] = [];
      for (let line = heading.startLine - 1; line < sectionEndLine; line++) {
        const lineNum = line + 1; // 1-based
        const inCodeBlock = codeBlockLineRanges.some(
          (r) => lineNum >= r.startLine && lineNum <= r.endLine,
        );
        if (!inCodeBlock) {
          sectionLines.push(lines[line]);
        }
      }
      const sectionContent = sectionLines.join("\n").trim();

      if (sectionContent.length < MIN_SECTION_SIZE) continue;

      // Oversized section → fallback
      if (sectionContent.length > this.config.maxChunkSize * 2) {
        const subChunks = await this.fallbackChunker.chunk(sectionContent, filePath, language);
        for (const subChunk of subChunks) {
          chunks.push({
            ...subChunk,
            startLine: heading.startLine + subChunk.startLine - 1,
            endLine: heading.startLine + subChunk.endLine - 1,
            metadata: {
              ...subChunk.metadata,
              chunkIndex: chunks.length,
              name: heading.text,
              parentName: heading.text,
              parentType: `h${heading.depth}`,
              isDocumentation: true,
            },
          });
        }
        continue;
      }

      chunks.push({
        content: sectionContent,
        startLine: heading.startLine,
        endLine: sectionEndLine,
        metadata: {
          filePath,
          language,
          chunkIndex: chunks.length,
          chunkType: "block",
          name: heading.text,
          symbolId: heading.text,
          isDocumentation: true,
        },
      });
    }

    // Create code block chunks with parentName
    for (const block of codeBlocks) {
      if (block.value.length < MIN_CODE_BLOCK_SIZE) continue;
      if (this.isMermaid(block)) continue;

      const parentHeading = this.findNearestHeading(sectionHeadings, block.startLine);
      const codeBlockName = block.lang ? `Code: ${block.lang}` : "Code block";

      chunks.push({
        content: block.value,
        startLine: block.startLine + 1, // skip ``` line
        endLine: block.endLine - 1,     // skip closing ```
        metadata: {
          filePath,
          language: block.lang || "code",
          chunkIndex: chunks.length,
          chunkType: "block",
          name: codeBlockName,
          symbolId: codeBlockName,
          isDocumentation: true,
          ...(parentHeading && {
            parentName: parentHeading.text,
            parentType: `h${parentHeading.depth}`,
          }),
        },
      });
    }

    // Handle preamble (content before first section heading, after frontmatter)
    if (sectionHeadings.length > 0) {
      // Find where actual content starts (after frontmatter)
      const firstContentLine = this.findFirstContentLine(tree.children);
      const preambleEndLine = sectionHeadings[0].startLine - 1;

      if (firstContentLine > 0 && firstContentLine <= preambleEndLine) {
        const preambleLines: string[] = [];
        for (let line = firstContentLine - 1; line < preambleEndLine; line++) {
          const lineNum = line + 1;
          const inCodeBlock = codeBlockLineRanges.some(
            (r) => lineNum >= r.startLine && lineNum <= r.endLine,
          );
          if (!inCodeBlock) {
            preambleLines.push(lines[line]);
          }
        }
        const preamble = preambleLines.join("\n").trim();

        if (preamble.length >= MIN_SECTION_SIZE) {
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
            },
          });
          // Re-index
          for (let i = 1; i < chunks.length; i++) {
            chunks[i].metadata.chunkIndex = i;
          }
        }
      }
    }

    // Whole-document fallback
    if (chunks.length === 0 && code.length >= MIN_SECTION_SIZE) {
      chunks.push({
        content: code.trim(),
        startLine: 1,
        endLine: lines.length,
        metadata: {
          filePath,
          language,
          chunkIndex: 0,
          chunkType: "block",
          isDocumentation: true,
        },
      });
    }

    return chunks;
  }

  // --- Private helpers ---

  private collectHeadings(children: Content[]): HeadingInfo[] {
    const headings: HeadingInfo[] = [];
    for (const node of children) {
      if (node.type === "heading" && node.position) {
        headings.push({
          depth: node.depth,
          text: this.extractText(node),
          startLine: node.position.start.line,
          endLine: node.position.end.line,
        });
      }
    }
    return headings;
  }

  private collectCodeBlocks(children: Content[]): CodeBlockInfo[] {
    const blocks: CodeBlockInfo[] = [];
    const collect = (node: Content) => {
      if (node.type === "code" && node.position) {
        blocks.push({
          lang: node.lang || undefined,
          value: node.value,
          startLine: node.position.start.line,
          endLine: node.position.end.line,
        });
      }
      if ("children" in node && Array.isArray(node.children)) {
        for (const child of node.children) {
          collect(child as Content);
        }
      }
    };
    for (const child of children) {
      collect(child);
    }
    return blocks;
  }

  private extractText(node: Content): string {
    if (node.type === "text") {
      return (node as { type: "text"; value: string }).value;
    }
    if ("children" in node && Array.isArray(node.children)) {
      return node.children.map((child: Content) => this.extractText(child)).join("");
    }
    return "";
  }

  private isMermaid(block: CodeBlockInfo): boolean {
    if (block.lang === "mermaid") return true;
    // Heuristic for unlabeled Mermaid blocks
    if (!block.lang && MERMAID_KEYWORDS.test(block.value)) return true;
    return false;
  }

  private findNearestHeading(headings: HeadingInfo[], lineNum: number): HeadingInfo | undefined {
    // Find the last heading that starts before this line
    let nearest: HeadingInfo | undefined;
    for (const h of headings) {
      if (h.startLine <= lineNum) {
        nearest = h;
      } else {
        break;
      }
    }
    return nearest;
  }

  /** Find the first non-frontmatter content line (1-based) */
  private findFirstContentLine(children: Content[]): number {
    for (const node of children) {
      // Skip frontmatter nodes (type "yaml" from remark-frontmatter)
      if (node.type === "yaml") continue;
      if (node.position) return node.position.start.line;
    }
    return 0;
  }
}
```

Create `src/core/ingest/pipeline/chunker/hooks/markdown/index.ts`:

```typescript
export { MarkdownChunker } from "./chunker.js";
```

**Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/core/ingest/pipeline/chunker/hooks/markdown/chunker.test.ts`
Expected: ALL PASS

**Step 5: Commit**

```bash
git add src/core/ingest/pipeline/chunker/hooks/markdown/ tests/core/ingest/pipeline/chunker/hooks/markdown/
git commit -m "feat(chunker): add MarkdownChunker with frontmatter support"
```

---

### Task 3: Add code block dedup and parentName tests (TDD)

**Files:**
- Modify: `tests/core/ingest/pipeline/chunker/hooks/markdown/chunker.test.ts`

**Step 1: Write failing tests for code block dedup and parentName**

Append to the test file inside the main `describe("MarkdownChunker")`:

```typescript
  describe("code block deduplication", () => {
    it("should exclude code blocks from section content", async () => {
      const code = [
        "# Setup Guide",
        "",
        "Install the package:",
        "",
        "```bash",
        "npm install tea-rags-mcp",
        "npm run build",
        "```",
        "",
        "Then configure your environment settings for the project.",
      ].join("\n");

      const chunks = await chunker.chunk(code, "setup.md", "markdown");

      const section = chunks.find((c) => c.metadata.name === "Setup Guide");
      expect(section).toBeDefined();
      // Section should contain prose but NOT the code block content
      expect(section!.content).toContain("Install the package");
      expect(section!.content).toContain("configure your environment");
      expect(section!.content).not.toContain("npm install tea-rags-mcp");
    });

    it("should create separate code block chunk with parentName", async () => {
      const code = [
        "# Setup Guide",
        "",
        "Install the package:",
        "",
        "```bash",
        "npm install tea-rags-mcp",
        "npm run build",
        "```",
        "",
        "Then configure your environment settings for the project.",
      ].join("\n");

      const chunks = await chunker.chunk(code, "setup.md", "markdown");

      const codeBlock = chunks.find((c) => c.metadata.name === "Code: bash");
      expect(codeBlock).toBeDefined();
      expect(codeBlock!.content).toContain("npm install tea-rags-mcp");
      expect(codeBlock!.metadata.parentName).toBe("Setup Guide");
      expect(codeBlock!.metadata.parentType).toBe("h1");
    });

    it("should skip code blocks under 50 chars", async () => {
      const code = [
        "# Examples",
        "",
        "A tiny snippet:",
        "",
        "```js",
        "x = 1;",
        "```",
        "",
        "A larger example with enough content to pass the minimum threshold:",
        "",
        "```python",
        "def calculate_fibonacci(n):",
        "    if n <= 1:",
        "        return n",
        "    return calculate_fibonacci(n-1) + calculate_fibonacci(n-2)",
        "```",
      ].join("\n");

      const chunks = await chunker.chunk(code, "examples.md", "markdown");

      const jsBlocks = chunks.filter((c) => c.metadata.language === "js");
      expect(jsBlocks.length).toBe(0);

      const pyBlocks = chunks.filter((c) => c.metadata.language === "python");
      expect(pyBlocks.length).toBe(1);
    });

    it("should set parentName from nearest h2 heading", async () => {
      const code = [
        "# Main Title",
        "",
        "Intro text for the main title section with enough content here.",
        "",
        "## API Reference",
        "",
        "The main API method:",
        "",
        "```typescript",
        "async function search(query: string): Promise<Result[]> {",
        "  return await client.search({ query, limit: 10 });",
        "}",
        "```",
      ].join("\n");

      const chunks = await chunker.chunk(code, "api.md", "markdown");

      const codeBlock = chunks.find((c) => c.metadata.name === "Code: typescript");
      expect(codeBlock).toBeDefined();
      expect(codeBlock!.metadata.parentName).toBe("API Reference");
      expect(codeBlock!.metadata.parentType).toBe("h2");
    });

    it("should handle code blocks before any heading (no parentName)", async () => {
      const code = [
        "Quick setup snippet:",
        "",
        "```bash",
        "npm install && npm run build && npm start",
        "```",
        "",
        "# Introduction",
        "",
        "Welcome to the project documentation with enough text to pass threshold.",
      ].join("\n");

      const chunks = await chunker.chunk(code, "doc.md", "markdown");

      const codeBlock = chunks.find((c) => c.metadata.name === "Code: bash");
      expect(codeBlock).toBeDefined();
      expect(codeBlock!.metadata.parentName).toBeUndefined();
    });
  });
```

**Step 2: Run tests to verify the new tests pass**

Run: `npx vitest run tests/core/ingest/pipeline/chunker/hooks/markdown/chunker.test.ts`
Expected: ALL PASS (implementation from Task 2 already handles these)

**Step 3: Commit**

```bash
git add tests/core/ingest/pipeline/chunker/hooks/markdown/chunker.test.ts
git commit -m "test(chunker): add code block dedup and parentName tests"
```

---

### Task 4: Add Mermaid filtering tests (TDD)

**Files:**
- Modify: `tests/core/ingest/pipeline/chunker/hooks/markdown/chunker.test.ts`

**Step 1: Write tests for Mermaid filtering**

Append to the test file:

```typescript
  describe("mermaid filtering", () => {
    it("should skip code blocks with lang=mermaid", async () => {
      const code = [
        "# Architecture",
        "",
        "The system architecture is shown below:",
        "",
        "```mermaid",
        "flowchart LR",
        "    A[Client] --> B[Server]",
        "    B --> C[Database]",
        "```",
        "",
        "The client communicates with the server which stores data.",
      ].join("\n");

      const chunks = await chunker.chunk(code, "arch.md", "markdown");

      const mermaidChunks = chunks.filter((c) => c.metadata.language === "mermaid");
      expect(mermaidChunks.length).toBe(0);
    });

    it("should skip unlabeled code blocks with Mermaid keywords", async () => {
      const code = [
        "# Flow",
        "",
        "The request flow is depicted in this diagram for reference:",
        "",
        "```",
        "flowchart TB",
        "    A[Request] --> B[Handler]",
        "    B --> C{Valid?}",
        "    C -->|Yes| D[Process]",
        "    C -->|No| E[Reject]",
        "```",
      ].join("\n");

      const chunks = await chunker.chunk(code, "flow.md", "markdown");

      // Should NOT create a code block chunk for the Mermaid diagram
      const codeChunks = chunks.filter(
        (c) => c.metadata.name === "Code block" || c.metadata.language === "code",
      );
      expect(codeChunks.length).toBe(0);
    });

    it("should NOT skip non-Mermaid unlabeled code blocks", async () => {
      const code = [
        "# Examples",
        "",
        "Run these commands to set up the project environment:",
        "",
        "```",
        "npm install",
        "npm run build",
        "npm run test",
        "```",
      ].join("\n");

      const chunks = await chunker.chunk(code, "example.md", "markdown");

      // This is NOT Mermaid — should be included as a code chunk
      const codeChunks = chunks.filter((c) => c.metadata.name === "Code block");
      expect(codeChunks.length).toBe(1);
    });
  });
```

**Step 2: Run tests**

Run: `npx vitest run tests/core/ingest/pipeline/chunker/hooks/markdown/chunker.test.ts`
Expected: ALL PASS

**Step 3: Commit**

```bash
git add tests/core/ingest/pipeline/chunker/hooks/markdown/chunker.test.ts
git commit -m "test(chunker): add Mermaid filtering tests"
```

---

### Task 5: Wire MarkdownChunker into TreeSitterChunker

**Files:**
- Modify: `src/core/ingest/pipeline/chunker/tree-sitter.ts`

**Step 1: Write integration test**

Append to `tests/core/ingest/pipeline/chunker/hooks/markdown/chunker.test.ts`:

```typescript
describe("TreeSitterChunker markdown delegation", () => {
  it("should delegate markdown to MarkdownChunker via TreeSitterChunker", async () => {
    const { TreeSitterChunker } = await import(
      "../../../../../../src/core/ingest/pipeline/chunker/tree-sitter.js"
    );
    const tsChunker = new TreeSitterChunker({
      chunkSize: 2500,
      chunkOverlap: 300,
      maxChunkSize: 5000,
    });

    const code = [
      "---",
      "title: Test Doc",
      "---",
      "",
      "# Section",
      "",
      "Content with enough text to exceed the fifty character minimum threshold.",
    ].join("\n");

    const chunks = await tsChunker.chunk(code, "test.md", "markdown");

    // Frontmatter should be excluded (proves MarkdownChunker is used)
    for (const chunk of chunks) {
      expect(chunk.content).not.toContain("title: Test Doc");
    }
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run tests/core/ingest/pipeline/chunker/hooks/markdown/chunker.test.ts -t "TreeSitterChunker markdown delegation"`
Expected: FAIL — frontmatter still appears (old code path)

**Step 3: Modify TreeSitterChunker to delegate to MarkdownChunker**

In `src/core/ingest/pipeline/chunker/tree-sitter.ts`:

1. Add import at top (after line 12):
```typescript
import { MarkdownChunker } from "./hooks/markdown/index.js";
```

2. Add field to class (after `fallbackChunker` field):
```typescript
private readonly markdownChunker: MarkdownChunker;
```

3. Initialize in constructor (after `this.fallbackChunker` init):
```typescript
this.markdownChunker = new MarkdownChunker(
  { maxChunkSize: this.config.maxChunkSize },
  this.fallbackChunker,
);
```

4. Replace delegation in `chunk()` method (line 139):
```typescript
// OLD:
return this.chunkMarkdownSimple(code, filePath, language);
// NEW:
return this.markdownChunker.chunk(code, filePath, language);
```

5. Delete the `chunkMarkdownSimple()` method (lines 462-654) and `extractTextFromMdastNode()` method (lines 659-667).

6. Remove unused imports if remark/remarkGfm are no longer used in tree-sitter.ts:
```typescript
// Remove these if no other method uses them:
import type { Content } from "mdast";
import { remark } from "remark";
import remarkGfm from "remark-gfm";
```

**Step 4: Run all tests**

Run: `npx vitest run tests/core/ingest/pipeline/chunker/`
Expected: Some existing markdown tests in `tree-sitter-chunker.test.ts` may fail due to behavior changes (code blocks now excluded from sections, min size raised 30→50). These will be fixed in Task 6.

**Step 5: Commit (even if some old tests fail — they'll be migrated)**

```bash
git add src/core/ingest/pipeline/chunker/tree-sitter.ts src/core/ingest/pipeline/chunker/hooks/markdown/
git commit -m "feat(chunker): wire MarkdownChunker into TreeSitterChunker"
```

---

### Task 6: Migrate and update existing markdown tests

**Files:**
- Modify: `tests/core/ingest/pipeline/chunker/tree-sitter-chunker.test.ts`

Existing markdown tests in `tree-sitter-chunker.test.ts` need updating to reflect new behavior:

**Step 1: Update tests for new behavior**

Key changes to existing tests:

1. **Code block tests** — Code blocks are now excluded from section chunks. Tests that check `section.content.toContain("npm install")` need to check the code block chunk instead.

2. **Min code block size** — Threshold raised from 30 to 50 chars. The test "should skip very small code blocks under 30 chars" needs updating to reflect 50 char threshold.

3. **Code block chunks now have parentName** — Tests checking code block metadata should verify `parentName` is set.

4. **Frontmatter** — Any test fixtures with frontmatter should verify it's excluded.

Go through each markdown `describe` block in `tree-sitter-chunker.test.ts` and update assertions to match new behavior. Tests that are now duplicated (covered by new test file) can be removed.

**Step 2: Run all chunker tests**

Run: `npx vitest run tests/core/ingest/pipeline/chunker/`
Expected: ALL PASS

**Step 3: Run full test suite**

Run: `npx vitest run`
Expected: ALL PASS

**Step 4: Commit**

```bash
git add tests/core/ingest/pipeline/chunker/tree-sitter-chunker.test.ts
git commit -m "test(chunker): update markdown tests for MarkdownChunker behavior"
```

---

### Task 7: Verify with real index

**Step 1: Rebuild the index**

Run: Use `index_codebase` with `forceReindex: true` on the project.

**Step 2: Compare results**

Search for documentation chunks and verify:
- No frontmatter content in chunk names or content
- Code blocks have `parentName` set
- No Mermaid diagram chunks
- Reduced total chunk count for markdown files
- Section chunks contain prose only (no code blocks)

**Step 3: Final commit if any adjustments needed**

```bash
git add -A
git commit -m "fix(chunker): adjustments from integration testing"
```

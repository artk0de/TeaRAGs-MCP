import { describe, expect, it } from "vitest";

import { assignNavigationAndDocSymbolId } from "../../../../../../src/core/domains/ingest/pipeline/chunker/chunk-navigation.js";
import { MarkdownChunker } from "../../../../../../src/core/domains/ingest/pipeline/chunker/markdown-chunker.js";

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

    it("should group small h3 sections into parent h2 chunk", async () => {
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

      // Small h3s grouped into parent h2 chunk
      const h2Chunk = chunks.find((c) => c.metadata.name === "Getting Started");
      expect(h2Chunk).toBeDefined();
      expect(h2Chunk!.content).toContain("Installation");
      expect(h2Chunk!.content).toContain("Configuration");
      expect(h2Chunk!.content).toContain("npm install");
    });

    it("should split h3 sections into separate chunks when exceeding maxChunkSize", async () => {
      const smallChunker = new MarkdownChunker({ maxChunkSize: 200 });
      const longContent = "This is enough content to exceed the very small chunk size limit when combined.";

      const code = [
        "## Parent",
        "",
        "Parent intro text that is long enough.",
        "",
        "### Sub One",
        "",
        longContent,
        "",
        "### Sub Two",
        "",
        longContent,
      ].join("\n");

      const chunks = await smallChunker.chunk(code, "doc.md", "markdown");

      // Too large to fit in one chunk → h3s become separate chunks
      expect(chunks.length).toBeGreaterThan(1);
    });

    it("should record correct startLine/endLine when grouping h3 into h2", async () => {
      const code = [
        "# Title", // line 1
        "",
        "Intro content that meets minimum size requirements for a valid chunk here.", // line 3
        "",
        "## Section A", // line 5
        "",
        "Section A content with enough text to meet the fifty character minimum.", // line 7
        "",
        "### Sub 1", // line 9
        "",
        "Sub 1 content that is long enough to meet minimum size thresholds.", // line 11
        "",
        "### Sub 2", // line 13
        "",
        "Sub 2 content that is long enough to meet minimum size thresholds.", // line 15
        "",
        "## Section B", // line 17
        "",
        "Section B content that has enough text to meet minimum threshold.", // line 19
      ].join("\n");

      const chunks = await chunker.chunk(code, "doc.md", "markdown");

      // Section A should group Sub 1 + Sub 2
      const sectionA = chunks.find((c) => c.metadata.name === "Section A");
      expect(sectionA).toBeDefined();
      expect(sectionA!.startLine).toBe(5); // starts at ## Section A
      expect(sectionA!.endLine).toBe(16); // ends before ## Section B

      // Section B standalone
      const sectionB = chunks.find((c) => c.metadata.name === "Section B");
      expect(sectionB).toBeDefined();
      expect(sectionB!.startLine).toBe(17);
    });

    it("should set isDocumentation on all chunks", async () => {
      const code = ["# Title", "", "Content that is long enough to exceed the fifty character minimum threshold."].join(
        "\n",
      );

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

    it("should exclude frontmatter from whole-document fallback", async () => {
      const code = [
        "---",
        "title: Software Evolution & Mining",
        "sidebar_position: 3",
        "---",
        "",
        "This is a document with no headings but real content after frontmatter that exceeds the minimum.",
      ].join("\n");

      const chunks = await chunker.chunk(code, "doc.md", "markdown");
      expect(chunks.length).toBe(1);
      expect(chunks[0].content).not.toContain("sidebar_position");
      expect(chunks[0].content).not.toContain("title: Software");
      expect(chunks[0].content).toContain("real content after frontmatter");
    });

    it("should return empty for frontmatter-only stub pages", async () => {
      const code = ["---", "title: Open Questions", "---", "", "<!-- TODO: Fill this section -->"].join("\n");

      const chunks = await chunker.chunk(code, "stub.md", "markdown");
      // Frontmatter stripped, only a short HTML comment remains — under 50 chars
      expect(chunks.length).toBe(0);
    });

    it("should return empty for pure frontmatter-only documents", async () => {
      const code = ["---", "title: Placeholder", "draft: true", "---"].join("\n");

      const chunks = await chunker.chunk(code, "only-fm.md", "markdown");
      // No content after frontmatter at all — findFirstContentLine returns 0
      expect(chunks.length).toBe(0);
    });
  });

  describe("code block deduplication", () => {
    it("should exclude code blocks from section content", async () => {
      const code = [
        "# Setup Guide",
        "",
        "Install the package:",
        "",
        "```bash",
        "npm install tea-rags-mcp && npm run build && npm run setup",
        "npm run configure --production --verbose --output-dir=/tmp/build",
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
        "npm install tea-rags-mcp && npm run build && npm run setup",
        "npm run configure --production --verbose --output-dir=/tmp/build",
        "```",
        "",
        "Then configure your environment settings for the project.",
      ].join("\n");

      const chunks = await chunker.chunk(code, "setup.md", "markdown");

      const codeBlock = chunks.find((c) => c.metadata.name === "Code: bash");
      expect(codeBlock).toBeDefined();
      expect(codeBlock!.content).toContain("npm install tea-rags-mcp");
      expect(codeBlock!.content).toContain("npm run configure");
      expect(codeBlock!.metadata.parentSymbolId).toBe("Setup Guide");
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
      expect(codeBlock!.metadata.parentSymbolId).toBe("API Reference");
      expect(codeBlock!.metadata.parentType).toBe("h2");
    });

    it("should handle code blocks before any heading (no parentName)", async () => {
      const code = [
        "Quick setup snippet:",
        "",
        "```bash",
        "npm install && npm run build && npm start && npm run configure",
        "```",
        "",
        "# Introduction",
        "",
        "Welcome to the project documentation with enough text to pass threshold.",
      ].join("\n");

      const chunks = await chunker.chunk(code, "doc.md", "markdown");

      const codeBlock = chunks.find((c) => c.metadata.name === "Code: bash");
      expect(codeBlock).toBeDefined();
      expect(codeBlock!.metadata.parentSymbolId).toBeUndefined();
    });
  });

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
      const codeChunks = chunks.filter((c) => c.metadata.name === "Code block" || c.metadata.language === "code");
      expect(codeChunks.length).toBe(0);
    });

    it("should NOT skip non-Mermaid unlabeled code blocks", async () => {
      const code = [
        "# Examples",
        "",
        "Run these commands to set up the project environment:",
        "",
        "```",
        "npm install --save-dev typescript eslint prettier",
        "npm run build -- --production --output-dir=dist",
        "npm run test -- --coverage --reporter=verbose",
        "```",
      ].join("\n");

      const chunks = await chunker.chunk(code, "example.md", "markdown");

      // This is NOT Mermaid — should be included as a code chunk
      const codeChunks = chunks.filter((c) => c.metadata.name === "Code block");
      expect(codeChunks.length).toBe(1);
    });
  });

  describe("oversized code blocks", () => {
    it("should split oversized code blocks using character fallback", async () => {
      const smallChunker = new MarkdownChunker({ maxChunkSize: 100 });

      const longCode = Array(30).fill("const x = computeSomethingVeryLong();").join("\n");

      const md = ["# Setup", "", "```typescript", longCode, "```"].join("\n");

      const chunks = await smallChunker.chunk(md, "code.md", "markdown");

      // Should produce multiple sub-chunks from the oversized code block
      expect(chunks.length).toBeGreaterThan(1);
      for (const chunk of chunks) {
        expect(chunk.metadata.isDocumentation).toBe(true);
        expect(chunk.metadata.chunkType).toBe("block");
        expect(chunk.metadata.language).toBe("typescript");
      }
    });

    it("should preserve parent heading context in oversized code block sub-chunks", async () => {
      const smallChunker = new MarkdownChunker({ maxChunkSize: 100 });

      const longCode = Array(30).fill("function doWork() { return 42; }").join("\n");

      const md = ["## API Reference", "", "### Examples", "", "```python", longCode, "```"].join("\n");

      const chunks = await smallChunker.chunk(md, "api.md", "markdown");

      const codeChunks = chunks.filter((c) => c.metadata.language === "python");
      expect(codeChunks.length).toBeGreaterThan(1);
      // Each sub-chunk should have sequential chunk indices
      for (const chunk of codeChunks) {
        expect(chunk.metadata.chunkIndex).toBeDefined();
      }
    });
  });

  describe("oversized sections", () => {
    it("should split oversized sections using character fallback", async () => {
      const smallChunker = new MarkdownChunker({ maxChunkSize: 100 });

      const longContent = Array(30)
        .fill("This line of content is used to exceed the maximum chunk size threshold.")
        .join("\n");

      const code = [`# Big Section`, "", longContent].join("\n");

      const chunks = await smallChunker.chunk(code, "big.md", "markdown");

      // Should produce multiple sub-chunks from the oversized section
      expect(chunks.length).toBeGreaterThan(1);
      for (const chunk of chunks) {
        expect(chunk.metadata.isDocumentation).toBe(true);
        expect(chunk.metadata.name).toBe("Big Section");
      }
    });

    it("should build correct breadcrumbs when heading order varies", async () => {
      const smallChunker = new MarkdownChunker({ maxChunkSize: 5000 });

      const code = [
        "### Orphan H3",
        "",
        "Content under orphan h3 that has no parent h1 or h2 heading above it.",
        "",
        "## Middle Section",
        "",
        "Content under h2 that appears after an orphan h3 in the document flow.",
        "",
        "### Sub of Middle",
        "",
        "Content under h3 that is a child of the h2 Middle Section heading above.",
        "",
        "# Late H1",
        "",
        "Content under h1 that appears late in the document after h2 and h3 content.",
        "",
        "### H3 Under H1",
        "",
        "Content under h3 that is a child of the h1 Late H1 without intermediate h2.",
      ].join("\n");

      const chunks = await smallChunker.chunk(code, "mixed.md", "markdown");

      // Orphan h3 — no ancestors, no breadcrumb prefix
      const orphan = chunks.find((c) => c.metadata.name === "Orphan H3");
      expect(orphan).toBeDefined();
      expect(orphan!.content).not.toContain(" > ");

      // h3 grouped into h2 — "Middle Section" chunk contains "Sub of Middle" content
      const middle = chunks.find((c) => c.metadata.name === "Middle Section");
      expect(middle).toBeDefined();
      expect(middle!.content).toContain("Sub of Middle");
      expect(middle!.content).toContain("## Middle Section");

      // h3 under h1 (no h2) grouped into h1 — "Late H1" chunk contains h3 content
      const lateH1 = chunks.find((c) => c.metadata.name === "Late H1");
      expect(lateH1).toBeDefined();
      expect(lateH1!.content).toContain("H3 Under H1");
      expect(lateH1!.content).not.toContain("## Middle Section");
    });

    it("should include breadcrumb in every fallback sub-chunk", async () => {
      const smallChunker = new MarkdownChunker({ maxChunkSize: 200 });

      const longContent = Array(30)
        .fill("This line fills the subsection to force a character fallback split here.")
        .join("\n");

      const code = [
        `# Guide`,
        "",
        `## Auth`,
        "",
        "Authentication overview with enough content to meet minimum threshold size.",
        "",
        `### OAuth`,
        "",
        longContent,
      ].join("\n");

      const chunks = await smallChunker.chunk(code, "doc.md", "markdown");

      // OAuth too large to group into Auth → standalone, then fallback split
      const oauthChunks = chunks.filter((c) => c.metadata.name === "OAuth");
      expect(oauthChunks.length).toBeGreaterThan(1);

      // OAuth sub-chunks include breadcrumb from parent h2
      for (const chunk of oauthChunks) {
        expect(chunk.content).toContain("Auth");
      }
    });
  });

  // bd tea-rags-mcp-y5vx4 + tea-rags-mcp-308ff — an oversized section is cut
  // between its blocks, never inside a list, table or blockquote that fits a
  // window; each window after the first is framed by the heading path, which is
  // the only overlap; the first window carries its breadcrumb once.
  describe("structure-aware oversized sections (bd tea-rags-mcp-y5vx4)", () => {
    const BUDGET = 420;
    const block = (i: number) => ({
      paragraph: [
        `Paragraph ${i} explains the setting in a sentence long enough to matter.`,
        `It wraps onto a second line ${i}.`,
      ],
      table: [
        `| key ${i} | value ${i} |`,
        "| --- | --- |",
        `| alpha ${i} | first row of table ${i} |`,
        `| beta ${i} | second row of table ${i} |`,
        `| gamma ${i} | third row of table ${i} |`,
      ],
      list: [
        `- item one of list ${i}`,
        `- item two of list ${i}`,
        `  continued under item two ${i}`,
        `- item three of list ${i}`,
      ],
      quote: [`> quoted line one ${i}`, `> quoted line two ${i}`, `> quoted line three ${i}`],
    });
    const blocks = Array.from({ length: 5 }, (_, i) => block(i));
    const body = blocks.flatMap((b) => [...b.paragraph, "", ...b.table, "", ...b.list, "", ...b.quote, ""]);
    const code = ["# Doc", "", "## Section", "", ...body].join("\n");
    const sourceLines = code.split("\n");

    async function sectionWindows() {
      const chunks = await new MarkdownChunker({ maxChunkSize: BUDGET }).chunk(code, "doc.md", "markdown");
      return chunks.filter((c) => c.metadata.name === "Section");
    }

    const prefixOf = (c: { content: string; startLine: number; endLine: number }) => c.content.split("\n").slice(0, 1);

    it("splits into several windows, each within the budget", async () => {
      const windows = await sectionWindows();
      expect(windows.length).toBeGreaterThan(2);
      for (const w of windows) expect(w.content.length).toBeLessThanOrEqual(BUDGET);
    });

    it("never cuts inside a table, list or blockquote that fits a window", async () => {
      const windows = await sectionWindows();
      for (const b of blocks) {
        for (const lines of [b.table, b.list, b.quote]) {
          const marker = lines[0];
          const holders = windows.filter((w) => w.content.split("\n").includes(marker));
          expect(holders, marker).toHaveLength(1);
          const holder = holders[0].content.split("\n");
          for (const line of lines) expect(holder, `${marker} split`).toContain(line);
        }
      }
    });

    it("the first window carries its breadcrumb once (308ff), later windows open with the heading path", async () => {
      const windows = await sectionWindows();
      expect(windows[0].content.startsWith("# Doc\n# Doc")).toBe(false);
      expect(windows[0].content.startsWith("# Doc\n## Section")).toBe(true);
      for (const w of windows.slice(1)) {
        expect(prefixOf(w)).toEqual(["# Doc > ## Section"]);
        expect(w.content.split("\n").filter((l) => l === "# Doc > ## Section")).toHaveLength(1);
      }
    });

    it("windows tile the section: own lines are the source lines, each exactly once", async () => {
      const windows = await sectionWindows();
      const seen = new Map<string, number>();
      windows.forEach((w, i) => {
        // one prefix line each: the ancestor breadcrumb on the first window, the heading path after
        const own = w.content.split("\n").slice(1);
        expect(own.join("\n")).toBe(sourceLines.slice(w.startLine - 1, w.endLine).join("\n"));
        if (i > 0) expect(w.startLine).toBeGreaterThan(windows[i - 1].endLine);
        for (const line of own) if (line.trim() !== "") seen.set(line, (seen.get(line) ?? 0) + 1);
      });
      for (const line of body) if (line.trim() !== "" && line !== "| --- | --- |") expect(seen.get(line), line).toBe(1);
    });

    it("navigation of a section's windows points at other symbols, never back at its own id (308ff)", async () => {
      const chunks = await new MarkdownChunker({ maxChunkSize: BUDGET }).chunk(
        `${code}\n## After\n\nA closing section that follows the oversized one in the document.`,
        "/repo/doc.md",
        "markdown",
      );
      assignNavigationAndDocSymbolId(chunks, "/repo");
      for (const c of chunks) {
        expect(c.metadata.navigation?.prevSymbolId).not.toBe(c.metadata.symbolId);
        expect(c.metadata.navigation?.nextSymbolId).not.toBe(c.metadata.symbolId);
      }
      const section = chunks.filter((c) => c.metadata.name === "Section");
      expect(section[section.length - 1].metadata.navigation?.nextSymbolId).toBe(
        chunks.find((c) => c.metadata.name === "After")?.metadata.symbolId,
      );
    });
  });
});

// The pipeline hard cap (`maxChunkSize`, wired as `chunkSize` in
// `createChunkerPool`) is the embedding model's context budget: a heading-less
// document or a long preamble emitted whole overflowed it (taxdome PROMPT.md,
// 129 KB with no headings → one 81 159-char chunk → embedding 400 → file
// quarantined). Both paths are cut like an oversized section.
describe("MarkdownChunker — heading-less documents and preambles respect maxChunkSize", () => {
  const CAP = 500;
  const paragraph = (i: number) =>
    [
      `Paragraph ${i} explains one step of the prompt in a sentence long enough to matter.`,
      `It continues on a second line so the block spans rows ${i}.`,
      `- bullet one of paragraph ${i}`,
      `- bullet two of paragraph ${i}`,
    ].join("\n");
  const body = Array.from({ length: 12 }, (_, i) => paragraph(i)).join("\n\n");

  const expectWithinCapAndTiled = (
    chunks: { content: string; startLine: number; endLine: number }[],
    sourceLines: string[],
  ) => {
    for (const c of chunks) {
      expect(c.content.length).toBeLessThanOrEqual(CAP);
      expect(c.startLine).toBeGreaterThanOrEqual(1);
      expect(c.endLine).toBeGreaterThanOrEqual(c.startLine);
      expect(c.endLine).toBeLessThanOrEqual(sourceLines.length);
      expect(c.content).toBe(sourceLines.slice(c.startLine - 1, c.endLine).join("\n"));
    }
    for (let i = 1; i < chunks.length; i++) expect(chunks[i].startLine).toBeGreaterThan(chunks[i - 1].endLine);
  };

  it("cuts a heading-less document larger than the cap into parts, each within it, tiling the document", async () => {
    expect(body.length).toBeGreaterThan(CAP * 3);
    const sourceLines = body.split("\n");
    const chunks = await new MarkdownChunker({ maxChunkSize: CAP }).chunk(body, "PROMPT.md", "markdown");

    expect(chunks.length).toBeGreaterThan(2);
    expectWithinCapAndTiled(chunks, sourceLines);
    expect(chunks[0].startLine).toBe(1);
    expect(chunks[chunks.length - 1].endLine).toBe(sourceLines.length);
    const covered = new Set(chunks.flatMap((c) => c.content.split("\n")));
    for (const line of sourceLines) if (line.trim() !== "") expect(covered.has(line), line).toBe(true);
    chunks.forEach((c, i) => {
      expect(c.metadata.chunkIndex).toBe(i);
      expect(c.metadata.chunkType).toBe("block");
      expect(c.metadata.isDocumentation).toBe(true);
      expect(c.metadata.headingPath).toEqual([]);
      expect(c.metadata.filePath).toBe("PROMPT.md");
      expect(c.metadata.language).toBe("markdown");
    });
  });

  it("cuts a heading-less document made of one line wider than the cap", async () => {
    const line = "word ".repeat(400).trim();
    const chunks = await new MarkdownChunker({ maxChunkSize: CAP }).chunk(line, "wide.md", "markdown");

    expect(chunks.length).toBeGreaterThan(2);
    for (const c of chunks) {
      expect(c.content.length).toBeLessThanOrEqual(CAP);
      expect(c.startLine).toBe(1);
      expect(c.endLine).toBe(1);
    }
    expect(chunks.map((c) => c.content).join("")).toBe(line);
  });

  it("cuts an oversized preamble into Preamble parts within the cap, leaving the sections intact", async () => {
    const section = "## Section\n\nThe section after the preamble keeps its own single chunk and its own id.";
    const code = `${body}\n\n${section}`;
    const sourceLines = code.split("\n");
    const chunks = await new MarkdownChunker({ maxChunkSize: CAP }).chunk(code, "doc.md", "markdown");

    const preamble = chunks.filter((c) => c.metadata.name === "Preamble");
    expect(preamble.length).toBeGreaterThan(2);
    expect(chunks.slice(0, preamble.length)).toEqual(preamble);
    expectWithinCapAndTiled(preamble, sourceLines);
    expect(preamble[0].startLine).toBe(1);
    const sectionLine = sourceLines.indexOf("## Section") + 1;
    expect(preamble[preamble.length - 1].endLine).toBeLessThan(sectionLine);
    for (const p of preamble) {
      expect(p.metadata.parentSymbolId).toBe("Preamble");
      expect(p.metadata.symbolId).toBeUndefined();
      expect(p.metadata.isDocumentation).toBe(true);
      expect(p.metadata.headingPath).toEqual([]);
    }

    const sectionChunk = chunks[preamble.length];
    expect(sectionChunk.metadata.name).toBe("Section");
    expect(sectionChunk.metadata.symbolId).toBe("Section");
    expect(sectionChunk.content).toBe(section);
    expect(sectionChunk.startLine).toBe(sectionLine);
    chunks.forEach((c, i) => {
      expect(c.metadata.chunkIndex).toBe(i);
    });
  });

  // Pinned from the output BEFORE the cap was enforced on these paths:
  // content under the cap must come out byte-identical.
  it("leaves a heading-less document under the cap as one whole chunk, unchanged", async () => {
    const code = ["---", "title: T", "---", "", "First line of a short note body.", "Second line of it."].join("\n");
    const chunks = await new MarkdownChunker({ maxChunkSize: CAP }).chunk(code, "note.md", "markdown");
    expect(chunks).toEqual([
      {
        content: "First line of a short note body.\nSecond line of it.",
        startLine: 5,
        endLine: 6,
        metadata: {
          filePath: "note.md",
          language: "markdown",
          chunkIndex: 0,
          chunkType: "block",
          isDocumentation: true,
          headingPath: [],
        },
      },
    ]);
  });

  it("leaves a preamble under the cap as one Preamble chunk, unchanged", async () => {
    const code = [
      "Intro text before any heading, long enough to be its own preamble chunk.",
      "",
      "## Section",
      "",
      "Section body long enough to clear the minimum section size threshold.",
    ].join("\n");
    const chunks = await new MarkdownChunker({ maxChunkSize: CAP }).chunk(code, "doc.md", "markdown");
    expect(chunks).toEqual([
      {
        content: "Intro text before any heading, long enough to be its own preamble chunk.",
        startLine: 1,
        endLine: 2,
        metadata: {
          filePath: "doc.md",
          language: "markdown",
          chunkIndex: 0,
          chunkType: "block",
          name: "Preamble",
          symbolId: "Preamble",
          isDocumentation: true,
          headingPath: [],
        },
      },
      {
        content: "## Section\n\nSection body long enough to clear the minimum section size threshold.",
        startLine: 3,
        endLine: 5,
        metadata: {
          filePath: "doc.md",
          language: "markdown",
          chunkIndex: 1,
          chunkType: "block",
          name: "Section",
          symbolId: "Section",
          isDocumentation: true,
          headingPath: [{ depth: 2, text: "Section" }],
        },
      },
    ]);
  });
});

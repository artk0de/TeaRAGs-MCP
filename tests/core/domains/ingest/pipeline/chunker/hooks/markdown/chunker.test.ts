import { describe, expect, it } from "vitest";

import { MarkdownChunker } from "../../../../../../../../src/core/domains/ingest/pipeline/chunker/hooks/markdown/chunker.js";

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

    it("should split h3 into separate chunks with breadcrumb from parent h2", async () => {
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

      const names = chunks.map((c) => c.metadata.name);
      // h3 headings create separate chunks
      expect(names).toContain("Installation");
      expect(names).toContain("Configuration");

      // h3 chunks include breadcrumb from parent h2
      const installation = chunks.find((c) => c.metadata.name === "Installation");
      expect(installation!.content).toContain("## Getting Started");
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
      expect(codeBlock!.metadata.parentName).toBeUndefined();
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

      // h3 under h2 — breadcrumb from h2
      const sub = chunks.find((c) => c.metadata.name === "Sub of Middle");
      expect(sub).toBeDefined();
      expect(sub!.content).toContain("## Middle Section");

      // h3 under h1 (no h2) — breadcrumb from h1
      const h3UnderH1 = chunks.find((c) => c.metadata.name === "H3 Under H1");
      expect(h3UnderH1).toBeDefined();
      expect(h3UnderH1!.content).toContain("# Late H1");
      expect(h3UnderH1!.content).not.toContain("## Middle Section");
    });

    it("should include breadcrumb in every fallback sub-chunk", async () => {
      const smallChunker = new MarkdownChunker({ maxChunkSize: 200 });

      const longContent = Array(30)
        .fill("This line fills the subsection to force a character fallback split here.")
        .join("\n");

      const code = [`# Guide`, "", `## Auth`, "", `### OAuth`, "", longContent].join("\n");

      const chunks = await smallChunker.chunk(code, "doc.md", "markdown");

      const oauthChunks = chunks.filter((c) => c.metadata.name === "OAuth");
      // Oversized h3 section → multiple sub-chunks
      expect(oauthChunks.length).toBeGreaterThan(1);

      // Every sub-chunk has breadcrumb prefix
      for (const chunk of oauthChunks) {
        expect(chunk.content).toContain("# Guide > ## Auth");
      }
    });
  });
});

import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { MarkdownChunker } from "../../../../../src/core/domains/ingest/pipeline/chunker/hooks/markdown/chunker.js";
import { assignNavigationAndDocSymbolId } from "../../../../../src/core/domains/ingest/pipeline/file-processor.js";
import { StaticPayloadBuilder } from "../../../../../src/core/domains/trajectory/static/provider.js";

function makeTmpDir(): string {
  const dir = join(tmpdir(), `nav-int-${Date.now()}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

describe("navigation integration", () => {
  it("markdown chunks get doc: symbolId, navigation, and headingPath in Qdrant payload", async () => {
    const tmpDir = makeTmpDir();
    const filePath = join(tmpDir, "guide.md");
    const markdown = [
      "# Guide",
      "",
      "Introduction paragraph that is long enough to pass minimum size check for preamble content.",
      "",
      "## Installation",
      "",
      "Run npm install to get started with the project setup and configuration.",
      "",
      "## Usage",
      "",
      "Import the module and call the main function to start processing your data.",
    ].join("\n");
    writeFileSync(filePath, markdown);

    // Step 1: Chunk
    const chunker = new MarkdownChunker({ maxChunkSize: 5000 });
    const chunks = await chunker.chunk(markdown, filePath, "markdown");

    // Step 2: Post-process (doc symbolIds + navigation)
    assignNavigationAndDocSymbolId(chunks, tmpDir);

    // Verify doc symbolIds are hashes
    for (const chunk of chunks) {
      expect(chunk.metadata.symbolId).toMatch(/^doc:[a-f0-9]{12}$/);
    }

    // Verify navigation chain
    for (let i = 0; i < chunks.length; i++) {
      const nav = chunks[i].metadata.navigation!;
      if (i > 0) {
        expect(nav.prevSymbolId).toBe(chunks[i - 1].metadata.symbolId);
      } else {
        expect(nav.prevSymbolId).toBeUndefined();
      }
      if (i < chunks.length - 1) {
        expect(nav.nextSymbolId).toBe(chunks[i + 1].metadata.symbolId);
      } else {
        expect(nav.nextSymbolId).toBeUndefined();
      }
    }

    // Step 3: Build Qdrant payloads
    const builder = new StaticPayloadBuilder();
    const payloads = chunks.map((c) => builder.buildPayload(c, tmpDir));

    // Verify navigation appears in payload
    for (const payload of payloads) {
      expect(payload.navigation).toBeDefined();
    }

    // Verify headingPath appears in payload for chunks that have it
    const withHeadings = payloads.filter((p) => {
      const hp = p.headingPath as unknown[];
      return hp && hp.length > 0;
    });
    expect(withHeadings.length).toBeGreaterThan(0);
  });

  it("code chunks keep readable symbolId with navigation", () => {
    const chunks = [
      {
        content: "function init() {}",
        startLine: 1,
        endLine: 1,
        metadata: {
          filePath: "/project/src/app.ts",
          language: "typescript",
          chunkIndex: 0,
          chunkType: "function" as const,
          symbolId: "init",
        },
      },
      {
        content: "function run() {}",
        startLine: 3,
        endLine: 3,
        metadata: {
          filePath: "/project/src/app.ts",
          language: "typescript",
          chunkIndex: 1,
          chunkType: "function" as const,
          symbolId: "run",
        },
      },
    ];

    assignNavigationAndDocSymbolId(chunks, "/project");

    expect(chunks[0].metadata.symbolId).toBe("init"); // NOT hashed
    expect(chunks[1].metadata.symbolId).toBe("run");
    expect(chunks[0].metadata.navigation).toEqual({ nextSymbolId: "run" });
    expect(chunks[1].metadata.navigation).toEqual({ prevSymbolId: "init" });
  });
});

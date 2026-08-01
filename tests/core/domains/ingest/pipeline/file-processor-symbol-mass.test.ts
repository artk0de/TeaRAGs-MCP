/**
 * Seam test — the symbol-mass post-pass runs on the per-file chunk array
 * inside `processFiles`, and its fields survive the metadata whitelist that
 * FileProcessor applies before handing chunks to the pipeline.
 *
 * The pass lives at this seam (not inside one chunker) because every chunker —
 * tree-sitter, markdown, character fallback — funnels through here with the
 * file's full chunk array already carrying resolved parentSymbolIds.
 */

import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { cleanupTempDir, createTempTestDir, createTestFile } from "../__helpers__/test-helpers.js";
import { processFiles } from "../../../../../src/core/domains/ingest/pipeline/file-processor.js";
import type { CodeChunk } from "../../../../../src/core/types.js";

vi.mock("tree-sitter", () => ({
  default: class MockParser {
    setLanguage() {}
    parse() {
      return {
        rootNode: {
          type: "program",
          startPosition: { row: 0, column: 0 },
          endPosition: { row: 0, column: 0 },
          children: [],
          text: "",
          namedChildren: [],
        },
      };
    }
  },
}));
vi.mock("tree-sitter-typescript", () => ({ default: { typescript: {}, tsx: {} } }));

/** A class header chunk plus two member chunks, as a real chunker would emit. */
function classFileChunks(filePath: string): CodeChunk[] {
  return [
    {
      content: "class Alpha {",
      startLine: 1,
      endLine: 4,
      metadata: { filePath, language: "typescript", chunkIndex: 0, chunkType: "class", symbolId: "Alpha" },
    },
    {
      content: "one() {}",
      startLine: 6,
      endLine: 30,
      metadata: {
        filePath,
        language: "typescript",
        chunkIndex: 1,
        chunkType: "function",
        symbolId: "Alpha#one",
        parentSymbolId: "Alpha",
      },
    },
    {
      content: "two() {}",
      startLine: 32,
      endLine: 91,
      metadata: {
        filePath,
        language: "typescript",
        chunkIndex: 2,
        chunkType: "function",
        symbolId: "Alpha#two",
        parentSymbolId: "Alpha",
      },
    },
  ];
}

describe("processFiles — symbol-mass post-pass", () => {
  let tempDir: string;
  let codebaseDir: string;

  beforeEach(async () => {
    ({ tempDir, codebaseDir } = await createTempTestDir());
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await cleanupTempDir(tempDir);
  });

  it("hands the pipeline chunks carrying memberCount, classLines and fileSymbolCount", async () => {
    await createTestFile(codebaseDir, "alpha.ts", "class Alpha {}\n");
    const filePath = join(codebaseDir, "alpha.ts");
    const chunkerPool = {
      processFile: vi.fn(async () => ({ chunks: classFileChunks(filePath) })),
    };
    const submitted: CodeChunk[] = [];
    const chunkPipeline = {
      addChunk: vi.fn((chunk: CodeChunk) => {
        submitted.push(chunk);
        return true;
      }),
      isBackpressured: () => false,
      waitForBackpressure: async () => true,
    };

    await processFiles([filePath], codebaseDir, chunkerPool as never, chunkPipeline as never, {
      enableGitMetadata: false,
    });

    expect(submitted).toHaveLength(3);
    // Every code chunk carries the file's distinct-symbol count.
    for (const chunk of submitted) {
      expect(chunk.metadata.fileSymbolCount).toBe(3);
    }
    // Class fields land on the class chunk only, and the span reaches the last
    // member (91) rather than stopping at the header (4).
    expect(submitted[0].metadata.memberCount).toBe(2);
    expect(submitted[0].metadata.classLines).toBe(90);
    expect(submitted[1].metadata.memberCount).toBeUndefined();
    expect(submitted[1].metadata.classLines).toBeUndefined();
  });
});

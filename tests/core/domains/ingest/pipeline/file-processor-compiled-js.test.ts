/**
 * Tests for FileProcessor Layer-2 compiled-JS content skip (bead 9oq5e).
 *
 * A compiled / minified JS bundle that slips past the scanner's path-based
 * ignore (e.g. committed under src/) must NOT be parsed, chunked, or embedded.
 * The content gate fires for JS-family files only and emits exactly one
 * FILE_INGESTED skip record with skipReason "compiled".
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { cleanupTempDir, createTempTestDir, createTestFile } from "../__helpers__/test-helpers.js";
import { processFiles } from "../../../../../src/core/domains/ingest/pipeline/file-processor.js";
import {
  pipelineLog,
  type FileIngestRecord,
} from "../../../../../src/core/domains/ingest/pipeline/infra/debug-logger.js";

// Stub tree-sitter so any path that DOES reach the chunker stays inert. The
// compiled-content gate runs BEFORE chunking, so for skipped files the stub is
// never touched — the assertions prove exactly that.
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

function makeStubs(chunksPerFile: number) {
  const chunkerPool = {
    processFile: vi.fn(async (filePath: string) => ({
      chunks: Array.from({ length: chunksPerFile }, (_, idx) => ({
        content: `chunk ${idx}`,
        startLine: idx * 10 + 1,
        endLine: idx * 10 + 5,
        metadata: {
          filePath,
          language: "javascript",
          chunkIndex: idx,
          name: `s${idx}`,
          chunkType: "function",
        },
      })),
    })),
  };
  const chunkPipeline = {
    addChunk: vi.fn(() => true),
    isBackpressured: () => false,
    waitForBackpressure: async () => true,
  };
  return { chunkerPool, chunkPipeline };
}

describe("processFiles — compiled-JS content skip (9oq5e Layer 2)", () => {
  let tempDir: string;
  let codebaseDir: string;

  beforeEach(async () => {
    ({ tempDir, codebaseDir } = await createTempTestDir());
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await cleanupTempDir(tempDir);
  });

  it("skips a JS file carrying a sourcemap comment (no parse, no chunk, skipReason 'compiled')", async () => {
    await createTestFile(codebaseDir, "vendor-bundle.js", "var d3=1;\n//# sourceMappingURL=d3.js.map\n");
    const { chunkerPool, chunkPipeline } = makeStubs(2);
    const spy = vi.spyOn(pipelineLog, "fileIngested");

    const result = await processFiles(
      [`${codebaseDir}/vendor-bundle.js`],
      codebaseDir,
      chunkerPool as never,
      chunkPipeline as never,
      { enableGitMetadata: false },
    );

    expect(chunkerPool.processFile).not.toHaveBeenCalled();
    expect(chunkPipeline.addChunk).not.toHaveBeenCalled();
    expect(result.filesProcessed).toBe(0);
    expect(result.chunksCreated).toBe(0);

    const skip = spy.mock.calls.map((c) => c[1]).find((r) => r.path === "vendor-bundle.js");
    expect(skip).toBeDefined();
    expect(skip?.skipped).toBe(true);
    expect(skip?.skipReason).toBe("compiled");
    expect(skip?.chunks).toBe(0);
  });

  it("skips a minified single-line JS bundle whose longest line exceeds the threshold", async () => {
    await createTestFile(codebaseDir, "min.js", `var a=${"1+".repeat(60000)}1;`);
    const { chunkerPool, chunkPipeline } = makeStubs(1);

    const result = await processFiles(
      [`${codebaseDir}/min.js`],
      codebaseDir,
      chunkerPool as never,
      chunkPipeline as never,
      { enableGitMetadata: false },
    );

    expect(chunkerPool.processFile).not.toHaveBeenCalled();
    expect(chunkPipeline.addChunk).not.toHaveBeenCalled();
    expect(result.filesProcessed).toBe(0);
  });

  it("chunks an ordinary multi-line JS file as usual", async () => {
    await createTestFile(codebaseDir, "app.js", "export function f() {\n  return 1;\n}\n");
    const { chunkerPool, chunkPipeline } = makeStubs(1);

    const result = await processFiles(
      [`${codebaseDir}/app.js`],
      codebaseDir,
      chunkerPool as never,
      chunkPipeline as never,
      { enableGitMetadata: false },
    );

    expect(chunkerPool.processFile).toHaveBeenCalledTimes(1);
    expect(chunkPipeline.addChunk).toHaveBeenCalledTimes(1);
    expect(result.filesProcessed).toBe(1);
  });

  it("does NOT content-skip a non-JS file that happens to carry a very long line", async () => {
    // The content gate is JS-family ONLY — a Ruby file with a long line must
    // still be chunked, not mistaken for a compiled JS bundle.
    await createTestFile(codebaseDir, "data.rb", `DATA = "${"x".repeat(60000)}"\n`);
    const { chunkerPool, chunkPipeline } = makeStubs(1);

    const result = await processFiles(
      [`${codebaseDir}/data.rb`],
      codebaseDir,
      chunkerPool as never,
      chunkPipeline as never,
      { enableGitMetadata: false },
    );

    expect(chunkerPool.processFile).toHaveBeenCalledTimes(1);
    expect(result.filesProcessed).toBe(1);
  });

  it("accepts 'compiled' in the FileIngestRecord.skipReason union", () => {
    // Compile-time check: if this literal type-checks, the union includes
    // "compiled". Runtime assertion is trivial.
    const record: FileIngestRecord = {
      path: "x.js",
      language: "javascript",
      bytes: 0,
      chunks: 0,
      parseMs: 0,
      skipped: true,
      skipReason: "compiled",
    };
    expect(record.skipReason).toBe("compiled");
  });
});

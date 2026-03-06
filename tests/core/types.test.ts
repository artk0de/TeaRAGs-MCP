import { describe, expect, it } from "vitest";

import type { CodeChunk } from "../../src/core/types.js";

describe("CodeChunk.metadata.methodLines", () => {
  it("accepts optional methodLines field", () => {
    const chunk: CodeChunk = {
      content: "function foo() {}",
      startLine: 1,
      endLine: 10,
      metadata: {
        filePath: "test.ts",
        language: "typescript",
        chunkIndex: 0,
        methodLines: 50,
      },
    };
    expect(chunk.metadata.methodLines).toBe(50);
  });

  it("methodLines is optional (undefined when not set)", () => {
    const chunk: CodeChunk = {
      content: "function foo() {}",
      startLine: 1,
      endLine: 10,
      metadata: {
        filePath: "test.ts",
        language: "typescript",
        chunkIndex: 0,
      },
    };
    expect(chunk.metadata.methodLines).toBeUndefined();
  });
});

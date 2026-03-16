import { describe, expect, it } from "vitest";

import type { IndexMetrics } from "../../../../src/core/api/public/dto/metrics.js";

describe("IndexMetrics DTO", () => {
  it("should have correct shape", () => {
    const metrics: IndexMetrics = {
      collection: "code_abc123",
      totalChunks: 1709,
      totalFiles: 314,
      distributions: {
        totalFiles: 314,
        language: { typescript: 1200 },
        chunkType: { function: 800 },
        documentation: { docs: 150, code: 1559 },
        topAuthors: [{ name: "Alice", chunks: 1400 }],
        othersCount: 309,
      },
      signals: {
        "git.file.commitCount": {
          min: 1,
          max: 47,
          count: 1709,
          labelMap: { low: 2, typical: 5, high: 12, extreme: 30 },
        },
      },
    };
    expect(metrics.collection).toBe("code_abc123");
    expect(metrics.signals["git.file.commitCount"].labelMap.high).toBe(12);
  });

  it("should allow optional mean", () => {
    const metrics: IndexMetrics = {
      collection: "test",
      totalChunks: 0,
      totalFiles: 0,
      distributions: {
        totalFiles: 0,
        language: {},
        chunkType: {},
        documentation: { docs: 0, code: 0 },
        topAuthors: [],
        othersCount: 0,
      },
      signals: {
        "test.signal": {
          min: 0,
          max: 0,
          mean: 5.2,
          count: 0,
          labelMap: {},
        },
      },
    };
    expect(metrics.signals["test.signal"].mean).toBe(5.2);
  });
});

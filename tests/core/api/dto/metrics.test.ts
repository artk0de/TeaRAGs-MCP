import { describe, expect, it } from "vitest";

import type { IndexMetrics } from "../../../../src/core/api/public/dto/metrics.js";

describe("IndexMetrics DTO", () => {
  it("should have correct shape with global signals", () => {
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
        global: {
          "git.file.commitCount": {
            min: 1,
            max: 47,
            count: 1709,
            labelMap: { low: 2, typical: 5, high: 12, extreme: 30 },
          },
        },
      },
    };
    expect(metrics.collection).toBe("code_abc123");
    expect(metrics.signals["global"]["git.file.commitCount"].labelMap.high).toBe(12);
  });

  it("should support per-language signal entries", () => {
    const metrics: IndexMetrics = {
      collection: "code_abc123",
      totalChunks: 100,
      totalFiles: 10,
      distributions: {
        totalFiles: 10,
        language: { typescript: 80, ruby: 20 },
        chunkType: { function: 60 },
        documentation: { docs: 5, code: 95 },
        topAuthors: [],
        othersCount: 0,
      },
      signals: {
        global: {
          "git.file.commitCount": {
            min: 1,
            max: 47,
            count: 100,
            labelMap: { low: 2, typical: 5, high: 12, extreme: 30 },
          },
        },
        typescript: {
          "git.file.commitCount": {
            min: 1,
            max: 40,
            count: 80,
            labelMap: { low: 3, typical: 6, high: 14, extreme: 28 },
          },
        },
      },
    };
    expect(metrics.signals["typescript"]["git.file.commitCount"].count).toBe(80);
    expect(metrics.signals["typescript"]["git.file.commitCount"].labelMap.low).toBe(3);
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
        global: {
          "test.signal": {
            min: 0,
            max: 0,
            mean: 5.2,
            count: 0,
            labelMap: {},
          },
        },
      },
    };
    expect(metrics.signals["global"]["test.signal"].mean).toBe(5.2);
  });
});

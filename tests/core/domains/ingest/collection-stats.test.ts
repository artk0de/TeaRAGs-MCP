import { describe, expect, it } from "vitest";

import type { PayloadSignalDescriptor } from "../../../../src/core/contracts/types/trajectory.js";
import { computeCollectionStats } from "../../../../src/core/domains/ingest/collection-stats.js";

const testSignals: PayloadSignalDescriptor[] = [
  {
    key: "git.file.commitCount",
    type: "number",
    description: "test",
    stats: { labels: { p25: "low", p50: "typical", p75: "high", p95: "extreme" } },
  },
];

function makePoints(values: number[]) {
  return values.map((v, i) => ({
    payload: {
      "git.file.commitCount": v,
      language: i % 2 === 0 ? "typescript" : "python",
      chunkType: "function",
      isDocumentation: i === 0,
      relativePath: `file${i % 3}.ts`,
      "git.file.dominantAuthor": i % 2 === 0 ? "Alice" : "Bob",
    },
  }));
}

describe("computeCollectionStats distributions", () => {
  it("should compute min and max from actual values", () => {
    const points = makePoints([3, 1, 7, 2, 10]);
    const result = computeCollectionStats(points, testSignals);
    const stats = result.perSignal.get("git.file.commitCount")!;
    expect(stats.min).toBe(1);
    expect(stats.max).toBe(10);
  });

  it("should compute distributions.language", () => {
    const points = makePoints([1, 2, 3, 4]);
    const result = computeCollectionStats(points, testSignals);
    expect(result.distributions.language).toEqual({ typescript: 2, python: 2 });
  });

  it("should compute distributions.chunkType", () => {
    const points = makePoints([1, 2]);
    const result = computeCollectionStats(points, testSignals);
    expect(result.distributions.chunkType).toEqual({ function: 2 });
  });

  it("should compute distributions.documentation", () => {
    const points = makePoints([1, 2, 3]);
    const result = computeCollectionStats(points, testSignals);
    expect(result.distributions.documentation).toEqual({ docs: 1, code: 2 });
  });

  it("should compute distributions.totalFiles from distinct relativePath", () => {
    const points = makePoints([1, 2, 3, 4, 5, 6]);
    const result = computeCollectionStats(points, testSignals);
    // relativePath cycles: file0, file1, file2, file0, file1, file2
    expect(result.distributions.totalFiles).toBe(3);
  });

  it("should compute distributions.topAuthors", () => {
    const points = makePoints([1, 2, 3, 4]);
    const result = computeCollectionStats(points, testSignals);
    expect(result.distributions.topAuthors).toEqual([
      { name: "Alice", chunks: 2 },
      { name: "Bob", chunks: 2 },
    ]);
    expect(result.distributions.othersCount).toBe(0);
  });

  it("should limit topAuthors to 10 and count others", () => {
    const points = Array.from({ length: 22 }, (_, i) => ({
      payload: {
        "git.file.commitCount": i + 1,
        language: "typescript",
        chunkType: "function",
        isDocumentation: false,
        relativePath: `file${i}.ts`,
        "git.file.dominantAuthor": `Author${i}`,
      },
    }));
    const result = computeCollectionStats(points, testSignals);
    expect(result.distributions.topAuthors).toHaveLength(10);
    expect(result.distributions.othersCount).toBe(12);
  });
});

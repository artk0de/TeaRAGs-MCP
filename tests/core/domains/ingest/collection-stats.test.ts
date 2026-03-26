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

const signalsWithChunkFilter: PayloadSignalDescriptor[] = [
  ...testSignals,
  {
    key: "methodLines",
    type: "number",
    description: "Original method/block line count",
    stats: { labels: { p50: "small", p75: "large", p95: "decomposition_candidate" }, chunkTypeFilter: "function" },
  },
  {
    key: "methodDensity",
    type: "number",
    description: "Code density",
    stats: { labels: { p50: "sparse", p95: "dense" }, chunkTypeFilter: "function" },
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

  describe("chunkTypeFilter", () => {
    it("should compute methodLines stats only from function chunks", () => {
      const points = [
        {
          payload: {
            "git.file.commitCount": 5,
            methodLines: 100,
            methodDensity: 50,
            chunkType: "class",
            language: "typescript",
            isDocumentation: false,
            relativePath: "a.ts",
          },
        },
        {
          payload: {
            "git.file.commitCount": 3,
            methodLines: 20,
            methodDensity: 30,
            chunkType: "function",
            language: "typescript",
            isDocumentation: false,
            relativePath: "a.ts",
          },
        },
        {
          payload: {
            "git.file.commitCount": 7,
            methodLines: 40,
            methodDensity: 60,
            chunkType: "function",
            language: "typescript",
            isDocumentation: false,
            relativePath: "b.ts",
          },
        },
        {
          payload: {
            "git.file.commitCount": 2,
            methodLines: 200,
            methodDensity: 80,
            chunkType: "block",
            language: "typescript",
            isDocumentation: false,
            relativePath: "b.ts",
          },
        },
      ];
      const result = computeCollectionStats(points, signalsWithChunkFilter);

      // methodLines: only function chunks → [20, 40]
      const mlStats = result.perSignal.get("methodLines")!;
      expect(mlStats.count).toBe(2);
      expect(mlStats.min).toBe(20);
      expect(mlStats.max).toBe(40);

      // methodDensity: only function chunks → [30, 60]
      const mdStats = result.perSignal.get("methodDensity")!;
      expect(mdStats.count).toBe(2);
      expect(mdStats.min).toBe(30);
      expect(mdStats.max).toBe(60);

      // commitCount: no filter → all 4 points
      const ccStats = result.perSignal.get("git.file.commitCount")!;
      expect(ccStats.count).toBe(4);
    });
  });

  describe("enrichment time range", () => {
    it("should compute file-level time range from git.file timestamps", () => {
      const now = 1700000000;
      const day = 86400;
      const points = [
        {
          payload: {
            "git.file.commitCount": 1,
            "git.file.lastModifiedAt": now - 2 * day,
            "git.file.firstCreatedAt": now - 30 * day,
            language: "typescript",
            chunkType: "function",
            isDocumentation: false,
            relativePath: "a.ts",
          },
        },
        {
          payload: {
            "git.file.commitCount": 2,
            "git.file.lastModifiedAt": now - 1 * day,
            "git.file.firstCreatedAt": now - 60 * day,
            language: "typescript",
            chunkType: "function",
            isDocumentation: false,
            relativePath: "b.ts",
          },
        },
      ];
      const result = computeCollectionStats(points, testSignals);

      expect(result.distributions.enrichmentTimeRange).toBeDefined();
      expect(result.distributions.enrichmentTimeRange!.file.oldest).toBe(now - 60 * day);
      expect(result.distributions.enrichmentTimeRange!.file.newest).toBe(now - 1 * day);
      expect(result.distributions.enrichmentTimeRange!.filesWithGitData).toBe(2);
    });

    it("should compute chunk-level time range from git.chunk.lastModifiedAt", () => {
      const now = 1700000000;
      const day = 86400;
      const points = [
        {
          payload: {
            "git.file.commitCount": 1,
            "git.file.lastModifiedAt": now - 2 * day,
            "git.file.firstCreatedAt": now - 30 * day,
            "git.chunk.lastModifiedAt": now - 5 * day,
            language: "typescript",
            chunkType: "function",
            isDocumentation: false,
            relativePath: "a.ts",
          },
        },
        {
          payload: {
            "git.file.commitCount": 2,
            "git.file.lastModifiedAt": now - 1 * day,
            "git.file.firstCreatedAt": now - 60 * day,
            "git.chunk.lastModifiedAt": now - 3 * day,
            language: "typescript",
            chunkType: "function",
            isDocumentation: false,
            relativePath: "b.ts",
          },
        },
      ];
      const result = computeCollectionStats(points, testSignals);

      expect(result.distributions.enrichmentTimeRange!.chunk).toBeDefined();
      expect(result.distributions.enrichmentTimeRange!.chunk!.oldest).toBe(now - 5 * day);
      expect(result.distributions.enrichmentTimeRange!.chunk!.newest).toBe(now - 3 * day);
    });

    it("should omit chunk range when no chunk timestamps present", () => {
      const now = 1700000000;
      const day = 86400;
      const points = [
        {
          payload: {
            "git.file.commitCount": 1,
            "git.file.lastModifiedAt": now - 2 * day,
            "git.file.firstCreatedAt": now - 30 * day,
            language: "typescript",
            chunkType: "function",
            isDocumentation: false,
            relativePath: "a.ts",
          },
        },
      ];
      const result = computeCollectionStats(points, testSignals);

      expect(result.distributions.enrichmentTimeRange).toBeDefined();
      expect(result.distributions.enrichmentTimeRange!.chunk).toBeUndefined();
    });

    it("should include configTimePeriodMonths when gitTimePeriods provided", () => {
      const now = 1700000000;
      const day = 86400;
      const points = [
        {
          payload: {
            "git.file.commitCount": 1,
            "git.file.lastModifiedAt": now - 2 * day,
            "git.file.firstCreatedAt": now - 30 * day,
            "git.chunk.lastModifiedAt": now - 5 * day,
            language: "typescript",
            chunkType: "function",
            isDocumentation: false,
            relativePath: "a.ts",
          },
        },
      ];
      const result = computeCollectionStats(points, testSignals, { fileMonths: 12, chunkMonths: 6 });

      expect(result.distributions.enrichmentTimeRange!.file.configTimePeriodMonths).toBe(12);
      expect(result.distributions.enrichmentTimeRange!.chunk!.configTimePeriodMonths).toBe(6);
    });

    it("should omit configTimePeriodMonths when gitTimePeriods not provided", () => {
      const now = 1700000000;
      const day = 86400;
      const points = [
        {
          payload: {
            "git.file.commitCount": 1,
            "git.file.lastModifiedAt": now - 2 * day,
            "git.file.firstCreatedAt": now - 30 * day,
            language: "typescript",
            chunkType: "function",
            isDocumentation: false,
            relativePath: "a.ts",
          },
        },
      ];
      const result = computeCollectionStats(points, testSignals);

      expect(result.distributions.enrichmentTimeRange!.file.configTimePeriodMonths).toBeUndefined();
    });

    it("should return undefined enrichmentTimeRange when no git timestamps", () => {
      const points = makePoints([1, 2, 3]);
      const result = computeCollectionStats(points, testSignals);
      expect(result.distributions.enrichmentTimeRange).toBeUndefined();
    });
  });

  describe("per-language stats", () => {
    it("should compute per-language signal stats grouped by chunk language", () => {
      const points = [
        ...Array.from({ length: 10 }, (_, i) => ({
          payload: {
            "git.file.commitCount": i + 1,
            language: "typescript",
            chunkType: "function",
            isDocumentation: false,
            relativePath: `ts${i}.ts`,
          },
        })),
        ...Array.from({ length: 10 }, (_, i) => ({
          payload: {
            "git.file.commitCount": i + 11,
            language: "python",
            chunkType: "function",
            isDocumentation: false,
            relativePath: `py${i}.py`,
          },
        })),
      ];
      const result = computeCollectionStats(points, testSignals);

      expect(result.perLanguage.has("typescript")).toBe(true);
      expect(result.perLanguage.has("python")).toBe(true);

      const tsStats = result.perLanguage.get("typescript")!.get("git.file.commitCount")!;
      expect(tsStats.count).toBe(10);
      expect(tsStats.min).toBe(1);
      expect(tsStats.max).toBe(10);

      const pyStats = result.perLanguage.get("python")!.get("git.file.commitCount")!;
      expect(pyStats.count).toBe(10);
      expect(pyStats.min).toBe(11);
      expect(pyStats.max).toBe(20);
    });

    it("should exclude languages with fewer than 10 chunks", () => {
      const points = [
        ...Array.from({ length: 15 }, (_, i) => ({
          payload: {
            "git.file.commitCount": i + 1,
            language: "typescript",
            chunkType: "function",
            isDocumentation: false,
            relativePath: `ts${i}.ts`,
          },
        })),
        ...Array.from({ length: 5 }, (_, i) => ({
          payload: {
            "git.file.commitCount": i + 1,
            language: "python",
            chunkType: "function",
            isDocumentation: false,
            relativePath: `py${i}.py`,
          },
        })),
      ];
      const result = computeCollectionStats(points, testSignals);

      expect(result.perLanguage.has("typescript")).toBe(true);
      expect(result.perLanguage.has("python")).toBe(false);
    });

    it("should exclude non-code and low-share languages from per-language stats", () => {
      const points = [
        ...Array.from({ length: 50 }, (_, i) => ({
          payload: {
            "git.file.commitCount": i + 1,
            language: "typescript",
            chunkType: "function",
            isDocumentation: false,
            relativePath: `ts${i}.ts`,
          },
        })),
        // json: not in CODE_LANGUAGES → excluded
        ...Array.from({ length: 30 }, (_, i) => ({
          payload: {
            "git.file.commitCount": i + 1,
            language: "json",
            chunkType: "block",
            isDocumentation: false,
            relativePath: `cfg${i}.json`,
          },
        })),
        // markdown: isDocumentation → not in CODE_LANGUAGES → excluded
        ...Array.from({ length: 20 }, (_, i) => ({
          payload: {
            "git.file.commitCount": i + 1,
            language: "markdown",
            chunkType: "block",
            isDocumentation: true,
            relativePath: `doc${i}.md`,
          },
        })),
      ];
      const result = computeCollectionStats(points, testSignals);

      expect(result.perLanguage.has("typescript")).toBe(true);
      expect(result.perLanguage.has("json")).toBe(false);
      expect(result.perLanguage.has("markdown")).toBe(false);
    });

    it("should exclude code language below 5% share", () => {
      // 480 typescript + 20 bash = 500 total, bash = 20/500 = 4% < 5%
      const points = [
        ...Array.from({ length: 480 }, (_, i) => ({
          payload: {
            "git.file.commitCount": (i % 50) + 1,
            language: "typescript",
            chunkType: "function",
            isDocumentation: false,
            relativePath: `ts${i}.ts`,
          },
        })),
        ...Array.from({ length: 20 }, (_, i) => ({
          payload: {
            "git.file.commitCount": i + 1,
            language: "bash",
            chunkType: "function",
            isDocumentation: false,
            relativePath: `script${i}.sh`,
          },
        })),
      ];
      const result = computeCollectionStats(points, testSignals);
      expect(result.perLanguage.has("typescript")).toBe(true);
      expect(result.perLanguage.has("bash")).toBe(false);
    });

    it("should include code language at 10% share (above 5%)", () => {
      // 90 typescript + 10 bash = 100 total, bash = 10%
      const points = [
        ...Array.from({ length: 90 }, (_, i) => ({
          payload: {
            "git.file.commitCount": i + 1,
            language: "typescript",
            chunkType: "function",
            isDocumentation: false,
            relativePath: `ts${i}.ts`,
          },
        })),
        ...Array.from({ length: 10 }, (_, i) => ({
          payload: {
            "git.file.commitCount": i + 1,
            language: "bash",
            chunkType: "function",
            isDocumentation: false,
            relativePath: `script${i}.sh`,
          },
        })),
      ];
      const result = computeCollectionStats(points, testSignals);
      expect(result.perLanguage.has("typescript")).toBe(true);
      expect(result.perLanguage.has("bash")).toBe(true);
    });

    it("should exclude config languages from global perSignal stats", () => {
      const points = [
        ...Array.from({ length: 10 }, (_, i) => ({
          payload: {
            "git.file.commitCount": i + 1,
            language: "typescript",
            chunkType: "function",
            isDocumentation: false,
            relativePath: `ts${i}.ts`,
          },
        })),
        // markdown (config) — should NOT contribute to global
        ...Array.from({ length: 10 }, (_, i) => ({
          payload: {
            "git.file.commitCount": 100 + i,
            language: "markdown",
            chunkType: "block",
            isDocumentation: true,
            relativePath: `doc${i}.md`,
          },
        })),
      ];
      const result = computeCollectionStats(points, testSignals);

      // Global should only contain typescript values (10), not markdown
      const globalStats = result.perSignal.get("git.file.commitCount")!;
      expect(globalStats.count).toBe(10);
      expect(globalStats.max).toBe(10); // not 109 from markdown
    });

    it("should not include chunks without language in global perSignal stats", () => {
      const points = [
        ...Array.from({ length: 10 }, (_, i) => ({
          payload: {
            "git.file.commitCount": i + 1,
            language: "typescript",
            chunkType: "function",
            isDocumentation: false,
            relativePath: `ts${i}.ts`,
          },
        })),
        // No language field — should NOT contribute to global
        ...Array.from({ length: 5 }, (_, i) => ({
          payload: {
            "git.file.commitCount": i + 20,
            chunkType: "block",
            isDocumentation: false,
            relativePath: `unknown${i}.txt`,
          },
        })),
      ];
      const result = computeCollectionStats(points, testSignals);

      // Global should only have typescript (10), not the 5 language-less
      const globalStats = result.perSignal.get("git.file.commitCount")!;
      expect(globalStats.count).toBe(10);

      // Per-language: only typescript
      expect(result.perLanguage.size).toBe(1);
      expect(result.perLanguage.has("typescript")).toBe(true);
    });

    it("should respect chunkTypeFilter in per-language stats", () => {
      const points = [
        ...Array.from({ length: 10 }, (_, i) => ({
          payload: {
            "git.file.commitCount": i + 1,
            methodLines: (i + 1) * 10,
            methodDensity: (i + 1) * 5,
            language: "typescript",
            chunkType: "function",
            isDocumentation: false,
            relativePath: `fn${i}.ts`,
          },
        })),
        ...Array.from({ length: 10 }, (_, i) => ({
          payload: {
            "git.file.commitCount": i + 1,
            methodLines: (i + 1) * 100,
            methodDensity: (i + 1) * 50,
            language: "typescript",
            chunkType: "class",
            isDocumentation: false,
            relativePath: `cls${i}.ts`,
          },
        })),
      ];
      const result = computeCollectionStats(points, signalsWithChunkFilter);

      const tsStats = result.perLanguage.get("typescript")!;

      // methodLines has chunkTypeFilter: "function" — only function chunks
      const mlStats = tsStats.get("methodLines")!;
      expect(mlStats.count).toBe(10);
      expect(mlStats.min).toBe(10);
      expect(mlStats.max).toBe(100);

      // commitCount has no filter — all 20 chunks
      const ccStats = tsStats.get("git.file.commitCount")!;
      expect(ccStats.count).toBe(20);
    });
  });
});

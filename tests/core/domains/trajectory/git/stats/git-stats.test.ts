import { describe, expect, it } from "vitest";

import {
  STATS_ACCUMULATOR_KEYS,
  type PointContext,
  type StatsPoint,
} from "../../../../../../src/core/contracts/types/stats-accumulator.js";
import {
  AuthorCountsAccumulator,
  ChunkTimeRangeAccumulator,
  FileTimeRangeAccumulator,
  GitDataPathsAccumulator,
  gitStatsAccumulators,
} from "../../../../../../src/core/domains/trajectory/git/stats/index.js";

function ctx(overrides: Partial<PointContext> = {}): PointContext {
  return {
    pointChunkType: "function",
    lang: "typescript",
    isCodeLanguage: true,
    relPath: "src/a.ts",
    scope: "source",
    ...overrides,
  };
}

function point(payload: Record<string, unknown>): StatsPoint {
  return { payload };
}

describe("AuthorCountsAccumulator", () => {
  it("counts per dominant author (flat payload)", () => {
    const acc = new AuthorCountsAccumulator();
    acc.accept(point({ "git.file.dominantAuthor": "Alice" }), ctx());
    acc.accept(point({ "git.file.dominantAuthor": "Alice" }), ctx());
    acc.accept(point({ "git.file.dominantAuthor": "Bob" }), ctx());
    const result = acc.result();
    expect(result.get("Alice")).toBe(2);
    expect(result.get("Bob")).toBe(1);
  });

  it("reads nested dot-notation payload too", () => {
    const acc = new AuthorCountsAccumulator();
    acc.accept(point({ git: { file: { dominantAuthor: "Charlie" } } }), ctx());
    expect(acc.result().get("Charlie")).toBe(1);
  });

  it("skips points without author", () => {
    const acc = new AuthorCountsAccumulator();
    acc.accept(point({}), ctx());
    expect(acc.result().size).toBe(0);
  });
});

describe("FileTimeRangeAccumulator", () => {
  it("tracks min firstCreatedAt and max lastModifiedAt", () => {
    const acc = new FileTimeRangeAccumulator();
    acc.accept(point({ "git.file.firstCreatedAt": 100, "git.file.lastModifiedAt": 200 }), ctx());
    acc.accept(point({ "git.file.firstCreatedAt": 50, "git.file.lastModifiedAt": 300 }), ctx());
    acc.accept(point({ "git.file.firstCreatedAt": 150, "git.file.lastModifiedAt": 250 }), ctx());
    expect(acc.result()).toEqual({ fileOldest: 50, fileNewest: 300 });
  });

  it("returns undefined for both when no git data present", () => {
    const acc = new FileTimeRangeAccumulator();
    acc.accept(point({}), ctx());
    expect(acc.result()).toEqual({ fileOldest: undefined, fileNewest: undefined });
  });

  it("ignores non-positive timestamps", () => {
    const acc = new FileTimeRangeAccumulator();
    acc.accept(point({ "git.file.firstCreatedAt": 0, "git.file.lastModifiedAt": -1 }), ctx());
    expect(acc.result()).toEqual({ fileOldest: undefined, fileNewest: undefined });
  });
});

describe("ChunkTimeRangeAccumulator", () => {
  it("tracks chunk timestamp min+max", () => {
    const acc = new ChunkTimeRangeAccumulator();
    acc.accept(point({ "git.chunk.lastModifiedAt": 100 }), ctx());
    acc.accept(point({ "git.chunk.lastModifiedAt": 500 }), ctx());
    acc.accept(point({ "git.chunk.lastModifiedAt": 250 }), ctx());
    expect(acc.result()).toEqual({ chunkOldest: 100, chunkNewest: 500 });
  });

  it("returns undefined for chunks without git timestamp", () => {
    const acc = new ChunkTimeRangeAccumulator();
    acc.accept(point({}), ctx());
    expect(acc.result()).toEqual({ chunkOldest: undefined, chunkNewest: undefined });
  });
});

describe("GitDataPathsAccumulator", () => {
  it("collects relPaths only when git.file.firstCreatedAt present", () => {
    const acc = new GitDataPathsAccumulator();
    acc.accept(point({ "git.file.firstCreatedAt": 100 }), ctx({ relPath: "a.ts" }));
    acc.accept(point({ "git.file.firstCreatedAt": 100 }), ctx({ relPath: "a.ts" }));
    acc.accept(point({ "git.file.firstCreatedAt": 200 }), ctx({ relPath: "b.ts" }));
    acc.accept(point({}), ctx({ relPath: "c.ts" })); // no git → skipped
    expect(acc.result().size).toBe(2);
    expect(acc.result().has("a.ts")).toBe(true);
    expect(acc.result().has("b.ts")).toBe(true);
    expect(acc.result().has("c.ts")).toBe(false);
  });

  it("skips empty relPath even if git data present", () => {
    const acc = new GitDataPathsAccumulator();
    acc.accept(point({ "git.file.firstCreatedAt": 100 }), ctx({ relPath: "" }));
    expect(acc.result().size).toBe(0);
  });
});

describe("gitStatsAccumulators barrel", () => {
  it("exports four descriptors with well-known keys", () => {
    expect(gitStatsAccumulators).toHaveLength(4);
    const keys = gitStatsAccumulators.map((d) => d.key);
    expect(keys).toEqual([
      STATS_ACCUMULATOR_KEYS.AUTHOR_COUNTS,
      STATS_ACCUMULATOR_KEYS.FILE_TIME_RANGE,
      STATS_ACCUMULATOR_KEYS.CHUNK_TIME_RANGE,
      STATS_ACCUMULATOR_KEYS.GIT_DATA_PATHS,
    ]);
  });

  it("each factory produces a fresh instance", () => {
    const descriptor = gitStatsAccumulators[0];
    if (!descriptor) throw new Error("gitStatsAccumulators is unexpectedly empty");
    const a = descriptor.factory();
    const b = descriptor.factory();
    a.accept(point({ "git.file.dominantAuthor": "Alice" }), ctx());
    const aResult = a.result() as Map<string, number>;
    const bResult = b.result() as Map<string, number>;
    expect(aResult.get("Alice")).toBe(1);
    expect(bResult.size).toBe(0);
  });
});

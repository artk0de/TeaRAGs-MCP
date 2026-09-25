import { describe, expect, it } from "vitest";

import {
  DEFAULT_CODEGRAPH_COMPACTION_POLICY,
  shouldCompactCodegraphStorage,
} from "../../../../src/core/adapters/duckdb/storage-compaction.js";

const MiB = 1024 * 1024;

// bd tea-rags-mcp-dvzdm — compaction rewrites the whole file (3.8 s on taxdome's
// 1.2 GB graph), so it runs only once the file is big enough to matter AND most
// of what it stores is dead row versions.
describe("shouldCompactCodegraphStorage", () => {
  it("compacts a large file whose stored row versions are at least twice its live rows", () => {
    expect(shouldCompactCodegraphStorage({ fileBytes: 1200 * MiB, liveRows: 700_000, storedRows: 13_000_000 })).toBe(
      true,
    );
    expect(shouldCompactCodegraphStorage({ fileBytes: 128 * MiB, liveRows: 1000, storedRows: 2000 })).toBe(true);
  });

  it("leaves a file alone while live rows are still the majority", () => {
    expect(shouldCompactCodegraphStorage({ fileBytes: 1200 * MiB, liveRows: 1000, storedRows: 1999 })).toBe(false);
  });

  it("never compacts a small project's file, however much of it is dead", () => {
    expect(
      shouldCompactCodegraphStorage({
        fileBytes: DEFAULT_CODEGRAPH_COMPACTION_POLICY.minFileBytes - 1,
        liveRows: 10,
        storedRows: 10_000,
      }),
    ).toBe(false);
  });

  it("compacts a large file that holds no live rows at all", () => {
    expect(shouldCompactCodegraphStorage({ fileBytes: 512 * MiB, liveRows: 0, storedRows: 5 })).toBe(true);
    expect(shouldCompactCodegraphStorage({ fileBytes: 512 * MiB, liveRows: 0, storedRows: 0 })).toBe(false);
  });

  it("honours an explicit policy", () => {
    const policy = { minFileBytes: 0, minStoredToLiveRatio: 1.5 };
    expect(shouldCompactCodegraphStorage({ fileBytes: 1, liveRows: 10, storedRows: 15 }, policy)).toBe(true);
    expect(shouldCompactCodegraphStorage({ fileBytes: 1, liveRows: 10, storedRows: 14 }, policy)).toBe(false);
  });
});

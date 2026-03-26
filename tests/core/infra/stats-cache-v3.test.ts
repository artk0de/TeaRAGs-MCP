import { writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { CollectionSignalStats } from "../../../src/core/contracts/types/trajectory.js";
import { StatsCache } from "../../../src/core/infra/stats-cache.js";

describe("StatsCache v3", () => {
  let cache: StatsCache;
  let tempDir: string;

  const testStats: CollectionSignalStats = {
    perSignal: new Map([
      [
        "git.file.commitCount",
        {
          count: 100,
          min: 1,
          max: 50,
          percentiles: { 25: 3, 50: 8, 75: 15, 95: 42 },
        },
      ],
    ]),
    perLanguage: new Map(),
    distributions: {
      totalFiles: 10,
      language: { typescript: 80, python: 20 },
      chunkType: { function: 60, block: 40 },
      documentation: { docs: 15, code: 85 },
      topAuthors: [{ name: "Alice", chunks: 60 }],
      othersCount: 40,
    },
    computedAt: Date.now(),
  };

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "stats-cache-"));
    cache = new StatsCache(tempDir);
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it("should save and load v3 with distributions", () => {
    cache.save("test_coll", testStats);
    const loaded = cache.load("test_coll");
    expect(loaded).not.toBeNull();
    expect(loaded!.distributions.totalFiles).toBe(10);
    expect(loaded!.distributions.language).toEqual({ typescript: 80, python: 20 });
    expect(loaded!.perSignal.get("git.file.commitCount")!.min).toBe(1);
    expect(loaded!.perSignal.get("git.file.commitCount")!.max).toBe(50);
  });

  it("should reject v2 cache files", () => {
    const filePath = join(tempDir, "old_coll.stats.json");
    writeFileSync(
      filePath,
      JSON.stringify({
        version: 2,
        collectionName: "old_coll",
        computedAt: Date.now(),
        perSignal: {},
      }),
    );
    const loaded = cache.load("old_coll");
    expect(loaded).toBeNull();
  });

  it("should round-trip min/max correctly", () => {
    cache.save("test_coll", testStats);
    const loaded = cache.load("test_coll");
    const signal = loaded!.perSignal.get("git.file.commitCount")!;
    expect(signal.min).toBe(1);
    expect(signal.max).toBe(50);
    expect(signal.count).toBe(100);
  });
});

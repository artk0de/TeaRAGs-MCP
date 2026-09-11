import { randomBytes } from "node:crypto";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { CollectionSignalStats } from "../../../src/core/contracts/types/trajectory.js";
import { StatsCache } from "../../../src/core/infra/stats-cache.js";

function makeTmpDir(): string {
  const suffix = randomBytes(6).toString("hex");
  const dir = join(tmpdir(), `schema-drift-test-${suffix}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

const SAMPLE_STATS: CollectionSignalStats = {
  computedAt: 1_700_000_000_000,
  perSignal: new Map([["git.file.commitCount", { count: 100, min: 1, max: 50, percentiles: { 95: 90 } }]]),
  perLanguage: new Map(),
  distributions: {
    totalFiles: 0,
    language: {},
    chunkType: {},
    documentation: { docs: 0, code: 0 },
    topAuthors: [],
    topBlameAuthors: [],
    othersCount: 0,
  },
};

describe("StatsCache payloadFieldKeys", () => {
  let snapshotsDir: string;
  let cache: StatsCache;

  beforeEach(() => {
    snapshotsDir = makeTmpDir();
    cache = new StatsCache(snapshotsDir);
  });

  afterEach(() => {
    rmSync(snapshotsDir, { recursive: true, force: true });
  });

  it("save() stores payloadFieldKeys and load() returns them", () => {
    const keys = ["git.file.commitCount", "git.file.ageDays", "git.chunk.churnRatio"];
    cache.save("test-col", SAMPLE_STATS, keys);

    const loaded = cache.load("test-col");
    expect(loaded).not.toBeNull();
    expect(loaded!.payloadFieldKeys).toEqual(keys);
  });

  it("save() without payloadFieldKeys stores undefined", () => {
    cache.save("test-col", SAMPLE_STATS);

    const loaded = cache.load("test-col");
    expect(loaded).not.toBeNull();
    expect(loaded!.payloadFieldKeys).toBeUndefined();
  });

  it("load() returns null for v3 cache files (version mismatch)", () => {
    // v3 files are rejected after v4 bump
    const filePath = join(snapshotsDir, "legacy-col.stats.json");
    writeFileSync(
      filePath,
      JSON.stringify({
        version: 3,
        collectionName: "legacy-col",
        computedAt: 1_700_000_000_000,
        perSignal: { "git.file.commitCount": { count: 10, min: 1, max: 50, percentiles: { 95: 42 } } },
        distributions: {
          totalFiles: 0,
          language: {},
          chunkType: {},
          documentation: { docs: 0, code: 0 },
          topAuthors: [],
          topBlameAuthors: [],
          othersCount: 0,
        },
      }),
      "utf-8",
    );

    const loaded = cache.load("legacy-col");
    expect(loaded).toBeNull();
  });
});

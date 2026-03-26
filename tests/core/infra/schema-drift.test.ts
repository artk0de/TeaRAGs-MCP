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
          othersCount: 0,
        },
      }),
      "utf-8",
    );

    const loaded = cache.load("legacy-col");
    expect(loaded).toBeNull();
  });
});

describe("Schema drift detection", () => {
  let snapshotsDir: string;
  let cache: StatsCache;

  beforeEach(() => {
    snapshotsDir = makeTmpDir();
    cache = new StatsCache(snapshotsDir);
  });

  afterEach(() => {
    rmSync(snapshotsDir, { recursive: true, force: true });
  });

  it("checkSchemaDrift returns null when no cached keys", () => {
    cache.save("col", SAMPLE_STATS); // no keys
    const loaded = cache.load("col");
    const drift = StatsCache.checkSchemaDrift(loaded?.payloadFieldKeys, ["git.file.commitCount"]);
    expect(drift).toBeNull();
  });

  it("checkSchemaDrift returns null when keys match exactly", () => {
    const keys = ["git.file.ageDays", "git.file.commitCount"];
    cache.save("col", SAMPLE_STATS, keys);
    const loaded = cache.load("col");
    const drift = StatsCache.checkSchemaDrift(loaded?.payloadFieldKeys, keys);
    expect(drift).toBeNull();
  });

  it("checkSchemaDrift detects new fields", () => {
    const cachedKeys = ["git.file.commitCount"];
    const currentKeys = ["git.file.commitCount", "git.file.ageDays"];
    const drift = StatsCache.checkSchemaDrift(cachedKeys, currentKeys);
    expect(drift).not.toBeNull();
    expect(drift!.added).toEqual(["git.file.ageDays"]);
    expect(drift!.removed).toEqual([]);
  });

  it("checkSchemaDrift detects removed fields", () => {
    const cachedKeys = ["git.file.ageDays", "git.file.commitCount"];
    const currentKeys = ["git.file.commitCount"];
    const drift = StatsCache.checkSchemaDrift(cachedKeys, currentKeys);
    expect(drift).not.toBeNull();
    expect(drift!.added).toEqual([]);
    expect(drift!.removed).toEqual(["git.file.ageDays"]);
  });

  it("checkSchemaDrift detects both added and removed fields", () => {
    const cachedKeys = ["git.file.ageDays", "git.file.commitCount"];
    const currentKeys = ["git.chunk.churnRatio", "git.file.commitCount"];
    const drift = StatsCache.checkSchemaDrift(cachedKeys, currentKeys);
    expect(drift).not.toBeNull();
    expect(drift!.added).toEqual(["git.chunk.churnRatio"]);
    expect(drift!.removed).toEqual(["git.file.ageDays"]);
  });

  it("formatSchemaDriftWarning produces readable warning", () => {
    const drift = { added: ["git.chunk.taskIds", "git.chunk.changeDensity"], removed: [] };
    const warning = StatsCache.formatSchemaDriftWarning(drift);
    expect(warning).toContain("git.chunk.taskIds");
    expect(warning).toContain("git.chunk.changeDensity");
    expect(warning).toContain("reindex");
  });
});

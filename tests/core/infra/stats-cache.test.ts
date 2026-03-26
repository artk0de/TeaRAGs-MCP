import { randomBytes } from "node:crypto";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { CollectionSignalStats, Distributions } from "../../../src/core/contracts/types/trajectory.js";
import { StatsCache } from "../../../src/core/infra/stats-cache.js";

function makeTmpDir(): string {
  const suffix = randomBytes(6).toString("hex");
  const dir = join(tmpdir(), `stats-cache-test-${suffix}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

const emptyDistributions: Distributions = { totalFiles: 0, language: {}, chunkType: {} };

function makeStats(overrides?: Partial<CollectionSignalStats>): CollectionSignalStats {
  return {
    computedAt: Date.now(),
    perSignal: new Map(),
    perLanguage: new Map(),
    distributions: emptyDistributions,
    ...overrides,
  };
}

describe("StatsCache", () => {
  let snapshotsDir: string;
  let cache: StatsCache;

  beforeEach(() => {
    snapshotsDir = makeTmpDir();
    cache = new StatsCache(snapshotsDir);
  });

  afterEach(() => {
    rmSync(snapshotsDir, { recursive: true, force: true });
  });

  it("load() returns null for missing file", () => {
    const result = cache.load("nonexistent-collection");
    expect(result).toBeNull();
  });

  it("save() writes valid JSON and load() reads it back (round-trip)", () => {
    const stats = makeStats({
      computedAt: 1_700_000_000_000,
      perSignal: new Map([
        ["git.file.commitCount", { count: 100, percentiles: { 25: 10, 95: 90 }, mean: 50, stddev: 28.87 }],
        ["git.file.ageDays", { count: 80, mean: 120 }],
      ]),
    });

    cache.save("my-collection", stats);
    const loaded = cache.load("my-collection");

    expect(loaded).not.toBeNull();
    expect(loaded!.computedAt).toBe(1_700_000_000_000);
    expect(loaded!.perSignal).toBeInstanceOf(Map);
    expect(loaded!.perSignal.size).toBe(2);

    const commitStats = loaded!.perSignal.get("git.file.commitCount");
    expect(commitStats).toBeDefined();
    expect(commitStats!.count).toBe(100);
    expect(commitStats!.mean).toBe(50);
    expect(commitStats!.stddev).toBeCloseTo(28.87, 2);
    expect(commitStats!.percentiles).toEqual({ 25: 10, 95: 90 });

    const ageStats = loaded!.perSignal.get("git.file.ageDays");
    expect(ageStats).toBeDefined();
    expect(ageStats!.count).toBe(80);
    expect(ageStats!.mean).toBe(120);
  });

  it("load() returns null for corrupt JSON", () => {
    const filePath = join(snapshotsDir, "bad-collection.stats.json");
    writeFileSync(filePath, "{ not valid json }", "utf-8");

    const result = cache.load("bad-collection");
    expect(result).toBeNull();
  });

  it("load() returns null for wrong version", () => {
    const filePath = join(snapshotsDir, "old-collection.stats.json");
    const content = JSON.stringify({
      version: 99,
      collectionName: "old-collection",
      computedAt: 1_700_000_000_000,
      perSignal: {},
      perLanguage: {},
      distributions: emptyDistributions,
    });
    writeFileSync(filePath, content, "utf-8");

    const result = cache.load("old-collection");
    expect(result).toBeNull();
  });

  it("invalidate() deletes the file and load() returns null after", () => {
    const stats = makeStats({
      perSignal: new Map([["git.file.commitCount", { count: 5 }]]),
    });

    cache.save("delete-me", stats);
    // File exists and is loadable
    expect(cache.load("delete-me")).not.toBeNull();

    cache.invalidate("delete-me");
    // File should be gone
    expect(cache.load("delete-me")).toBeNull();
  });

  it("invalidate() does not throw when file does not exist", () => {
    expect(() => {
      cache.invalidate("never-existed");
    }).not.toThrow();
  });

  it("save() creates the directory if it doesn't exist", () => {
    const nestedDir = join(snapshotsDir, "deep", "nested", "snapshots");
    const nestedCache = new StatsCache(nestedDir);

    const stats = makeStats({
      perSignal: new Map([["signal.x", { count: 1 }]]),
    });

    expect(() => {
      nestedCache.save("test-col", stats);
    }).not.toThrow();
    const loaded = nestedCache.load("test-col");
    expect(loaded).not.toBeNull();
    expect(loaded!.perSignal.size).toBe(1);
  });

  it("save() persists payloadFieldKeys and load() returns them", () => {
    const stats = makeStats({
      perSignal: new Map([["a", { count: 1 }]]),
    });
    cache.save("key-test", stats, ["git.file.ageDays", "git.file.commitCount"]);
    const loaded = cache.load("key-test");
    expect(loaded!.payloadFieldKeys).toEqual(["git.file.ageDays", "git.file.commitCount"]);
  });

  describe("checkSchemaDrift", () => {
    it("returns null when no cached keys", () => {
      expect(StatsCache.checkSchemaDrift(undefined, ["a"])).toBeNull();
    });

    it("returns null when no drift", () => {
      expect(StatsCache.checkSchemaDrift(["a", "b"], ["a", "b"])).toBeNull();
    });

    it("detects added fields", () => {
      const drift = StatsCache.checkSchemaDrift(["a"], ["a", "b"]);
      expect(drift).toEqual({ added: ["b"], removed: [] });
    });

    it("detects removed fields", () => {
      const drift = StatsCache.checkSchemaDrift(["a", "b"], ["a"]);
      expect(drift).toEqual({ added: [], removed: ["b"] });
    });

    it("detects both added and removed", () => {
      const drift = StatsCache.checkSchemaDrift(["a", "b"], ["b", "c"]);
      expect(drift).toEqual({ added: ["c"], removed: ["a"] });
    });
  });

  describe("formatSchemaDriftWarning", () => {
    it("formats added fields", () => {
      const msg = StatsCache.formatSchemaDriftWarning({ added: ["x"], removed: [] });
      expect(msg).toContain("New fields: x");
      expect(msg).not.toContain("Removed fields");
    });

    it("formats removed fields", () => {
      const msg = StatsCache.formatSchemaDriftWarning({ added: [], removed: ["y"] });
      expect(msg).toContain("Removed fields: y");
      expect(msg).not.toContain("New fields");
    });

    it("formats both added and removed", () => {
      const msg = StatsCache.formatSchemaDriftWarning({ added: ["x"], removed: ["y"] });
      expect(msg).toContain("New fields: x");
      expect(msg).toContain("Removed fields: y");
      expect(msg).toContain("forceReindex=true");
    });
  });

  it("round-trip preserves Map→Record→Map conversion correctly", () => {
    const perSignal = new Map([
      ["alpha", { count: 10, percentiles: { 50: 5.0, 95: 9.5 } }],
      ["beta", { count: 20, mean: 7.7 }],
      ["gamma", { count: 30, stddev: 3.14 }],
    ]);
    const stats = makeStats({ computedAt: 42, perSignal });

    cache.save("map-test", stats);
    const loaded = cache.load("map-test");

    expect(loaded).not.toBeNull();
    expect(loaded!.perSignal).toBeInstanceOf(Map);
    // All original keys present
    expect([...loaded!.perSignal.keys()].sort()).toEqual(["alpha", "beta", "gamma"]);
    // Values intact
    expect(loaded!.perSignal.get("alpha")!.percentiles[50]).toBe(5.0);
    expect(loaded!.perSignal.get("beta")!.mean).toBe(7.7);
    expect(loaded!.perSignal.get("gamma")!.stddev).toBe(3.14);
  });

  describe("perLanguage (v5 — scoped stats)", () => {
    it("should round-trip ScopedSignalStats through save/load", () => {
      const tsSignals = new Map([
        [
          "git.file.commitCount",
          {
            source: { count: 50, min: 1, max: 30, mean: 12, percentiles: { 25: 3, 95: 30 } },
            test: { count: 20, min: 1, max: 80, mean: 25, percentiles: { 25: 5, 95: 60 } },
          },
        ],
        ["git.file.ageDays", { source: { count: 50, min: 1, max: 365, mean: 90, percentiles: { 50: 60 } } }],
      ]);
      const rubySignals = new Map([
        ["git.file.commitCount", { source: { count: 20, min: 1, max: 15, mean: 8, percentiles: { 50: 7 } } }],
      ]);

      const stats = makeStats({
        computedAt: 1_700_000_000_000,
        perSignal: new Map([["git.file.commitCount", { count: 70, min: 1, max: 80, mean: 10, percentiles: {} }]]),
        perLanguage: new Map([
          ["typescript", tsSignals],
          ["ruby", rubySignals],
        ]),
      });

      cache.save("lang-test", stats);
      const loaded = cache.load("lang-test");

      expect(loaded).not.toBeNull();
      expect(loaded!.perLanguage).toBeInstanceOf(Map);
      expect(loaded!.perLanguage.size).toBe(2);

      const loadedTs = loaded!.perLanguage.get("typescript");
      expect(loadedTs).toBeInstanceOf(Map);
      expect(loadedTs!.size).toBe(2);
      expect(loadedTs!.get("git.file.commitCount")!.source.mean).toBe(12);
      expect(loadedTs!.get("git.file.commitCount")!.test?.mean).toBe(25);
      expect(loadedTs!.get("git.file.ageDays")!.source.mean).toBe(90);
      expect(loadedTs!.get("git.file.ageDays")!.test).toBeUndefined();

      const loadedRuby = loaded!.perLanguage.get("ruby");
      expect(loadedRuby).toBeInstanceOf(Map);
      expect(loadedRuby!.get("git.file.commitCount")!.source.mean).toBe(8);
    });

    it("should migrate v4 cache to ScopedSignalStats (source only, test undefined)", () => {
      const filePath = join(snapshotsDir, "v4-collection.stats.json");
      const v4Content = JSON.stringify({
        version: 4,
        collectionName: "v4-collection",
        computedAt: 1_700_000_000_000,
        perSignal: { "git.file.commitCount": { count: 70, min: 1, max: 80, mean: 10, percentiles: {} } },
        perLanguage: {
          typescript: { "git.file.commitCount": { count: 50, min: 1, max: 30, mean: 12, percentiles: { 25: 3 } } },
        },
        distributions: emptyDistributions,
      });
      writeFileSync(filePath, v4Content, "utf-8");

      const loaded = cache.load("v4-collection");
      expect(loaded).not.toBeNull();

      const tsStats = loaded!.perLanguage.get("typescript")!.get("git.file.commitCount")!;
      expect(tsStats.source.mean).toBe(12);
      expect(tsStats.source.percentiles[25]).toBe(3);
      expect(tsStats.test).toBeUndefined();
    });

    it("should discard v3 cache and return null", () => {
      const filePath = join(snapshotsDir, "v3-collection.stats.json");
      const v3Content = JSON.stringify({
        version: 3,
        collectionName: "v3-collection",
        computedAt: 1_700_000_000_000,
        perSignal: { "git.file.commitCount": { count: 10, mean: 5 } },
        distributions: emptyDistributions,
      });
      writeFileSync(filePath, v3Content, "utf-8");

      const result = cache.load("v3-collection");
      expect(result).toBeNull();
    });

    it("should handle empty perLanguage", () => {
      const stats = makeStats({
        perSignal: new Map([["git.file.commitCount", { count: 10 }]]),
        perLanguage: new Map(),
      });

      cache.save("empty-lang", stats);
      const loaded = cache.load("empty-lang");

      expect(loaded).not.toBeNull();
      expect(loaded!.perLanguage).toBeInstanceOf(Map);
      expect(loaded!.perLanguage.size).toBe(0);
    });
  });
});

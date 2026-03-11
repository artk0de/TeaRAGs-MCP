import { randomBytes } from "node:crypto";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { CollectionSignalStats } from "../../../src/core/contracts/types/trajectory.js";
import { StatsCache } from "../../../src/core/infra/stats-cache.js";

function makeTmpDir(): string {
  const suffix = randomBytes(6).toString("hex");
  const dir = join(tmpdir(), `stats-cache-test-${suffix}`);
  mkdirSync(dir, { recursive: true });
  return dir;
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
    const stats: CollectionSignalStats = {
      computedAt: 1_700_000_000_000,
      perSignal: new Map([
        ["git.file.commitCount", { count: 100, percentiles: { 25: 10, 95: 90 }, mean: 50, stddev: 28.87 }],
        ["git.file.ageDays", { count: 80, mean: 120 }],
      ]),
    };

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
    });
    writeFileSync(filePath, content, "utf-8");

    const result = cache.load("old-collection");
    expect(result).toBeNull();
  });

  it("invalidate() deletes the file and load() returns null after", () => {
    const stats: CollectionSignalStats = {
      computedAt: Date.now(),
      perSignal: new Map([["git.file.commitCount", { count: 5 }]]),
    };

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

    const stats: CollectionSignalStats = {
      computedAt: Date.now(),
      perSignal: new Map([["signal.x", { count: 1 }]]),
    };

    expect(() => {
      nestedCache.save("test-col", stats);
    }).not.toThrow();
    const loaded = nestedCache.load("test-col");
    expect(loaded).not.toBeNull();
    expect(loaded!.perSignal.size).toBe(1);
  });

  it("round-trip preserves Map→Record→Map conversion correctly", () => {
    const perSignal = new Map([
      ["alpha", { count: 10, percentiles: { 50: 5.0, 95: 9.5 } }],
      ["beta", { count: 20, mean: 7.7 }],
      ["gamma", { count: 30, stddev: 3.14 }],
    ]);
    const stats: CollectionSignalStats = { computedAt: 42, perSignal };

    cache.save("map-test", stats);
    const loaded = cache.load("map-test");

    expect(loaded).not.toBeNull();
    expect(loaded!.perSignal).toBeInstanceOf(Map);
    // All original keys present
    expect([...loaded!.perSignal.keys()].sort()).toEqual(["alpha", "beta", "gamma"]);
    // Values intact
    expect(loaded!.perSignal.get("alpha")!.percentiles![50]).toBe(5.0);
    expect(loaded!.perSignal.get("beta")!.mean).toBe(7.7);
    expect(loaded!.perSignal.get("gamma")!.stddev).toBe(3.14);
  });
});

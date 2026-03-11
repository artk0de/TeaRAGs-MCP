import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { CollectionSignalStats } from "../../../src/core/contracts/types/trajectory.js";
import { Reranker } from "../../../src/core/explore/reranker.js";
import { StatsCache } from "../../../src/core/infra/stats-cache.js";

describe("Reranker.hasCollectionStats", () => {
  const reranker = new Reranker([], [], []);

  it("returns false when no stats set", () => {
    expect(reranker.hasCollectionStats).toBe(false);
  });

  it("returns true after setCollectionStats", () => {
    const stats: CollectionSignalStats = {
      perSignal: new Map([["git.file.commitCount", { count: 100, percentiles: { 25: 5 } }]]),
      computedAt: Date.now(),
    };
    reranker.setCollectionStats(stats);
    expect(reranker.hasCollectionStats).toBe(true);
  });

  it("returns false after invalidateStats", () => {
    reranker.invalidateStats();
    expect(reranker.hasCollectionStats).toBe(false);
  });
});

describe("Stats lifecycle — cold start", () => {
  let cacheDir: string;
  let statsCache: StatsCache;

  beforeEach(() => {
    cacheDir = join(tmpdir(), `stats-lifecycle-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(cacheDir, { recursive: true });
    statsCache = new StatsCache(cacheDir);
  });

  afterEach(() => {
    rmSync(cacheDir, { recursive: true, force: true });
  });

  it("loads cached stats into reranker when cache exists", () => {
    const reranker = new Reranker([], [], []);
    const stats: CollectionSignalStats = {
      perSignal: new Map([["git.file.commitCount", { count: 50, percentiles: { 25: 3, 95: 42 } }]]),
      computedAt: Date.now(),
    };

    // Save to cache
    statsCache.save("test_collection", stats);

    // Simulate cold start: reranker has no stats
    expect(reranker.hasCollectionStats).toBe(false);

    // Load from cache (what ExploreFacade will do)
    const loaded = statsCache.load("test_collection");
    if (loaded) reranker.setCollectionStats(loaded);

    expect(reranker.hasCollectionStats).toBe(true);
  });

  it("proceeds without stats when no cache exists", () => {
    const reranker = new Reranker([], [], []);

    const loaded = statsCache.load("nonexistent_collection");
    expect(loaded).toBeNull();
    expect(reranker.hasCollectionStats).toBe(false);
  });
});

describe("Stats lifecycle — post-index refresh", () => {
  let cacheDir: string;
  let statsCache: StatsCache;

  beforeEach(() => {
    cacheDir = join(tmpdir(), `stats-lifecycle-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(cacheDir, { recursive: true });
    statsCache = new StatsCache(cacheDir);
  });

  afterEach(() => {
    rmSync(cacheDir, { recursive: true, force: true });
  });

  it("invalidates reranker stats so next search reloads from cache", () => {
    const reranker = new Reranker([], [], []);
    const oldStats: CollectionSignalStats = {
      perSignal: new Map([["git.file.commitCount", { count: 50, percentiles: { 25: 3 } }]]),
      computedAt: 1000,
    };
    reranker.setCollectionStats(oldStats);
    expect(reranker.hasCollectionStats).toBe(true);

    // Simulate post-index: save new stats + invalidate
    const newStats: CollectionSignalStats = {
      perSignal: new Map([["git.file.commitCount", { count: 200, percentiles: { 25: 8, 95: 55 } }]]),
      computedAt: Date.now(),
    };
    statsCache.save("test_collection", newStats);
    reranker.invalidateStats();

    expect(reranker.hasCollectionStats).toBe(false);

    // Next search loads fresh cache
    const loaded = statsCache.load("test_collection");
    if (loaded) reranker.setCollectionStats(loaded);

    expect(reranker.hasCollectionStats).toBe(true);
    // New stats should have higher count
    expect(loaded!.perSignal.get("git.file.commitCount")!.count).toBe(200);
  });
});

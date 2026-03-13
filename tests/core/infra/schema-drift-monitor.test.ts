import { randomBytes } from "node:crypto";
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { CollectionSignalStats } from "../../../src/core/contracts/types/trajectory.js";
import { SchemaDriftMonitor } from "../../../src/core/infra/schema-drift-monitor.js";
import { StatsCache } from "../../../src/core/infra/stats-cache.js";

function makeTmpDir(): string {
  const suffix = randomBytes(6).toString("hex");
  const dir = join(tmpdir(), `drift-monitor-test-${suffix}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

const SAMPLE_STATS: CollectionSignalStats = {
  computedAt: 1_700_000_000_000,
  perSignal: new Map([["git.file.commitCount", { count: 100 }]]),
};

describe("SchemaDriftMonitor", () => {
  let snapshotsDir: string;
  let cache: StatsCache;

  beforeEach(() => {
    snapshotsDir = makeTmpDir();
    cache = new StatsCache(snapshotsDir);
  });

  afterEach(() => {
    rmSync(snapshotsDir, { recursive: true, force: true });
  });

  it("returns null when no cached keys exist", () => {
    cache.save("code_abc123", SAMPLE_STATS); // no keys
    const monitor = new SchemaDriftMonitor(cache, ["git.file.commitCount"]);
    const warning = monitor.checkByCollectionName("code_abc123");
    expect(warning).toBeNull();
  });

  it("returns null when keys match", () => {
    const keys = ["git.file.ageDays", "git.file.commitCount"];
    cache.save("code_abc123", SAMPLE_STATS, keys);
    const monitor = new SchemaDriftMonitor(cache, keys);
    const warning = monitor.checkByCollectionName("code_abc123");
    expect(warning).toBeNull();
  });

  it("returns warning when drift detected", () => {
    const cachedKeys = ["git.file.commitCount"];
    const currentKeys = ["git.file.commitCount", "git.file.ageDays"];
    cache.save("code_abc123", SAMPLE_STATS, cachedKeys);
    const monitor = new SchemaDriftMonitor(cache, currentKeys);
    const warning = monitor.checkByCollectionName("code_abc123");
    expect(warning).not.toBeNull();
    expect(warning).toContain("git.file.ageDays");
    expect(warning).toContain("reindex");
  });

  it("returns warning only once (once per session)", () => {
    const cachedKeys = ["git.file.commitCount"];
    const currentKeys = ["git.file.commitCount", "git.file.ageDays"];
    cache.save("code_abc123", SAMPLE_STATS, cachedKeys);
    const monitor = new SchemaDriftMonitor(cache, currentKeys);

    const first = monitor.checkByCollectionName("code_abc123");
    expect(first).not.toBeNull();

    // Second call returns null
    const second = monitor.checkByCollectionName("code_abc123");
    expect(second).toBeNull();

    // Even for a different collection
    cache.save("code_def456", SAMPLE_STATS, cachedKeys);
    const third = monitor.checkByCollectionName("code_def456");
    expect(third).toBeNull();
  });

  it("returns null for unknown collection", () => {
    const monitor = new SchemaDriftMonitor(cache, ["git.file.commitCount"]);
    const warning = monitor.checkByCollectionName("nonexistent");
    expect(warning).toBeNull();
  });

  it("returns null for already-checked collection (sync)", () => {
    cache.save("code_abc123", SAMPLE_STATS);
    const monitor = new SchemaDriftMonitor(cache, ["git.file.commitCount"]);
    // First check — no drift (no cached keys)
    monitor.checkByCollectionName("code_abc123");
    // Second check — same collection, should return null immediately
    const second = monitor.checkByCollectionName("code_abc123");
    expect(second).toBeNull();
  });

  describe("checkAndConsume (async)", () => {
    it("returns null when already warned", async () => {
      const cachedKeys = ["git.file.commitCount"];
      const currentKeys = ["git.file.commitCount", "git.file.ageDays"];
      cache.save("code_abc123", SAMPLE_STATS, cachedKeys);
      const monitor = new SchemaDriftMonitor(cache, currentKeys);

      // Trigger warning via sync method first
      monitor.checkByCollectionName("code_abc123");
      // Async method should return null (already warned)
      const result = await monitor.checkAndConsume("/tmp/test-project");
      expect(result).toBeNull();
    });

    it("returns warning on drift via async path", async () => {
      const cachedKeys = ["git.file.commitCount"];
      const currentKeys = ["git.file.commitCount", "git.file.ageDays"];
      // Save under the collection name that resolveCollectionName would produce
      const { resolveCollectionName, validatePath } = await import("../../../src/core/infra/collection-name.js");
      const absPath = await validatePath("/tmp/test-project");
      const collName = resolveCollectionName(absPath);
      cache.save(collName, SAMPLE_STATS, cachedKeys);

      const monitor = new SchemaDriftMonitor(cache, currentKeys);
      const warning = await monitor.checkAndConsume("/tmp/test-project");
      expect(warning).not.toBeNull();
      expect(warning).toContain("git.file.ageDays");
    });

    it("returns null on invalid path (swallows error)", async () => {
      const monitor = new SchemaDriftMonitor(cache, ["git.file.commitCount"]);
      const result = await monitor.checkAndConsume("");
      expect(result).toBeNull();
    });
  });

  describe("detectDrift (static)", () => {
    it("delegates to StatsCache.checkSchemaDrift", () => {
      const drift = SchemaDriftMonitor.detectDrift(["a"], ["a", "b"]);
      expect(drift).toEqual({ added: ["b"], removed: [] });
    });

    it("returns null for undefined cached keys", () => {
      expect(SchemaDriftMonitor.detectDrift(undefined, ["a"])).toBeNull();
    });
  });
});

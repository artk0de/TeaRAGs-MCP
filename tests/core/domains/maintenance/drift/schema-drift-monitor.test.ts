import { randomBytes } from "node:crypto";
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { CollectionSignalStats, PayloadKeyOwner } from "../../../../../src/core/contracts/types/trajectory.js";
import { SchemaDriftMonitor } from "../../../../../src/core/domains/maintenance/drift/schema-drift-monitor.js";
import { StatsCache } from "../../../../../src/core/infra/stats-cache.js";

function makeTmpDir(): string {
  const suffix = randomBytes(6).toString("hex");
  const dir = join(tmpdir(), `drift-monitor-test-${suffix}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

const SAMPLE_STATS: CollectionSignalStats = {
  computedAt: 1_700_000_000_000,
  perSignal: new Map([["git.file.commitCount", { count: 100 }]]),
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
    expect(warning).toContain("Run: tea-rags index-codebase --force");
  });

  it("returns null for unknown collection", () => {
    const monitor = new SchemaDriftMonitor(cache, ["git.file.commitCount"]);
    const warning = monitor.checkByCollectionName("nonexistent");
    expect(warning).toBeNull();
  });

  describe("checkAndConsume (async)", () => {
    it("returns warning on drift via async path", async () => {
      const cachedKeys = ["git.file.commitCount"];
      const currentKeys = ["git.file.commitCount", "git.file.ageDays"];
      // Save under the collection name that resolveCollectionName would produce
      const { resolveCollectionName, validatePath } = await import("../../../../../src/core/infra/collection-name.js");
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

    it("returns null when async drift check finds no drift (keys match)", async () => {
      const { resolveCollectionName, validatePath } = await import("../../../../../src/core/infra/collection-name.js");
      const absPath = await validatePath("/tmp/test-project-nodrift");
      const collName = resolveCollectionName(absPath);
      const keys = ["git.file.commitCount", "git.file.ageDays"];
      cache.save(collName, SAMPLE_STATS, keys);

      const monitor = new SchemaDriftMonitor(cache, keys);
      // Keys match exactly — drift is null, hits line 36
      const result = await monitor.checkAndConsume("/tmp/test-project-nodrift");
      expect(result).toBeNull();
    });
  });

  describe("detectDrift (static)", () => {
    it("delegates to checkSchemaDrift", () => {
      const drift = SchemaDriftMonitor.detectDrift(["a"], ["a", "b"]);
      expect(drift).toEqual({ added: ["b"], removed: [] });
    });

    it("returns null for undefined cached keys", () => {
      expect(SchemaDriftMonitor.detectDrift(undefined, ["a"])).toBeNull();
    });
  });

  describe("trajectory-attributed hints", () => {
    const OWNERS: PayloadKeyOwner[] = [
      { key: "git.file.commitCount", trajectory: "git", recomputable: true },
      { key: "git.file.ageDays", trajectory: "git", recomputable: true },
      { key: "navigation", recomputable: false },
    ];

    it("recommends an enrichment recompute when the drift is enrichment-owned", () => {
      cache.save("code_abc123", SAMPLE_STATS, ["git.file.commitCount"]);
      const monitor = new SchemaDriftMonitor(cache, ["git.file.commitCount", "git.file.ageDays"], OWNERS);

      const warning = monitor.checkByCollectionName("code_abc123");

      expect(warning).toContain("--force-enrichments git");
    });

    it("escalates to a full reindex when a chunker-owned key drifts", () => {
      cache.save("code_abc123", SAMPLE_STATS, ["git.file.commitCount"]);
      const monitor = new SchemaDriftMonitor(cache, ["git.file.commitCount", "navigation"], OWNERS);

      const warning = monitor.checkByCollectionName("code_abc123");

      expect(warning).toContain("--force");
      expect(warning).not.toContain("--force-enrichments");
    });
  });
});

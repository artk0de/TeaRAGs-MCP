import { randomBytes } from "node:crypto";
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { StatsCache } from "../../../../../src/core/adapters/filesystem/stats-cache.js";
import type { CollectionSignalStats, PayloadKeyOwner } from "../../../../../src/core/contracts/types/trajectory.js";
import {
  formatIndexDriftReport,
  IndexDriftReporter,
} from "../../../../../src/core/domains/maintenance/drift/report.js";
import { SchemaDriftMonitor } from "../../../../../src/core/domains/maintenance/drift/schema-drift-monitor.js";

/**
 * What a reader of a search response sees for this one axis: the monitor's
 * findings rendered by the reporter that owns rendering. The cases below assert
 * on that text, so they run the monitor through a one-axis reporter rather than
 * through a per-monitor convenience method.
 */
function renderWarning(monitor: SchemaDriftMonitor, collectionName: string): string | null {
  const report = new IndexDriftReporter([monitor]).checkByCollectionName(collectionName);
  return report && formatIndexDriftReport(report);
}

function makeTmpDir(): string {
  const suffix = randomBytes(6).toString("hex");
  const dir = join(tmpdir(), `drift-monitor-test-${suffix}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

const SAMPLE_STATS: CollectionSignalStats = {
  computedAt: 1_700_000_000_000,
  perSignal: new Map([["git.file.commitCount", { count: 100, min: 0, max: 0, percentiles: {} }]]),
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
    const warning = renderWarning(monitor, "code_abc123");
    expect(warning).toBeNull();
  });

  it("returns null when keys match", () => {
    const keys = ["git.file.ageDays", "git.file.commitCount"];
    cache.save("code_abc123", SAMPLE_STATS, keys);
    const monitor = new SchemaDriftMonitor(cache, keys);
    const warning = renderWarning(monitor, "code_abc123");
    expect(warning).toBeNull();
  });

  it("returns warning when drift detected", () => {
    const cachedKeys = ["git.file.commitCount"];
    const currentKeys = ["git.file.commitCount", "git.file.ageDays"];
    cache.save("code_abc123", SAMPLE_STATS, cachedKeys);
    const monitor = new SchemaDriftMonitor(cache, currentKeys);
    const warning = renderWarning(monitor, "code_abc123");
    expect(warning).not.toBeNull();
    expect(warning).toContain("git.file.ageDays");
    expect(warning).toContain("Run: tea-rags index-codebase --force");
  });

  it("returns null for unknown collection", () => {
    const monitor = new SchemaDriftMonitor(cache, ["git.file.commitCount"]);
    const warning = renderWarning(monitor, "nonexistent");
    expect(warning).toBeNull();
  });

  // Re-pointed from the retired formatSchemaDriftWarning: added and removed
  // keys are rendered by the report now, and each side keeps its own cost.
  it("names every added key and asks for the full reindex when nothing attributes them", () => {
    cache.save("code_abc123", SAMPLE_STATS, ["git.file.commitCount"]);
    const monitor = new SchemaDriftMonitor(cache, [
      "git.file.commitCount",
      "git.chunk.taskIds",
      "git.chunk.changeDensity",
    ]);

    const warning = renderWarning(monitor, "code_abc123");

    expect(warning).toContain("git.chunk.taskIds: absent → declared");
    expect(warning).toContain("git.chunk.changeDensity: absent → declared");
    expect(warning).not.toContain("→ absent");
    expect(warning).toContain("Run: tea-rags index-codebase --force");
  });

  it("names a removed key and asks for no action — nothing reads it any more", () => {
    cache.save("code_abc123", SAMPLE_STATS, ["git.file.commitCount", "git.file.retiredSignal"]);
    const monitor = new SchemaDriftMonitor(cache, ["git.file.commitCount"]);

    const warning = renderWarning(monitor, "code_abc123");

    expect(warning).toContain("git.file.retiredSignal: recorded → absent");
    expect(warning).not.toContain("--force");
    expect(warning).toMatch(/no action|no reindex/i);
  });

  it("names added and removed keys in one report", () => {
    cache.save("code_abc123", SAMPLE_STATS, ["git.file.retiredSignal"]);
    const monitor = new SchemaDriftMonitor(cache, ["git.file.ageDays"]);

    const warning = renderWarning(monitor, "code_abc123");

    expect(warning).toContain("git.file.ageDays: absent → declared");
    expect(warning).toContain("git.file.retiredSignal: recorded → absent");
    expect(warning).toContain("Run: tea-rags index-codebase --force");
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

      const warning = renderWarning(monitor, "code_abc123");

      expect(warning).toContain("--force-enrichments git");
    });

    it("escalates to a full reindex when a chunker-owned key drifts", () => {
      cache.save("code_abc123", SAMPLE_STATS, ["git.file.commitCount"]);
      const monitor = new SchemaDriftMonitor(cache, ["git.file.commitCount", "navigation"], OWNERS);

      const warning = renderWarning(monitor, "code_abc123");

      expect(warning).toContain("--force");
      expect(warning).not.toContain("--force-enrichments");
    });
  });

  describe("trajectory families a collection runs without", () => {
    const OWNERS: PayloadKeyOwner[] = [
      { key: "git.file.commitCount", trajectory: "git", recomputable: true },
      { key: "codegraph.file.fanIn", trajectory: "codegraph.symbols", recomputable: true },
      { key: "codegraph.temporal.coChangeCount", trajectory: "codegraph.temporal", recomputable: true },
    ];
    const CURRENT = OWNERS.map((o) => o.key);

    it("claims no drift for keys of a family the collection's own env turns off", () => {
      cache.save("code_off", SAMPLE_STATS, ["git.file.commitCount"]);
      const monitor = new SchemaDriftMonitor(cache, CURRENT, OWNERS, (name) =>
        name === "code_off" ? ["codegraph"] : [],
      );

      expect(monitor.check("code_off")).toEqual([]);
    });

    it("still reports the family's keys for a collection that runs with it", () => {
      cache.save("code_on", SAMPLE_STATS, ["git.file.commitCount"]);
      const monitor = new SchemaDriftMonitor(cache, CURRENT, OWNERS, (name) =>
        name === "code_off" ? ["codegraph"] : [],
      );

      expect(monitor.check("code_on").map((f) => f.subject)).toEqual([
        "codegraph.file.fanIn",
        "codegraph.temporal.coChangeCount",
      ]);
    });
  });
});

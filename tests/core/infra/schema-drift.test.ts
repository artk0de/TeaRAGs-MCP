import { randomBytes } from "node:crypto";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { CollectionSignalStats, PayloadKeyOwner } from "../../../src/core/contracts/types/trajectory.js";
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

  it("detects drift when navigation key is missing from cached index", () => {
    const cachedKeys = ["git.file.ageDays", "git.file.commitCount"];
    const currentKeys = ["git.file.ageDays", "git.file.commitCount", "navigation"];

    const drift = StatsCache.checkSchemaDrift(cachedKeys, currentKeys);

    expect(drift).not.toBeNull();
    expect(drift!.added).toContain("navigation");
  });

  it("formats drift warning mentioning navigation requires reindex", () => {
    const drift = { added: ["navigation"], removed: [] };

    const warning = StatsCache.formatSchemaDriftWarning(drift);

    expect(warning).toContain("navigation");
    expect(warning).toContain("reindex");
  });
});

describe("Schema drift hint — trajectory attribution", () => {
  const OWNERS: PayloadKeyOwner[] = [
    { key: "git.file.commitCount", trajectory: "git", recomputable: true },
    { key: "git.file.newSignal", trajectory: "git", recomputable: true },
    { key: "codegraph.file.fanIn", trajectory: "codegraph.symbols", recomputable: true },
    { key: "codegraph.file.newMetric", trajectory: "codegraph.symbols", recomputable: true },
    { key: "chunkSize", trajectory: "static", recomputable: false },
    { key: "navigation", recomputable: false },
  ];

  it("names the owning trajectory for a single enrichment-owned key", () => {
    const drift = { added: ["git.file.newSignal"], removed: [] };

    const warning = StatsCache.formatSchemaDriftWarning(drift, OWNERS);

    expect(warning).toContain("--force-enrichments git");
    expect(warning).not.toContain("--force ");
  });

  it("lists every affected trajectory when several enrichment providers drift", () => {
    const drift = { added: ["git.file.newSignal", "codegraph.file.newMetric"], removed: [] };

    const warning = StatsCache.formatSchemaDriftWarning(drift, OWNERS);

    expect(warning).toContain("--force-enrichments");
    expect(warning).toContain("git");
    expect(warning).toContain("codegraph.symbols");
  });

  it("escalates to a full reindex when any drifted key is not enrichment-owned", () => {
    const drift = { added: ["git.file.newSignal", "navigation"], removed: [] };

    const warning = StatsCache.formatSchemaDriftWarning(drift, OWNERS);

    // A full reindex repopulates the enrichment layer too, so the hint must
    // carry ONE command — never two competing ones.
    expect(warning).toContain("--force");
    expect(warning).not.toContain("--force-enrichments");
  });

  it("escalates for a chunker-written key that belongs to a non-enriching trajectory", () => {
    const drift = { added: ["chunkSize"], removed: [] };

    const warning = StatsCache.formatSchemaDriftWarning(drift, OWNERS);

    expect(warning).toContain("--force");
    expect(warning).not.toContain("--force-enrichments");
  });

  it("escalates for an unknown key with no declared owner", () => {
    const drift = { added: ["mystery.field"], removed: [] };

    const warning = StatsCache.formatSchemaDriftWarning(drift, OWNERS);

    expect(warning).toContain("--force");
    expect(warning).not.toContain("--force-enrichments");
  });

  it("asks for no action when the drift is removals only", () => {
    // Removed keys have no descriptor, so nothing reads them any more.
    // Demanding a full reindex here costs hours and repopulates nothing.
    const drift = { added: [], removed: ["git.file.retiredSignal"] };

    const warning = StatsCache.formatSchemaDriftWarning(drift, OWNERS);

    expect(warning).toContain("git.file.retiredSignal");
    expect(warning).not.toContain("--force");
    expect(warning).toMatch(/no action|no reindex/i);
  });

  it("keeps the legacy full-reindex hint when no owners are supplied", () => {
    const drift = { added: ["git.file.newSignal"], removed: [] };

    const warning = StatsCache.formatSchemaDriftWarning(drift);

    expect(warning).toContain("reindex");
  });
});

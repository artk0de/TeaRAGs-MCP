import { randomBytes } from "node:crypto";
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { CollectionSignalStats } from "../../../../../src/core/contracts/types/trajectory.js";
import { checkSchemaDrift } from "../../../../../src/core/domains/maintenance/drift/schema-drift.js";
import { StatsCache } from "../../../../../src/core/infra/stats-cache.js";

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

describe("checkSchemaDrift", () => {
  it("returns null when no cached keys", () => {
    expect(checkSchemaDrift(undefined, ["a"])).toBeNull();
  });

  it("returns null when no drift", () => {
    expect(checkSchemaDrift(["a", "b"], ["a", "b"])).toBeNull();
  });

  it("detects added fields", () => {
    const drift = checkSchemaDrift(["a"], ["a", "b"]);
    expect(drift).toEqual({ added: ["b"], removed: [] });
  });

  it("detects removed fields", () => {
    const drift = checkSchemaDrift(["a", "b"], ["a"]);
    expect(drift).toEqual({ added: [], removed: ["b"] });
  });

  it("detects both added and removed", () => {
    const drift = checkSchemaDrift(["a", "b"], ["b", "c"]);
    expect(drift).toEqual({ added: ["c"], removed: ["a"] });
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
    const drift = checkSchemaDrift(loaded?.payloadFieldKeys, ["git.file.commitCount"]);
    expect(drift).toBeNull();
  });

  it("checkSchemaDrift returns null when keys match exactly", () => {
    const keys = ["git.file.ageDays", "git.file.commitCount"];
    cache.save("col", SAMPLE_STATS, keys);
    const loaded = cache.load("col");
    const drift = checkSchemaDrift(loaded?.payloadFieldKeys, keys);
    expect(drift).toBeNull();
  });

  it("checkSchemaDrift detects new fields", () => {
    const cachedKeys = ["git.file.commitCount"];
    const currentKeys = ["git.file.commitCount", "git.file.ageDays"];
    const drift = checkSchemaDrift(cachedKeys, currentKeys);
    expect(drift).not.toBeNull();
    expect(drift!.added).toEqual(["git.file.ageDays"]);
    expect(drift!.removed).toEqual([]);
  });

  it("checkSchemaDrift detects removed fields", () => {
    const cachedKeys = ["git.file.ageDays", "git.file.commitCount"];
    const currentKeys = ["git.file.commitCount"];
    const drift = checkSchemaDrift(cachedKeys, currentKeys);
    expect(drift).not.toBeNull();
    expect(drift!.added).toEqual([]);
    expect(drift!.removed).toEqual(["git.file.ageDays"]);
  });

  it("checkSchemaDrift detects both added and removed fields", () => {
    const cachedKeys = ["git.file.ageDays", "git.file.commitCount"];
    const currentKeys = ["git.chunk.churnRatio", "git.file.commitCount"];
    const drift = checkSchemaDrift(cachedKeys, currentKeys);
    expect(drift).not.toBeNull();
    expect(drift!.added).toEqual(["git.chunk.churnRatio"]);
    expect(drift!.removed).toEqual(["git.file.ageDays"]);
  });

  it("detects drift when navigation key is missing from cached index", () => {
    const cachedKeys = ["git.file.ageDays", "git.file.commitCount"];
    const currentKeys = ["git.file.ageDays", "git.file.commitCount", "navigation"];

    const drift = checkSchemaDrift(cachedKeys, currentKeys);

    expect(drift).not.toBeNull();
    expect(drift!.added).toContain("navigation");
  });
});

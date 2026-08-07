import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { QdrantManager } from "../../../../../src/core/adapters/qdrant/client.js";
import { StatsStoreAdapter } from "../../../../../src/core/domains/maintenance/migration/adapters/stats-store-adapter.js";
import { StatsCache } from "../../../../../src/core/infra/stats-cache.js";

const COLLECTION = "code_test";

/**
 * 120 vectors — 60 disjoint pairs, above the 50-pair floor `computeScoreBackground`
 * requires before it will report a scale. Alternating axes give a non-degenerate
 * spread rather than a single repeated cosine.
 */
const VECTORS = Array.from({ length: 120 }, (_, i) =>
  i % 3 === 0 ? [1, 0, 0] : i % 3 === 1 ? [0, 1, 0] : [0.6, 0.8, 0],
);

function statsFile(version: 4 | 5 | 6, withBackground = false): string {
  const perLanguage =
    version === 4
      ? { typescript: { methodLines: { count: 1, min: 1, max: 1, mean: 1, stddev: 0, percentiles: {} } } }
      : { typescript: { methodLines: { source: { count: 1, min: 1, max: 1, mean: 1, stddev: 0, percentiles: {} } } } };

  return JSON.stringify({
    version,
    collectionName: COLLECTION,
    computedAt: 1,
    perSignal: {},
    perLanguage,
    distributions: {},
    payloadFieldKeys: ["relativePath"],
    ...(withBackground ? { scoreBackground: { mean: 0.2, stddev: 0.1, sampleCount: 100 } } : {}),
  });
}

describe("StatsStoreAdapter", () => {
  let dir: string;
  let cache: StatsCache;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "stats-adapter-"));
    cache = new StatsCache(dir);
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function write(version: 4 | 5 | 6, withBackground = false): void {
    writeFileSync(join(dir, `${COLLECTION}.stats.json`), statsFile(version, withBackground), "utf-8");
  }

  function adapterWith(sample: () => Promise<number[][]>): StatsStoreAdapter {
    return new StatsStoreAdapter({} as QdrantManager, cache, 10, sample);
  }

  describe("getBackgroundState", () => {
    it("reports none when no stats file exists", async () => {
      const adapter = adapterWith(async () => VECTORS);
      expect(await adapter.getBackgroundState(COLLECTION)).toBe("none");
    });

    it("reports missing-background for a v6 file written without the field", async () => {
      write(6, false);
      const adapter = adapterWith(async () => VECTORS);
      expect(await adapter.getBackgroundState(COLLECTION)).toBe("missing-background");
    });

    it("reports complete once the field is stored", async () => {
      write(6, true);
      const adapter = adapterWith(async () => VECTORS);
      expect(await adapter.getBackgroundState(COLLECTION)).toBe("complete");
    });
  });

  describe("backfillScoreBackground", () => {
    it("stores the measured background into the existing stats file", async () => {
      write(6, false);
      const adapter = adapterWith(async () => VECTORS);

      expect(await adapter.backfillScoreBackground(COLLECTION)).toBe(true);
      expect(cache.load(COLLECTION)?.scoreBackground).toBeDefined();
    });

    it("preserves the signal stats it did not compute", async () => {
      write(6, false);
      const adapter = adapterWith(async () => VECTORS);

      await adapter.backfillScoreBackground(COLLECTION);

      const reloaded = cache.load(COLLECTION);
      expect(reloaded?.perLanguage.get("typescript")?.get("methodLines")?.source.count).toBe(1);
      expect(reloaded?.payloadFieldKeys).toEqual(["relativePath"]);
    });

    it("lifts an older stats file to the current version on disk", async () => {
      write(4, false);
      const adapter = adapterWith(async () => VECTORS);

      await adapter.backfillScoreBackground(COLLECTION);

      const raw = JSON.parse(readFileSync(join(dir, `${COLLECTION}.stats.json`), "utf-8")) as { version: number };
      expect(raw.version).toBe(6);
    });

    it("reports false when there is no stats file to write into", async () => {
      const adapter = adapterWith(async () => VECTORS);
      expect(await adapter.backfillScoreBackground(COLLECTION)).toBe(false);
    });

    it("reports false when the sample is too small to measure", async () => {
      write(6, false);
      const adapter = adapterWith(async () => []);
      expect(await adapter.backfillScoreBackground(COLLECTION)).toBe(false);
    });

    it("survives a failing sample instead of breaking the reindex", async () => {
      write(6, false);
      const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
      const adapter = adapterWith(async () => {
        throw new Error("qdrant unavailable");
      });

      await expect(adapter.backfillScoreBackground(COLLECTION)).resolves.toBe(false);
      spy.mockRestore();
    });
  });
});

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { QdrantManager } from "../../../../../src/core/adapters/qdrant/client.js";
import type {
  CollectionSignalStats,
  PayloadSignalDescriptor,
} from "../../../../../src/core/contracts/types/trajectory.js";
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
      expect(raw.version).toBe(7);
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

  /**
   * A file-scope signal is stamped onto every chunk of its file, so a sample
   * taken before `dedupeByFile` let a many-chunk file vote once per chunk. The
   * stats files that skew carries are all unstamped — written before the
   * sampling contract existed — so the count against the file total is the only
   * evidence there is, and these cases exercise that inference path.
   */
  describe("sampling contract", () => {
    const FILE_SIGNAL: PayloadSignalDescriptor = {
      key: "git.file.bugFixRate",
      type: "number",
      description: "share of commits that were bug fixes",
      stats: { labels: { p50: "concerning" }, dedupeByFile: true },
    };

    function writeSample(counts: Record<string, number>, totalFiles: number): void {
      writeFileSync(
        join(dir, `${COLLECTION}.stats.json`),
        JSON.stringify({
          version: 6,
          collectionName: COLLECTION,
          computedAt: 1,
          perSignal: Object.fromEntries(
            Object.entries(counts).map(([key, count]) => [key, { count, min: 0, max: 1, percentiles: { 50: 0 } }]),
          ),
          perLanguage: {},
          distributions: { totalFiles },
          payloadFieldKeys: ["relativePath", "git.file.bugFixRate"],
          scoreBackground: { mean: 0.2, stddev: 0.1, sampleCount: 100 },
        }),
        "utf-8",
      );
    }

    function adapterOver(
      points: { payload: Record<string, unknown> }[],
      recompute: (given: { payload: Record<string, unknown> }[]) => CollectionSignalStats,
    ): StatsStoreAdapter {
      const qdrant = {
        client: { scroll: async () => ({ points, next_page_offset: null }) },
      } as unknown as QdrantManager;
      return new StatsStoreAdapter(qdrant, cache, 10, async () => VECTORS, recompute, [FILE_SIGNAL]);
    }

    function rebuiltStats(): CollectionSignalStats {
      return {
        perSignal: new Map([["git.file.bugFixRate", { count: 3, min: 0, max: 1, percentiles: { 50: 0 } }]]),
        perLanguage: new Map(),
        distributions: { totalFiles: 3, language: {}, chunkType: {}, documentation: { docs: 0, code: 3 } },
        computedAt: 2,
      } as CollectionSignalStats;
    }

    it("reports none when there is no stats file to judge", async () => {
      const adapter = adapterOver([], rebuiltStats);
      expect(await adapter.getStatsContractState(COLLECTION)).toBe("none");
    });

    it("reads more observations than files as a chunk-weighted sample", async () => {
      writeSample({ "git.file.bugFixRate": 26552 }, 2453);
      const adapter = adapterOver([], rebuiltStats);

      expect(await adapter.getStatsContractState(COLLECTION)).toBe("stale");
    });

    it("reads one observation per file as already deduped", async () => {
      writeSample({ "git.file.bugFixRate": 2453 }, 2453);
      const adapter = adapterOver([], rebuiltStats);

      expect(await adapter.getStatsContractState(COLLECTION)).toBe("current");
    });

    // Judging by a total that was never written would compare against zero and
    // call every collection chunk-weighted — a migration re-run on every reindex.
    it("declines to judge a stats file carrying no file total", async () => {
      writeSample({ "git.file.bugFixRate": 26552 }, 0);
      const adapter = adapterOver([], rebuiltStats);

      expect(await adapter.getStatsContractState(COLLECTION)).toBe("current");
    });

    it("declines to judge when no recompute is wired to act on the answer", async () => {
      writeSample({ "git.file.bugFixRate": 26552 }, 2453);
      const adapter = new StatsStoreAdapter({} as QdrantManager, cache, 10, async () => VECTORS, undefined, [
        FILE_SIGNAL,
      ]);

      expect(await adapter.getStatsContractState(COLLECTION)).toBe("current");
    });

    it("rebuilds the stats file from stored payload, through the injected formula", async () => {
      writeSample({ "git.file.bugFixRate": 26552 }, 2453);
      const points = [{ payload: { relativePath: "a.ts" } }, { payload: { relativePath: "b.ts" } }];
      const recompute = vi.fn(rebuiltStats);
      const adapter = adapterOver(points, recompute);

      expect(await adapter.rebuildStatsFromPayload(COLLECTION)).toBe(true);
      expect(recompute).toHaveBeenCalledWith(points);
      expect(cache.load(COLLECTION)?.perSignal.get("git.file.bugFixRate")?.count).toBe(3);
    });

    it("carries the score background across — it is measured from vectors, not payload", async () => {
      writeSample({ "git.file.bugFixRate": 26552 }, 2453);
      const adapter = adapterOver([], rebuiltStats);

      await adapter.rebuildStatsFromPayload(COLLECTION);

      expect(cache.load(COLLECTION)?.scoreBackground).toEqual({ mean: 0.2, stddev: 0.1, sampleCount: 100 });
    });

    it("leaves the payload-key stamp alone so drift keeps its own verdict", async () => {
      writeSample({ "git.file.bugFixRate": 26552 }, 2453);
      const adapter = adapterOver([], rebuiltStats);

      await adapter.rebuildStatsFromPayload(COLLECTION);

      expect(cache.load(COLLECTION)?.payloadFieldKeys).toEqual(["relativePath", "git.file.bugFixRate"]);
    });

    it("reports false when there is no stats file to rebuild", async () => {
      const adapter = adapterOver([], rebuiltStats);
      expect(await adapter.rebuildStatsFromPayload(COLLECTION)).toBe(false);
    });

    it("survives a failing scroll instead of breaking the reindex", async () => {
      writeSample({ "git.file.bugFixRate": 26552 }, 2453);
      const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
      const qdrant = {
        client: {
          scroll: async () => {
            throw new Error("qdrant unavailable");
          },
        },
      } as unknown as QdrantManager;
      const adapter = new StatsStoreAdapter(qdrant, cache, 10, async () => VECTORS, rebuiltStats, [FILE_SIGNAL]);

      await expect(adapter.rebuildStatsFromPayload(COLLECTION)).resolves.toBe(false);
      spy.mockRestore();
    });
  });
});

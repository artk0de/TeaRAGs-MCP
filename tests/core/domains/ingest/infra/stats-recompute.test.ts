/**
 * StatsRecomputeService — lazy hot recompute behavioral tests.
 *
 * Tests cover the contract from the spec
 * (docs/superpowers/specs/2026-05-15-lazy-percentile-recompute-design.md):
 * partial in-place updates preserve every other SignalStats field, one
 * scroll per signal regardless of missing-percentile count, single save
 * at the end, concurrent ensureCoverage produces ONE scroll per
 * (collection, signal), failure modes degrade gracefully.
 */

import { describe, expect, it, vi } from "vitest";

import type {
  CollectionSignalStats,
  PayloadSignalDescriptor,
  SignalStats,
} from "../../../../../src/core/contracts/types/trajectory.js";
import { StatsRecomputeService } from "../../../../../src/core/domains/ingest/infra/stats-recompute.js";

function makeStats(perSignalEntries: [string, SignalStats][]): CollectionSignalStats {
  return {
    perSignal: new Map(perSignalEntries),
    perLanguage: new Map(),
    distributions: {
      totalFiles: 0,
      language: {},
      chunkType: {},
      documentation: { docs: 0, code: 0 },
      topAuthors: [],
      othersCount: 0,
    } as CollectionSignalStats["distributions"],
    computedAt: 1_700_000_000_000,
  };
}

function makeStatsCache() {
  return {
    save: vi.fn(),
    load: vi.fn(),
    invalidate: vi.fn(),
  } as any;
}

function makeQdrant(points: Record<string, unknown>[]) {
  return {
    client: {
      scroll: vi.fn(async () => ({ points: points.map((payload) => ({ payload })), next_page_offset: null })),
    },
  } as any;
}

const bugFixFileDescriptor: PayloadSignalDescriptor = {
  key: "git.file.bugFixRate",
  type: "number",
  description: "bugFixRate",
  stats: {
    labels: { p50: "healthy", p75: "concerning", p95: "critical" },
    confidence: {
      support: "commitCount",
      score: { threshold: 10, adaptivePercentile: 25 },
      label: {
        rules: [
          { whenSupportBelow: "p10", fallback: 5, ceiling: "healthy" },
          { whenSupportBelow: "p25", fallback: 10, ceiling: "concerning" },
        ],
      },
    },
  },
} as unknown as PayloadSignalDescriptor;

const bugFixChunkDescriptor: PayloadSignalDescriptor = {
  key: "git.chunk.bugFixRate",
  type: "number",
  description: "chunk bugFixRate",
  stats: {
    labels: { p50: "healthy", p75: "concerning", p95: "critical" },
    confidence: {
      support: "commitCount",
      score: { threshold: 10, adaptivePercentile: 25 },
      label: {
        rules: [{ whenSupportBelow: "p10", fallback: 5, ceiling: "healthy" }],
      },
    },
  },
} as unknown as PayloadSignalDescriptor;

describe("StatsRecomputeService.ensureCoverage", () => {
  it("is a noop when all referenced percentiles already exist", async () => {
    const stats = makeStats([
      [
        "git.file.commitCount",
        {
          count: 100,
          min: 1,
          max: 50,
          percentiles: { 10: 1, 25: 3, 50: 6, 75: 14, 95: 28 },
          mean: 7,
          stddev: 4,
        } as SignalStats,
      ],
    ]);
    const qdrant = makeQdrant([]);
    const statsCache = makeStatsCache();
    const service = new StatsRecomputeService(qdrant, statsCache);

    await service.ensureCoverage("coll-1", stats, [bugFixFileDescriptor]);

    expect(qdrant.client.scroll).not.toHaveBeenCalled();
    expect(statsCache.save).not.toHaveBeenCalled();
  });

  it("backfills missing percentiles in place and preserves every other SignalStats field", async () => {
    const initialPercentiles = { 25: 3, 50: 6, 75: 14, 95: 28 };
    const stats = makeStats([
      [
        "git.file.commitCount",
        {
          count: 100,
          min: 1,
          max: 50,
          percentiles: { ...initialPercentiles },
          mean: 7,
          stddev: 4,
        } as SignalStats,
      ],
    ]);
    const points = Array.from({ length: 11 }, (_, i) => ({ "git.file.commitCount": i + 1 }));
    const qdrant = makeQdrant(points);
    const statsCache = makeStatsCache();
    const service = new StatsRecomputeService(qdrant, statsCache);

    await service.ensureCoverage("coll-1", stats, [bugFixFileDescriptor]);

    const updated = stats.perSignal.get("git.file.commitCount")!;
    expect(updated.percentiles?.[10]).toBeDefined();
    expect(updated.percentiles?.[10]).toBeGreaterThan(0);
    expect(updated.percentiles?.[25]).toBe(initialPercentiles[25]);
    expect(updated.percentiles?.[50]).toBe(initialPercentiles[50]);
    expect(updated.percentiles?.[75]).toBe(initialPercentiles[75]);
    expect(updated.percentiles?.[95]).toBe(initialPercentiles[95]);
    expect(updated.count).toBe(100);
    expect(updated.min).toBe(1);
    expect(updated.max).toBe(50);
    expect(updated.mean).toBe(7);
    expect(updated.stddev).toBe(4);
  });

  it("uses ONE scroll regardless of how many missing percentiles the same signal needs", async () => {
    const stats = makeStats([
      ["git.file.commitCount", { count: 100, min: 1, max: 50, percentiles: { 50: 6 }, mean: 7 } as SignalStats],
    ]);
    const points = Array.from({ length: 11 }, (_, i) => ({ "git.file.commitCount": i + 1 }));
    const qdrant = makeQdrant(points);
    const statsCache = makeStatsCache();
    const service = new StatsRecomputeService(qdrant, statsCache);

    // bugFix file descriptor references p10 + p25 of commitCount (label rules)
    // plus p25 again (score adaptivePercentile defaults to 25) → 2 unique percentiles
    await service.ensureCoverage("coll-1", stats, [bugFixFileDescriptor]);

    expect(qdrant.client.scroll).toHaveBeenCalledTimes(1);
    expect(statsCache.save).toHaveBeenCalledTimes(1);
    const updated = stats.perSignal.get("git.file.commitCount")!;
    expect(updated.percentiles?.[10]).toBeDefined();
    expect(updated.percentiles?.[25]).toBeDefined();
  });

  it("saves stats-cache exactly once at the end, even with multiple signals backfilled", async () => {
    const stats = makeStats([
      ["git.file.commitCount", { count: 100, min: 1, max: 50, percentiles: { 50: 6 }, mean: 7 } as SignalStats],
      ["git.chunk.commitCount", { count: 200, min: 1, max: 30, percentiles: { 50: 4 }, mean: 5 } as SignalStats],
    ]);
    const points = [
      ...Array.from({ length: 11 }, (_, i) => ({ "git.file.commitCount": i + 1, "git.chunk.commitCount": i + 1 })),
    ];
    const qdrant = makeQdrant(points);
    const statsCache = makeStatsCache();
    const service = new StatsRecomputeService(qdrant, statsCache);

    await service.ensureCoverage("coll-1", stats, [bugFixFileDescriptor, bugFixChunkDescriptor]);

    expect(statsCache.save).toHaveBeenCalledTimes(1);
    expect(statsCache.save).toHaveBeenCalledWith("coll-1", stats, undefined);
  });

  it("deduplicates concurrent ensureCoverage calls to ONE scroll per (collection, signal)", async () => {
    const stats = makeStats([
      ["git.file.commitCount", { count: 100, min: 1, max: 50, percentiles: { 50: 6 }, mean: 7 } as SignalStats],
    ]);
    const points = Array.from({ length: 11 }, (_, i) => ({ "git.file.commitCount": i + 1 }));
    const qdrant = makeQdrant(points);
    const statsCache = makeStatsCache();
    const service = new StatsRecomputeService(qdrant, statsCache);

    await Promise.all([
      service.ensureCoverage("coll-1", stats, [bugFixFileDescriptor]),
      service.ensureCoverage("coll-1", stats, [bugFixFileDescriptor]),
      service.ensureCoverage("coll-1", stats, [bugFixFileDescriptor]),
    ]);

    expect(qdrant.client.scroll).toHaveBeenCalledTimes(1);
  });

  it("does not save when scroll returns no positive values", async () => {
    const stats = makeStats([
      ["git.file.commitCount", { count: 0, min: 0, max: 0, percentiles: { 50: 0 }, mean: 0 } as SignalStats],
    ]);
    const qdrant = makeQdrant([{ "git.file.commitCount": 0 }, { "git.file.commitCount": null }]);
    const statsCache = makeStatsCache();
    const service = new StatsRecomputeService(qdrant, statsCache);

    await service.ensureCoverage("coll-1", stats, [bugFixFileDescriptor]);

    expect(statsCache.save).not.toHaveBeenCalled();
    const updated = stats.perSignal.get("git.file.commitCount")!;
    expect(updated.percentiles?.[10]).toBeUndefined();
  });

  it("does not save when the support signal is not present in stats", async () => {
    const stats = makeStats([]); // no perSignal entry for commitCount
    const qdrant = makeQdrant([{ "git.file.commitCount": 5 }]);
    const statsCache = makeStatsCache();
    const service = new StatsRecomputeService(qdrant, statsCache);

    await service.ensureCoverage("coll-1", stats, [bugFixFileDescriptor]);

    expect(qdrant.client.scroll).not.toHaveBeenCalled();
    expect(statsCache.save).not.toHaveBeenCalled();
  });

  it("degrades gracefully on Qdrant scroll error: warns, no save, no mutation", async () => {
    const stats = makeStats([
      ["git.file.commitCount", { count: 100, min: 1, max: 50, percentiles: { 50: 6 }, mean: 7 } as SignalStats],
    ]);
    const qdrant = {
      client: { scroll: vi.fn().mockRejectedValue(new Error("qdrant down")) },
    } as any;
    const statsCache = makeStatsCache();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const service = new StatsRecomputeService(qdrant, statsCache);

    await service.ensureCoverage("coll-1", stats, [bugFixFileDescriptor]);

    expect(warn).toHaveBeenCalled();
    expect(statsCache.save).not.toHaveBeenCalled();
    expect(stats.perSignal.get("git.file.commitCount")?.percentiles?.[10]).toBeUndefined();
    warn.mockRestore();
  });

  it("warns but does not throw when stats-cache persist fails after a successful compute", async () => {
    const stats = makeStats([
      ["git.file.commitCount", { count: 100, min: 1, max: 50, percentiles: { 50: 6 }, mean: 7 } as SignalStats],
    ]);
    const points = Array.from({ length: 11 }, (_, i) => ({ "git.file.commitCount": i + 1 }));
    const qdrant = makeQdrant(points);
    const statsCache = makeStatsCache();
    statsCache.save.mockImplementation(() => {
      throw new Error("disk full");
    });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const service = new StatsRecomputeService(qdrant, statsCache);

    await expect(service.ensureCoverage("coll-1", stats, [bugFixFileDescriptor])).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalled();
    // In-memory mutation is still valid even if persistence failed.
    expect(stats.perSignal.get("git.file.commitCount")?.percentiles?.[10]).toBeDefined();
    warn.mockRestore();
  });

  it("forwards payloadFieldKeys to statsCache.save when provided", async () => {
    const stats = makeStats([
      ["git.file.commitCount", { count: 100, min: 1, max: 50, percentiles: { 50: 6 }, mean: 7 } as SignalStats],
    ]);
    const points = Array.from({ length: 11 }, (_, i) => ({ "git.file.commitCount": i + 1 }));
    const qdrant = makeQdrant(points);
    const statsCache = makeStatsCache();
    const service = new StatsRecomputeService(qdrant, statsCache);

    await service.ensureCoverage(
      "coll-1",
      stats,
      [bugFixFileDescriptor],
      ["git.file.commitCount", "git.file.bugFixRate"],
    );

    expect(statsCache.save).toHaveBeenCalledWith("coll-1", stats, ["git.file.commitCount", "git.file.bugFixRate"]);
  });

  // ---------------------------------------------------------------------------
  // Edge cases — uncovered statement coverage
  // ---------------------------------------------------------------------------

  it("creates the percentiles object from scratch when the loaded SignalStats has no percentiles field", async () => {
    // SignalStats with NO percentiles field at all — exercises the mergePercentile
    // branch that initializes the object (not just inserts into an existing one).
    const stats = makeStats([["git.file.commitCount", { count: 100, min: 1, max: 50, mean: 7 } as SignalStats]]);
    const points = Array.from({ length: 11 }, (_, i) => ({ "git.file.commitCount": i + 1 }));
    const qdrant = makeQdrant(points);
    const statsCache = makeStatsCache();
    const service = new StatsRecomputeService(qdrant, statsCache);

    await service.ensureCoverage("coll-1", stats, [bugFixFileDescriptor]);

    const updated = stats.perSignal.get("git.file.commitCount")!;
    expect(updated.percentiles).toBeDefined();
    expect(updated.percentiles?.[10]).toBeGreaterThan(0);
    expect(updated.percentiles?.[25]).toBeGreaterThan(0);
    // Other fields preserved
    expect(updated.count).toBe(100);
    expect(updated.mean).toBe(7);
  });

  it("reads payload via nested-path fallback when the flat dot-key is absent", async () => {
    // Qdrant payloads can be nested ({git: {file: {commitCount: N}}}) instead
    // of flat ({"git.file.commitCount": N}). The service must handle both.
    const stats = makeStats([
      ["git.file.commitCount", { count: 100, min: 1, max: 50, percentiles: { 50: 6 }, mean: 7 } as SignalStats],
    ]);
    const points = Array.from({ length: 11 }, (_, i) => ({
      git: { file: { commitCount: i + 1 } },
    }));
    const qdrant = makeQdrant(points);
    const statsCache = makeStatsCache();
    const service = new StatsRecomputeService(qdrant, statsCache);

    await service.ensureCoverage("coll-1", stats, [bugFixFileDescriptor]);

    const updated = stats.perSignal.get("git.file.commitCount")!;
    expect(updated.percentiles?.[10]).toBeGreaterThan(0);
    expect(updated.percentiles?.[25]).toBeGreaterThan(0);
    expect(statsCache.save).toHaveBeenCalledTimes(1);
  });

  it("tolerates malformed nested payload shapes without throwing", async () => {
    // Some points have non-object intermediate keys — readPayloadPath must
    // return undefined for those and continue.
    const stats = makeStats([
      ["git.file.commitCount", { count: 100, min: 1, max: 50, percentiles: { 50: 6 }, mean: 7 } as SignalStats],
    ]);
    const points = [
      { git: null }, // null intermediate
      { git: { file: "not-an-object" } }, // primitive at leaf parent
      { git: { file: { commitCount: 5 } } }, // valid nested
      { git: { file: { commitCount: 10 } } },
      { git: { file: { commitCount: 15 } } },
      { git: { file: { commitCount: 20 } } },
      { git: { file: { commitCount: 25 } } },
    ];
    const qdrant = makeQdrant(points);
    const statsCache = makeStatsCache();
    const service = new StatsRecomputeService(qdrant, statsCache);

    await service.ensureCoverage("coll-1", stats, [bugFixFileDescriptor]);

    const updated = stats.perSignal.get("git.file.commitCount")!;
    expect(updated.percentiles?.[10]).toBeDefined();
  });

  it("respects the failure backoff window: after a failure, a subsequent ensureCoverage call skips the scroll", async () => {
    const stats = makeStats([
      ["git.file.commitCount", { count: 100, min: 1, max: 50, percentiles: { 50: 6 }, mean: 7 } as SignalStats],
    ]);
    const qdrant = {
      client: {
        scroll: vi
          .fn()
          .mockRejectedValueOnce(new Error("transient qdrant error"))
          .mockResolvedValue({ points: [], next_page_offset: null }),
      },
    } as any;
    const statsCache = makeStatsCache();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const service = new StatsRecomputeService(qdrant, statsCache);

    // First call — scroll fails, backoff recorded.
    await service.ensureCoverage("coll-1", stats, [bugFixFileDescriptor]);
    expect(qdrant.client.scroll).toHaveBeenCalledTimes(1);

    // Immediately retry — should be inside backoff window, scroll NOT called again.
    await service.ensureCoverage("coll-1", stats, [bugFixFileDescriptor]);
    expect(qdrant.client.scroll).toHaveBeenCalledTimes(1);
    expect(statsCache.save).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it("skips label-side percentiles when the rule's whenSupportBelow is numeric (not a 'pN' string)", async () => {
    // Numeric whenSupportBelow rules don't reference a percentile of the support —
    // the recompute path must skip them silently.
    const numericRuleDescriptor: PayloadSignalDescriptor = {
      key: "git.file.bugFixRate",
      type: "number",
      description: "bugFixRate",
      stats: {
        labels: { p50: "healthy", p75: "concerning", p95: "critical" },
        confidence: {
          support: "commitCount",
          // No score block, only label rules — and those rules are NUMERIC, not pN strings.
          label: {
            rules: [
              { whenSupportBelow: 3, fallback: 5, ceiling: "healthy" },
              { whenSupportBelow: 5, fallback: 10, ceiling: "concerning" },
            ],
          },
        },
      },
    } as unknown as PayloadSignalDescriptor;
    const stats = makeStats([
      // All percentiles present; numeric rules are not percentile references.
      [
        "git.file.commitCount",
        { count: 100, min: 1, max: 50, percentiles: { 10: 1, 25: 3, 50: 6, 75: 14, 95: 28 }, mean: 7 } as SignalStats,
      ],
    ]);
    const qdrant = makeQdrant([]);
    const statsCache = makeStatsCache();
    const service = new StatsRecomputeService(qdrant, statsCache);

    await service.ensureCoverage("coll-1", stats, [numericRuleDescriptor]);

    // No missing percentile reference → no scroll, no save.
    expect(qdrant.client.scroll).not.toHaveBeenCalled();
    expect(statsCache.save).not.toHaveBeenCalled();
  });

  it("skips descriptors with no confidence.support declared", async () => {
    const noConfidenceDescriptor: PayloadSignalDescriptor = {
      key: "git.file.ageDays",
      type: "number",
      description: "ageDays",
      stats: { labels: { p50: "fresh", p95: "old" } },
    } as unknown as PayloadSignalDescriptor;
    const stats = makeStats([]);
    const qdrant = makeQdrant([]);
    const statsCache = makeStatsCache();
    const service = new StatsRecomputeService(qdrant, statsCache);

    await service.ensureCoverage("coll-1", stats, [noConfidenceDescriptor]);

    expect(qdrant.client.scroll).not.toHaveBeenCalled();
    expect(statsCache.save).not.toHaveBeenCalled();
  });

  it("skips descriptors whose raw key has fewer than 3 dot-segments (no scope to resolve to)", async () => {
    // Key like "bareName" can't be resolved to "git.file.commitCount" by namespace.
    const malformedKeyDescriptor: PayloadSignalDescriptor = {
      key: "shortKey",
      type: "number",
      description: "no-namespace key",
      stats: {
        labels: { p50: "ok" },
        confidence: {
          support: "commitCount",
          score: { threshold: 10, adaptivePercentile: 25 },
        },
      },
    } as unknown as PayloadSignalDescriptor;
    const stats = makeStats([
      ["git.file.commitCount", { count: 100, min: 1, max: 50, percentiles: { 50: 6 }, mean: 7 } as SignalStats],
    ]);
    const qdrant = makeQdrant([]);
    const statsCache = makeStatsCache();
    const service = new StatsRecomputeService(qdrant, statsCache);

    await service.ensureCoverage("coll-1", stats, [malformedKeyDescriptor]);

    expect(qdrant.client.scroll).not.toHaveBeenCalled();
    expect(statsCache.save).not.toHaveBeenCalled();
  });

  it("silently skips malformed 'pXX' rules whose numeric part parses as NaN", async () => {
    // `whenSupportBelow: "pfoo"` → Number("foo") = NaN; the enqueue guard
    // (Number.isFinite check) must drop the rule rather than calling
    // perSignal.get(signal).percentiles[NaN] which would short-circuit weirdly.
    const malformedRule: PayloadSignalDescriptor = {
      key: "git.file.bugFixRate",
      type: "number",
      description: "bugFixRate with malformed pN string",
      stats: {
        labels: { p50: "healthy" },
        confidence: {
          support: "commitCount",
          label: {
            rules: [{ whenSupportBelow: "pfoo", fallback: 5, ceiling: "healthy" }],
          },
        },
      },
    } as unknown as PayloadSignalDescriptor;
    const stats = makeStats([
      ["git.file.commitCount", { count: 100, min: 1, max: 50, percentiles: { 50: 6 }, mean: 7 } as SignalStats],
    ]);
    const qdrant = makeQdrant([]);
    const statsCache = makeStatsCache();
    const service = new StatsRecomputeService(qdrant, statsCache);

    await service.ensureCoverage("coll-1", stats, [malformedRule]);

    // Malformed rule dropped, no other percentile references → no scroll/save.
    expect(qdrant.client.scroll).not.toHaveBeenCalled();
    expect(statsCache.save).not.toHaveBeenCalled();
  });

  it("skips the label path when the descriptor key is itself too short to namespace (label-side guard)", async () => {
    // A descriptor declaring a label-only confidence block whose key has
    // fewer than 3 segments — resolveSiblingFullKey returns undefined for
    // the label path and the loop must `continue` without iterating rules.
    const malformedKeyLabel: PayloadSignalDescriptor = {
      key: "noNamespace",
      type: "number",
      description: "label-only confidence with bad key",
      stats: {
        labels: { p50: "ok" },
        confidence: {
          support: "commitCount",
          // No score block — only label. Forces the resolveSiblingFullKey for
          // the LABEL path (line 198) which is the guard that hits line 199.
          label: {
            rules: [{ whenSupportBelow: "p10", fallback: 5, ceiling: "ok" }],
          },
        },
      },
    } as unknown as PayloadSignalDescriptor;
    const stats = makeStats([
      ["git.file.commitCount", { count: 100, min: 1, max: 50, percentiles: { 50: 6 }, mean: 7 } as SignalStats],
    ]);
    const qdrant = makeQdrant([]);
    const statsCache = makeStatsCache();
    const service = new StatsRecomputeService(qdrant, statsCache);

    await service.ensureCoverage("coll-1", stats, [malformedKeyLabel]);

    expect(qdrant.client.scroll).not.toHaveBeenCalled();
    expect(statsCache.save).not.toHaveBeenCalled();
  });

  it("noop for label rule whose support resolves to a signal not present in stats (resolveSiblingFullKey resolved but no perSignal entry)", async () => {
    // Descriptor declares chunk-scope support but stats has only file-scope entry.
    // collectMissingPercentilesGrouped.enqueue should skip the chunk path silently.
    // (Resolved key exists but no perSignal entry — enqueue returns early.)
    const stats = makeStats([
      // File support present (used by score path); but chunk support NOT in stats.
      [
        "git.file.commitCount",
        { count: 100, min: 1, max: 50, percentiles: { 10: 1, 25: 3, 50: 6, 75: 14, 95: 28 }, mean: 7 } as SignalStats,
      ],
    ]);
    const qdrant = makeQdrant([]);
    const statsCache = makeStatsCache();
    const service = new StatsRecomputeService(qdrant, statsCache);

    // bugFixChunkDescriptor references chunk-scope support — stats has no entry for it.
    await service.ensureCoverage("coll-1", stats, [bugFixChunkDescriptor]);

    expect(qdrant.client.scroll).not.toHaveBeenCalled();
    expect(statsCache.save).not.toHaveBeenCalled();
  });
});

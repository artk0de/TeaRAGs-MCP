/**
 * The optimum a run persists is the BEST point it measured, not the first one
 * it settled on — and a run that finds a trusted optimum stored starts there
 * instead of re-probing (bd tea-rags-mcp-cyw2r).
 *
 * Live: pixbar-tiles `--force` on a 4-endpoint llama-server cluster. The size
 * settled at 256 (146.6k chars/s per batch), the concurrency climb then
 * measured 1 → 118.4k, 2 → 147.9k, 4 → 160.8k aggregate and the run ended
 * while it probed 8. The registry kept {256, concurrency 1} — the settle point
 * — so every later run started from 1 and climbed again.
 *
 * Only an AGGREGATE window counts as a measured point (the concurrency climb's
 * full window: `samplesPerSize × concurrency` batches at the settled size), and
 * a window that saw a producer-starved batch or a server failure is not
 * trusted. Against what is stored the run's best wins when it is at least as
 * fast, when the run re-measured its seed point (the server got slower), or
 * when the stored record is not an aggregate measurement; otherwise the stored
 * point stays.
 */

import { describe, expect, it } from "vitest";

import type { EmbeddingThroughputOptimum } from "../../../../../src/core/contracts/types/registry.js";
import {
  EmbeddingThroughputTuner,
  type EmbeddingEndpointIdentity,
  type EmbeddingThroughputAdaptation,
  type EmbeddingThroughputTunerConfig,
} from "../../../../../src/core/domains/ingest/pipeline/embedding-throughput-tuner.js";

const CLUSTER: EmbeddingEndpointIdentity = {
  provider: "llama-server",
  url: "http://192.168.1.71:8081,http://192.168.1.71:8082,http://192.168.1.71:8083,http://192.168.1.71:8084",
  model: "nomic-ai/CodeRankEmbed",
};
const CHARS_PER_TEXT = 1000;
const START = Date.parse("2026-10-03T16:39:00.000Z");

/** Aggregate chars/s the live run measured per concurrency (8 was never measured live). */
const LIVE_AGGREGATE: Record<number, number> = { 1: 118_400, 2: 147_900, 4: 160_800, 8: 170_000 };

type Server = (concurrency: number, size: number) => number;

/**
 * A clocked tuner plus a wave driver: batches go out in waves of `concurrency`,
 * every batch of a wave takes as long as the wave, so `server(c, size)` is
 * exactly what an aggregate window measures.
 */
function clockedRun(overrides: Partial<EmbeddingThroughputTunerConfig> = {}) {
  let clock = START;
  const log: EmbeddingThroughputAdaptation[] = [];
  const tuner = new EmbeddingThroughputTuner({
    ceiling: 256,
    floor: 16,
    configuredConcurrency: 8,
    initialConcurrency: 1,
    samplesPerSize: 3,
    recoveryStreak: 1000,
    reprobeAfterBatches: 100_000,
    minImprovement: 0.05,
    now: () => clock,
    ...overrides,
  });
  tuner.begin(CLUSTER);
  return {
    tuner,
    /** Every adaptation so far (drains the tuner into one run-long list). */
    adaptations(): EmbeddingThroughputAdaptation[] {
      log.push(...tuner.drainAdaptations());
      return log;
    },
    /** One wave; `starved` producer-starved partial flushes ride along after it. */
    wave(server: Server, starved = 0): void {
      const { batchSize, concurrency } = tuner.decision();
      const inputChars = batchSize * CHARS_PER_TEXT;
      const startedAt = clock;
      const durationMs = ((concurrency * inputChars) / server(concurrency, batchSize)) * 1000;
      clock = startedAt + durationMs;
      for (let i = 0; i < concurrency; i++) {
        tuner.observe({
          size: batchSize,
          inputChars,
          durationMs,
          startedAt,
          ok: true,
          endpoint: CLUSTER,
          producerStarved: false,
        });
      }
      for (let i = 0; i < starved; i++) {
        tuner.observe({
          size: 7,
          inputChars: 7 * CHARS_PER_TEXT,
          durationMs: 1,
          startedAt: clock - 1,
          ok: true,
          endpoint: CLUSTER,
          producerStarved: true,
        });
      }
    },
    waves(server: Server, count: number, starved = 0): void {
      for (let i = 0; i < count; i++) this.wave(server, starved);
    },
    /** Waves until an adaptation with `reason` shows up (bounded). */
    wavesUntilReason(server: Server, reason: EmbeddingThroughputAdaptation["reason"], max = 300): void {
      for (let i = 0; i < max && !this.adaptations().some((a) => a.reason === reason); i++) this.wave(server);
    },
    persisted(): EmbeddingThroughputOptimum | undefined {
      return tuner.settledOptima()[0]?.optimum;
    },
  };
}

/** 256 is the best size (128 is 20% slower); concurrency follows `byConcurrency`. */
function sizedServer(byConcurrency: Record<number, number>): Server {
  return (concurrency, size) => (byConcurrency[concurrency] ?? 1) * (size === 256 ? 1 : 0.8);
}

/** Same rate at every size and every concurrency. */
function flatServer(charsPerSecond: number): Server {
  return () => charsPerSecond;
}

function stored(over: Partial<EmbeddingThroughputOptimum> = {}): EmbeddingThroughputOptimum {
  return {
    batchSize: 256,
    concurrency: 4,
    charsPerSecond: 160_800,
    settledAt: new Date(START - 60_000).toISOString(),
    measurement: "aggregate",
    ...over,
  };
}

const PROBE_REASONS = new Set(["probe", "reprobe", "settle", "concurrency-probe", "concurrency-settle"]);

describe("EmbeddingThroughputTuner — best measured optimum (cyw2r)", () => {
  it("persists the best measured level when the run ends mid-climb (the live pixbar-tiles sequence)", () => {
    const run = clockedRun();
    const server = sizedServer(LIVE_AGGREGATE);
    // Size settles at 256, concurrency climbs 1 → 2 → 4 → probe 8; the run ends during the 8 probe.
    for (let i = 0; i < 200 && run.tuner.decision().concurrency !== 8; i++) run.wave(server);
    run.waves(server, 2);

    expect(run.tuner.decision().concurrency).toBe(8);
    const persisted = run.persisted();
    expect(persisted).toMatchObject({ batchSize: 256, concurrency: 4, measurement: "aggregate" });
    expect(persisted?.charsPerSecond).toBeCloseTo(160_800, -1);
  });

  it("persists a probe point that beat the settled one, even below the climb's improvement bar", () => {
    const run = clockedRun({ configuredConcurrency: 2 });
    // 2 beats 1 by 3% — not enough for the climb to move (minImprovement 5%), but it IS the best measured point.
    run.wavesUntilReason(sizedServer({ 1: 100_000, 2: 103_000 }), "concurrency-settle");

    expect(run.tuner.decision().concurrency).toBe(1);
    expect(run.persisted()).toMatchObject({ batchSize: 256, concurrency: 2, measurement: "aggregate" });
  });

  it("never persists a window that saw a producer-starved batch", () => {
    const run = clockedRun({ configuredConcurrency: 2 });
    const server = sizedServer({ 1: 100_000, 2: 150_000 });
    // Settle the size and measure concurrency 1 cleanly.
    for (let i = 0; i < 200 && run.tuner.decision().concurrency !== 2; i++) run.wave(server);
    // The concurrency-2 window completes, but one starved flush rode inside it.
    run.wave(server, 1);
    run.waves(server, 2);

    expect(run.persisted()).toMatchObject({ concurrency: 1 });
  });

  it("never persists a window that saw a server failure", () => {
    const run = clockedRun({ configuredConcurrency: 2 });
    const server = sizedServer({ 1: 100_000, 2: 150_000 });
    for (let i = 0; i < 200 && run.tuner.decision().concurrency !== 2; i++) run.wave(server);
    // A late failure of a size above the cap — it changes no decision, yet the window is not trustworthy.
    run.tuner.observe({ size: 512, inputChars: 1, durationMs: 1, ok: false, endpoint: CLUSTER });
    run.waves(server, 3);

    expect(run.persisted()?.concurrency).toBe(1);
  });

  describe("merge with the stored optimum", () => {
    it("seeds batch size and concurrency from the stored optimum, clamped to the ceilings", () => {
      const run = clockedRun({
        ceiling: 128,
        configuredConcurrency: 4,
        storedOptimum: () => stored({ batchSize: 512, concurrency: 16 }),
      });
      expect(run.tuner.decision()).toEqual({ batchSize: 128, concurrency: 4 });
    });

    it("a starved run measures nothing and leaves the stored point alone", () => {
      const run = clockedRun({
        ceiling: 512,
        configuredConcurrency: 4,
        reprobeAfterBatches: 40,
        storedOptimum: () => stored(),
      });
      // Every wave is half starved: the guard is not judged, the re-probe's concurrency climb is held.
      run.waves(sizedServer({ 4: 60_000 }), 60, 4);
      expect(run.adaptations().some((a) => a.reason === "seed-slower")).toBe(false);
      expect(run.persisted()).toBeUndefined();
    });

    it("a faster run replaces the stored point", () => {
      const run = clockedRun({
        reprobeAfterBatches: 40,
        storedOptimum: () => stored({ concurrency: 2, charsPerSecond: 140_000 }),
      });
      run.wavesUntilReason(sizedServer(LIVE_AGGREGATE), "concurrency-settle");
      expect(run.persisted()).toMatchObject({ batchSize: 256, concurrency: 8, measurement: "aggregate" });
    });

    it("lowers the stored point when the run re-measured it and found the server slower", () => {
      const run = clockedRun({ storedOptimum: () => stored() });
      run.wavesUntilReason(sizedServer({ 2: 95_000, 4: 100_000, 8: 90_000 }), "concurrency-settle");

      const persisted = run.persisted();
      expect(persisted).toMatchObject({ batchSize: 256, concurrency: 4, measurement: "aggregate" });
      expect(persisted?.charsPerSecond).toBeCloseTo(100_000, -1);
    });

    it("replaces a stored per-batch record (a settle-only or pre-cyw2r optimum) with an aggregate measurement", () => {
      const legacy: EmbeddingThroughputOptimum = {
        batchSize: 256,
        concurrency: 1,
        charsPerSecond: 146_630,
        settledAt: new Date(START - 60_000).toISOString(),
      };
      const run = clockedRun({ configuredConcurrency: 1, storedOptimum: () => legacy });
      run.wavesUntilReason(sizedServer({ 1: 118_400 }), "concurrency-settle");
      expect(run.persisted()).toMatchObject({ batchSize: 256, concurrency: 1, measurement: "aggregate" });
      expect(run.persisted()?.charsPerSecond).toBeCloseTo(118_400, -1);
    });
  });

  describe("trusted seed", () => {
    it("starts settled at a stored aggregate optimum — no probes — and a pure seed run writes nothing", () => {
      const run = clockedRun({ storedOptimum: () => stored() });
      run.adaptations().length = 0;
      run.waves(flatServer(160_000), 40);

      expect(run.tuner.decision()).toEqual({ batchSize: 256, concurrency: 4 });
      expect(run.adaptations()).toEqual([]);
      expect(run.persisted()).toBeUndefined();
    });

    it("trusts a stored optimum whatever its age", () => {
      const run = clockedRun({ storedOptimum: () => stored({ settledAt: "2020-01-01T00:00:00.000Z" }) });
      run.waves(flatServer(160_000), 40);
      expect(run.adaptations().some((a) => PROBE_REASONS.has(a.reason))).toBe(false);
    });

    it("probes as before without a stored optimum", () => {
      const run = clockedRun();
      run.waves(flatServer(160_000), 40);
      expect(run.adaptations().some((a) => a.reason === "probe")).toBe(true);
    });

    it("drops into the climb when the seed measures below 70% of its stored rate", () => {
      const run = clockedRun({ storedOptimum: () => stored({ charsPerSecond: 100_000 }) });
      run.waves(flatServer(65_000), 10);
      const slower = run.adaptations().find((a) => a.reason === "seed-slower");
      expect(slower?.charsPerSecond).toBeCloseTo(65_000, -1);
      run.waves(flatServer(65_000), 10);
      expect(run.adaptations().some((a) => a.reason === "probe" || a.reason === "settle")).toBe(true);
    });

    it("keeps riding the seed at 75% of its stored rate", () => {
      const run = clockedRun({ storedOptimum: () => stored({ charsPerSecond: 100_000 }) });
      run.waves(flatServer(75_000), 40);
      expect(run.adaptations().some((a) => a.reason === "seed-slower" || PROBE_REASONS.has(a.reason))).toBe(false);
    });

    it("never trips the guard while the producer starves", () => {
      const run = clockedRun({ storedOptimum: () => stored({ charsPerSecond: 100_000 }) });
      run.waves(flatServer(50_000), 40, 4);
      expect(run.adaptations().some((a) => a.reason === "seed-slower")).toBe(false);
    });
  });

  describe("periodic re-probe", () => {
    it("fires after 1000 settled batches by default, not 200", () => {
      const run = clockedRun({ reprobeAfterBatches: undefined, storedOptimum: () => stored({ concurrency: 2 }) });
      // Two batches per wave at concurrency 2.
      run.waves(flatServer(160_000), 150);
      expect(run.adaptations().some((a) => a.reason === "concurrency-probe")).toBe(false);
      run.waves(flatServer(160_000), 360);
      expect(run.adaptations().some((a) => a.reason === "concurrency-probe")).toBe(true);
    });

    it("probes only upward: never a size or a concurrency below the working point", () => {
      const run = clockedRun({
        configuredConcurrency: 4,
        reprobeAfterBatches: 40,
        storedOptimum: () => stored({ batchSize: 128, concurrency: 2, charsPerSecond: 100_000 }),
      });
      run.wavesUntilReason(flatServer(100_000), "concurrency-settle");
      const probes = run.adaptations().filter((a) => a.reason !== "settle" && a.reason !== "concurrency-settle");
      expect(probes.length).toBeGreaterThan(0);
      for (const a of probes) {
        if (a.kind === "batchSize") expect(a.to).toBeGreaterThanOrEqual(128);
        else expect(a.to).toBeGreaterThanOrEqual(2);
      }
      expect(run.tuner.decision()).toEqual({ batchSize: 128, concurrency: 2 });
    });

    it("is a no-op at both ceilings: no adaptation at all", () => {
      const run = clockedRun({ reprobeAfterBatches: 40, storedOptimum: () => stored({ concurrency: 8 }) });
      run.adaptations().length = 0;
      run.waves(flatServer(160_800), 40);
      expect(run.adaptations()).toEqual([]);
      expect(run.tuner.decision()).toEqual({ batchSize: 256, concurrency: 8 });
    });

    it("adopts an upward probe only when it beats the working point by minImprovement", () => {
      const run = clockedRun({
        configuredConcurrency: 4,
        reprobeAfterBatches: 40,
        storedOptimum: () => stored({ concurrency: 2, charsPerSecond: 100_000 }),
      });
      run.wavesUntilReason(sizedServer({ 2: 100_000, 4: 103_000 }), "concurrency-settle");
      expect(run.adaptations()).toContainEqual(
        expect.objectContaining({ kind: "concurrency", from: 2, to: 4, reason: "concurrency-probe" }),
      );
      expect(run.adaptations().find((a) => a.reason === "concurrency-settle")).toMatchObject({ to: 2 });
      expect(run.tuner.decision().concurrency).toBe(2);
    });
  });
});

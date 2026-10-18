/**
 * Tests for EmbeddingThroughputTuner (bd tea-rags-mcp-7ju66).
 *
 * The tuner is driven by a fake embedder: a size → chars/s curve plus a size
 * above which the "server" fails the whole batch. Durations come from the
 * curve, so the tuner sees exactly the throughput the test declares — no real
 * clock, no timers.
 */

import { describe, expect, it } from "vitest";

import {
  EmbeddingThroughputTuner,
  type EmbeddingEndpointIdentity,
  type EmbeddingThroughputAdaptation,
  type EmbeddingThroughputTunerConfig,
} from "../../../../../src/core/domains/ingest/pipeline/embedding-throughput-tuner.js";

const LOCAL: EmbeddingEndpointIdentity = { url: "http://localhost:11434", model: "jina" };
const REMOTE: EmbeddingEndpointIdentity = { url: "http://192.168.1.71:11434", model: "jina" };
const CHARS_PER_TEXT = 1000;

interface FakeEmbedder {
  /** chars per second at a given batch size */
  rate: (size: number) => number;
  /** sizes strictly above this fail the whole batch */
  failAbove?: number;
}

function peakedCurve(peak: number): (size: number) => number {
  // Log-distance from the peak: every halving/doubling away costs 20%.
  return (size) => 10_000 * Math.pow(0.8, Math.abs(Math.log2(size / peak)));
}

const MAKE_TUNER_CLOCK = Date.parse("2026-10-02T00:00:00.000Z");

/**
 * Where `drive` is on each tuner's timeline: batches run back to back from the
 * frozen clock on, each starting where the previous one ended, so a size
 * window's wall span is the sum of its durations and its aggregate chars/s is
 * exactly the curve's rate.
 */
const driveTimeline = new WeakMap<EmbeddingThroughputTuner, number>();

function makeTuner(overrides: Partial<EmbeddingThroughputTunerConfig> = {}) {
  const drained: EmbeddingThroughputAdaptation[] = [];
  const clock = MAKE_TUNER_CLOCK;
  const tuner = new EmbeddingThroughputTuner({
    ceiling: 256,
    floor: 16,
    configuredConcurrency: 4,
    samplesPerSize: 2,
    recoveryStreak: 6,
    reprobeAfterBatches: 1000,
    minImprovement: 0.05,
    now: () => clock,
    ...overrides,
  });
  return {
    tuner,
    /** Every adaptation so far — drains the tuner into one run-long list. */
    adaptations: (): EmbeddingThroughputAdaptation[] => {
      drained.push(...tuner.drainAdaptations());
      return drained;
    },
  };
}

/** Run `batches` full batches through the tuner against the fake embedder; returns the sizes sent. */
function drive(
  tuner: EmbeddingThroughputTuner,
  embedder: FakeEmbedder,
  batches: number,
  endpoint: EmbeddingEndpointIdentity = LOCAL,
): number[] {
  const sent: number[] = [];
  let startedAt = driveTimeline.get(tuner) ?? MAKE_TUNER_CLOCK;
  for (let i = 0; i < batches; i++) {
    const size = tuner.decision().batchSize;
    sent.push(size);
    const inputChars = size * CHARS_PER_TEXT;
    if (embedder.failAbove !== undefined && size > embedder.failAbove) {
      tuner.observe({ size, inputChars, durationMs: 1000, startedAt, ok: false, endpoint });
      startedAt += 1000;
      continue;
    }
    const durationMs = (inputChars / embedder.rate(size)) * 1000;
    tuner.observe({ size, inputChars, durationMs, startedAt, ok: true, endpoint });
    startedAt += durationMs;
  }
  driveTimeline.set(tuner, startedAt);
  return sent;
}

describe("EmbeddingThroughputTuner", () => {
  describe("start", () => {
    it("starts at the configured ceiling without a stored optimum", () => {
      const { tuner } = makeTuner();
      expect(tuner.begin(REMOTE).batchSize).toBe(256);
    });

    it("seeds from the stored optimum of the matching endpoint + model, clamped to the bounds", () => {
      const seen: EmbeddingEndpointIdentity[] = [];
      const { tuner } = makeTuner({
        seed: (endpoint) => {
          seen.push(endpoint);
          return endpoint.url === REMOTE.url && endpoint.model === "jina" ? 64 : undefined;
        },
      });
      expect(tuner.begin(REMOTE).batchSize).toBe(64);
      expect(seen).toEqual([REMOTE]);
    });

    it("clamps a stored optimum outside [floor, ceiling]", () => {
      expect(makeTuner({ seed: () => 4096 }).tuner.begin(REMOTE).batchSize).toBe(256);
      expect(makeTuner({ seed: () => 2 }).tuner.begin(REMOTE).batchSize).toBe(16);
    });

    it("ignores a stored optimum for another model", () => {
      const { tuner } = makeTuner({ seed: (e) => (e.model === "jina" ? 64 : undefined) });
      expect(tuner.begin({ url: REMOTE.url, model: "nomic" }).batchSize).toBe(256);
    });

    it("emits a seed adaptation when the stored optimum moves the starting size", () => {
      const { tuner, adaptations } = makeTuner({ seed: () => 64 });
      tuner.begin(REMOTE);
      expect(adaptations()).toContainEqual(
        expect.objectContaining({ kind: "batchSize", from: 256, to: 64, reason: "seed" }),
      );
    });
  });

  describe("sticky downshift on failure", () => {
    it("halves the working size for every subsequent batch, not just the failing one", () => {
      const { tuner, adaptations } = makeTuner({ recoveryStreak: 100 });
      tuner.begin(REMOTE);
      const sent = drive(tuner, { rate: () => 10_000, failAbove: 128 }, 10, REMOTE);
      expect(sent[0]).toBe(256);
      expect(sent.slice(1).every((s) => s <= 128)).toBe(true);
      expect(adaptations()).toContainEqual(
        expect.objectContaining({ kind: "batchSize", from: 256, to: 128, reason: "failure" }),
      );
    });

    it("keeps halving down to the floor while failures continue", () => {
      const { tuner } = makeTuner({ recoveryStreak: 100 });
      tuner.begin(REMOTE);
      drive(tuner, { rate: () => 10_000, failAbove: 1 }, 10, REMOTE);
      expect(tuner.decision().batchSize).toBe(16);
    });

    it("does not downshift again for a late failure of a size already above the cap", () => {
      const { tuner } = makeTuner({ recoveryStreak: 100 });
      tuner.begin(REMOTE);
      tuner.observe({ size: 256, inputChars: 1, durationMs: 1, ok: false, endpoint: REMOTE });
      tuner.observe({ size: 256, inputChars: 1, durationMs: 1, ok: false, endpoint: REMOTE });
      expect(tuner.decision().batchSize).toBe(128);
    });

    it("recovers upward only after a streak of successes, and stays down if the size fails again", () => {
      const { tuner } = makeTuner({ recoveryStreak: 6, samplesPerSize: 2 });
      tuner.begin(REMOTE);
      // Big batches are faster, but 256 fails: the tuner must not sit on 256.
      const sent = drive(tuner, { rate: (s) => s * 100, failAbove: 128 }, 60, REMOTE);
      const after = sent.slice(1);
      // It retries 256 at most occasionally (one per recovery streak), never back-to-back.
      for (let i = 1; i < after.length; i++) {
        expect(after[i] === 256 && after[i - 1] === 256).toBe(false);
      }
      expect(tuner.decision().batchSize).toBeLessThanOrEqual(128);
      expect(tuner.settledOptima()[0].optimum.batchSize).toBe(128);
    });

    it("climbs back to the ceiling when the failure was transient", () => {
      const { tuner } = makeTuner({ recoveryStreak: 6, samplesPerSize: 2 });
      tuner.begin(REMOTE);
      tuner.observe({ size: 256, inputChars: 1, durationMs: 1, ok: false, endpoint: REMOTE });
      expect(tuner.decision().batchSize).toBe(128);
      // Bigger is faster from now on and nothing fails.
      drive(tuner, { rate: (s) => s * 100 }, 40, REMOTE);
      expect(tuner.decision().batchSize).toBe(256);
    });
  });

  describe("throughput hill-climb", () => {
    it("converges down to the curve's best size and stays within bounds", () => {
      const { tuner } = makeTuner();
      tuner.begin(REMOTE);
      const sent = drive(tuner, { rate: peakedCurve(64) }, 40, REMOTE);
      expect(tuner.decision().batchSize).toBe(64);
      expect(sent.every((s) => s >= 16 && s <= 256)).toBe(true);
    });

    it("converges up from a low seed", () => {
      const { tuner } = makeTuner({ seed: () => 16 });
      tuner.begin(REMOTE);
      drive(tuner, { rate: peakedCurve(64) }, 40, REMOTE);
      expect(tuner.decision().batchSize).toBe(64);
    });

    it("never probes above a ceiling that is not a power of two", () => {
      const { tuner } = makeTuner({ ceiling: 200, floor: 25 });
      tuner.begin(REMOTE);
      const sent = drive(tuner, { rate: (s) => s * 100 }, 40, REMOTE);
      expect(Math.max(...sent)).toBe(200);
      expect(Math.min(...sent)).toBeGreaterThanOrEqual(25);
      expect(tuner.decision().batchSize).toBe(200);
    });

    it("normalises by input size: a batch of short texts is not mistaken for a fast size", () => {
      const { tuner } = makeTuner({ samplesPerSize: 1 });
      tuner.begin(REMOTE);
      // Same per-char cost at every size → no size is better, so the tuner must
      // settle where it started. Counting texts instead of chars would pick 128:
      // its chunks happen to be short, so it embeds 4x more texts per second.
      for (let i = 0; i < 30; i++) {
        const size = tuner.decision().batchSize;
        const charsPerText = size === 128 ? 250 : 1000;
        const inputChars = size * charsPerText;
        tuner.observe({ size, inputChars, durationMs: inputChars / 10, ok: true, endpoint: REMOTE });
      }
      expect(tuner.decision().batchSize).toBe(256);
    });

    it("ignores partial flushes when measuring a size", () => {
      const { tuner } = makeTuner({ samplesPerSize: 2 });
      tuner.begin(REMOTE);
      // Timeout flushes of 7 texts must not count as samples of 256.
      for (let i = 0; i < 10; i++) {
        tuner.observe({ size: 7, inputChars: 7000, durationMs: 1, ok: true, endpoint: REMOTE });
      }
      expect(tuner.decision().batchSize).toBe(256);
      expect(tuner.settledOptima()).toEqual([]);
    });

    it("re-probes after the configured number of settled batches and follows a drifted curve", () => {
      const { tuner, adaptations } = makeTuner({ reprobeAfterBatches: 10 });
      tuner.begin(REMOTE);
      drive(tuner, { rate: peakedCurve(64) }, 40, REMOTE);
      expect(tuner.decision().batchSize).toBe(64);
      drive(tuner, { rate: peakedCurve(128) }, 60, REMOTE);
      expect(tuner.settledOptima()[0].optimum.batchSize).toBe(128);
      expect(adaptations().some((a) => a.reason === "reprobe" || a.reason === "probe")).toBe(true);
    });

    it("logs every size change with the measured rate", () => {
      const { tuner, adaptations } = makeTuner();
      tuner.begin(REMOTE);
      drive(tuner, { rate: peakedCurve(64) }, 40, REMOTE);
      const settle = adaptations().find((a) => a.reason === "settle");
      expect(settle).toBeDefined();
      expect(settle?.to).toBe(64);
      expect(settle?.charsPerSecond).toBeCloseTo(10_000, 0);
    });

    it("reports the settled optimum per endpoint with a timestamp", () => {
      const { tuner } = makeTuner();
      tuner.begin(REMOTE);
      drive(tuner, { rate: peakedCurve(64) }, 40, REMOTE);
      const optima = tuner.settledOptima();
      expect(optima).toHaveLength(1);
      expect(optima[0].endpoint).toEqual(REMOTE);
      expect(optima[0].optimum).toMatchObject({ batchSize: 64, concurrency: 4 });
      expect(optima[0].optimum.charsPerSecond).toBeCloseTo(10_000, 0);
      expect(optima[0].optimum.settledAt).toBe("2026-10-02T00:00:00.000Z");
    });
  });

  describe("concurrency start and failover", () => {
    it("starts every endpoint at the configured concurrency, whatever its locality", () => {
      expect(makeTuner().tuner.begin(LOCAL).concurrency).toBe(4);
      expect(makeTuner().tuner.begin(REMOTE).concurrency).toBe(4);
    });

    it("keeps the configured concurrency when the endpoint has no url", () => {
      expect(makeTuner().tuner.begin({ model: "onnx" }).concurrency).toBe(4);
    });

    it("seeds concurrency from the stored optimum, clamped to [1, configured]", () => {
      const { tuner, adaptations } = makeTuner({ seedConcurrency: () => 2 });
      expect(tuner.begin(REMOTE).concurrency).toBe(2);
      expect(adaptations()).toContainEqual(
        expect.objectContaining({ kind: "concurrency", from: 4, to: 2, reason: "seed" }),
      );
      expect(makeTuner({ seedConcurrency: () => 64 }).tuner.begin(REMOTE).concurrency).toBe(4);
      expect(makeTuner({ seedConcurrency: () => 0 }).tuner.begin(REMOTE).concurrency).toBe(4);
    });

    it("re-seeds the size and the concurrency of the endpoint a failover moves to", () => {
      const { tuner, adaptations } = makeTuner({
        seed: (e) => (e.url === LOCAL.url ? 32 : 128),
        seedConcurrency: (e) => (e.url === LOCAL.url ? 1 : undefined),
      });
      expect(tuner.begin(REMOTE)).toEqual({ batchSize: 128, concurrency: 4 });
      tuner.observe({ size: 128, inputChars: 1000, durationMs: 10, ok: true, endpoint: LOCAL });
      expect(tuner.decision()).toEqual({ batchSize: 32, concurrency: 1 });
      expect(adaptations()).toContainEqual(
        expect.objectContaining({ kind: "concurrency", from: 4, to: 1, reason: "seed" }),
      );
      tuner.observe({ size: 32, inputChars: 1000, durationMs: 10, ok: true, endpoint: REMOTE });
      expect(tuner.decision()).toEqual({ batchSize: 128, concurrency: 4 });
      expect(adaptations()).toContainEqual(
        expect.objectContaining({ kind: "concurrency", from: 1, to: 4, reason: "seed" }),
      );
    });

    it("keeps a separate settled optimum per endpoint", () => {
      const { tuner } = makeTuner({ seedConcurrency: (e) => (e.url === LOCAL.url ? 1 : undefined) });
      tuner.begin(REMOTE);
      drive(tuner, { rate: peakedCurve(64) }, 40, REMOTE);
      tuner.observe({ size: 64, inputChars: 1, durationMs: 1, ok: true, endpoint: LOCAL });
      drive(tuner, { rate: peakedCurve(32) }, 40, LOCAL);
      const byUrl = Object.fromEntries(tuner.settledOptima().map((o) => [o.endpoint.url, o.optimum]));
      expect(byUrl[REMOTE.url!]).toMatchObject({ batchSize: 64, concurrency: 4 });
      expect(byUrl[LOCAL.url!]).toMatchObject({ batchSize: 32, concurrency: 1 });
    });
  });

  describe("concurrency hill-climb", () => {
    /**
     * A server whose AGGREGATE throughput depends on how many batches are in
     * flight. Batches go out in waves of `concurrency`; every batch of a wave
     * takes as long as the whole wave, so the per-call rate is aggregate/c —
     * judged per call, concurrency 1 would always win.
     */
    function makeClockedTuner(overrides: Partial<EmbeddingThroughputTunerConfig> = {}) {
      let clock = 1_000_000;
      const drained: EmbeddingThroughputAdaptation[] = [];
      const tuner = new EmbeddingThroughputTuner({
        ceiling: 256,
        floor: 16,
        configuredConcurrency: 8,
        samplesPerSize: 2,
        recoveryStreak: 1000,
        reprobeAfterBatches: 100_000,
        minImprovement: 0.05,
        now: () => clock,
        ...overrides,
      });
      return {
        tuner,
        adaptations: (): EmbeddingThroughputAdaptation[] => {
          drained.push(...tuner.drainAdaptations());
          return drained;
        },
        /** Run `count` waves; `aggregate(c)` is the server's total chars/s at concurrency c. */
        waves(aggregate: (concurrency: number) => number, count: number, explicitStart = false): number[] {
          const concurrencies: number[] = [];
          for (let w = 0; w < count; w++) {
            const { batchSize, concurrency } = tuner.decision();
            concurrencies.push(concurrency);
            const inputChars = batchSize * CHARS_PER_TEXT;
            const startedAt = clock;
            const durationMs = ((concurrency * inputChars) / aggregate(concurrency)) * 1000;
            clock = startedAt + durationMs;
            for (let i = 0; i < concurrency; i++) {
              tuner.observe({
                size: batchSize,
                inputChars,
                durationMs,
                ok: true,
                endpoint: REMOTE,
                ...(explicitStart ? { startedAt } : {}),
              });
            }
          }
          return concurrencies;
        },
      };
    }

    const AGGREGATE_PEAK_AT_4: Record<number, number> = { 1: 1000, 2: 2000, 4: 4000, 8: 3000 };
    const peakAt4 = (c: number) => AGGREGATE_PEAK_AT_4[c] ?? 1;
    // A serialising server: parallel requests only queue, and each doubling costs 10%.
    const serialising = (c: number) => 1000 * Math.pow(0.9, Math.log2(c));

    it("converges to the concurrency with the best aggregate chars/s (peak 4, configured 8)", () => {
      const { tuner, waves, adaptations } = makeClockedTuner();
      expect(tuner.begin(REMOTE).concurrency).toBe(8);
      const sent = waves(peakAt4, 40);
      expect(tuner.decision().concurrency).toBe(4);
      expect(sent.every((c) => c >= 1 && c <= 8)).toBe(true);
      expect(adaptations()).toContainEqual(
        expect.objectContaining({ kind: "concurrency", from: 8, to: 4, reason: "concurrency-probe" }),
      );
      const settle = adaptations().find((a) => a.reason === "concurrency-settle");
      expect(settle).toMatchObject({ kind: "concurrency", to: 4 });
      expect(settle?.charsPerSecond).toBeCloseTo(4000, 0);
    });

    it("converges to 1 on a serialising server", () => {
      const { tuner, waves } = makeClockedTuner();
      tuner.begin(REMOTE);
      waves(serialising, 60);
      expect(tuner.decision().concurrency).toBe(1);
    });

    it("climbs up from a low seed", () => {
      const { tuner, waves } = makeClockedTuner({ seedConcurrency: () => 1 });
      expect(tuner.begin(REMOTE).concurrency).toBe(1);
      waves(peakAt4, 60);
      expect(tuner.decision().concurrency).toBe(4);
    });

    it("starts at initialConcurrency without a seed and climbs up to the configured ceiling", () => {
      const { tuner, waves, adaptations } = makeClockedTuner({ configuredConcurrency: 8, initialConcurrency: 1 });
      expect(tuner.decision().concurrency).toBe(1);
      expect(tuner.begin(REMOTE).concurrency).toBe(1);
      expect(adaptations().some((a) => a.kind === "concurrency" && a.reason === "seed")).toBe(false);
      const sent = waves((c) => 1000 * c, 80);
      expect(Math.max(...sent)).toBe(8);
      expect(tuner.decision().concurrency).toBe(8);
    });

    it("clamps a stored concurrency to the configured ceiling, not to initialConcurrency", () => {
      const at = (seed: number) =>
        makeClockedTuner({ configuredConcurrency: 8, initialConcurrency: 1, seedConcurrency: () => seed }).tuner.begin(
          REMOTE,
        ).concurrency;
      expect(at(6)).toBe(6);
      expect(at(12)).toBe(8);
      expect(at(0)).toBe(1);
    });

    it("probes concurrency only after the batch size settles", () => {
      const { tuner, waves, adaptations } = makeClockedTuner();
      tuner.begin(REMOTE);
      waves(peakAt4, 40);
      const log = adaptations();
      const sizeSettle = log.findIndex((a) => a.reason === "settle");
      const firstProbe = log.findIndex((a) => a.reason === "concurrency-probe");
      expect(sizeSettle).toBeGreaterThanOrEqual(0);
      expect(firstProbe).toBeGreaterThan(sizeSettle);
    });

    it("persists the settled concurrency in the optimum", () => {
      const { tuner, waves } = makeClockedTuner();
      tuner.begin(REMOTE);
      waves(peakAt4, 40);
      expect(tuner.settledOptima()[0].optimum).toMatchObject({ batchSize: 256, concurrency: 4 });
    });

    it("measures from an explicit startedAt the same as from a derived one", () => {
      const { tuner, waves } = makeClockedTuner();
      tuner.begin(REMOTE);
      waves(peakAt4, 40, true);
      expect(tuner.decision().concurrency).toBe(4);
    });

    it("never counts a batch that started before the probe toward it", () => {
      const { tuner } = makeClockedTuner({ now: () => 5_000 });
      tuner.begin(REMOTE);
      // Each batch "started" before the clock the probe began at — it was in
      // flight under the previous decision, so nothing may settle: the size
      // probe is an aggregate window too, and it waits like the concurrency one.
      for (let i = 0; i < 200; i++) {
        const size = tuner.decision().batchSize;
        tuner.observe({ size, inputChars: size * CHARS_PER_TEXT, durationMs: 100, ok: true, endpoint: REMOTE });
      }
      expect(tuner.settledOptima()).toEqual([]);
      const log = tuner.drainAdaptations();
      expect(log.some((a) => a.reason === "settle")).toBe(false);
      expect(log.some((a) => a.reason === "concurrency-settle")).toBe(false);
      expect(tuner.decision().concurrency).toBe(8);
    });

    it("re-probes concurrency together with the batch size and follows a drifted server", () => {
      const { tuner, waves, adaptations } = makeClockedTuner({ reprobeAfterBatches: 50 });
      tuner.begin(REMOTE);
      waves(peakAt4, 12);
      expect(tuner.settledOptima()[0].optimum.concurrency).toBe(4);
      adaptations();
      waves(serialising, 120);
      const settles = adaptations().filter((a) => a.reason === "concurrency-settle");
      expect(settles.at(-1)?.to).toBe(1);
      expect(tuner.settledOptima()[0].optimum.concurrency).toBe(1);
    });

    it("returns to the working concurrency when a size failure interrupts a probe", () => {
      const { tuner, waves, adaptations } = makeClockedTuner();
      tuner.begin(REMOTE);
      // Run until the first concurrency probe moves off the working value.
      for (let i = 0; i < 40 && tuner.decision().concurrency === 8; i++) waves(peakAt4, 1);
      expect(tuner.decision().concurrency).toBe(4);
      tuner.observe({ size: 256, inputChars: 1, durationMs: 1, ok: false, endpoint: REMOTE });
      expect(tuner.decision()).toEqual({ batchSize: 128, concurrency: 8 });
      expect(adaptations()).toContainEqual(
        expect.objectContaining({ kind: "concurrency", from: 4, to: 8, reason: "failure" }),
      );
    });
  });

  /**
   * A tuner on a hand-driven clock. `serial` runs one full batch at the current
   * size from the clock on and moves the clock to its end; `waves` runs
   * `concurrency` overlapping batches per wave against `server(c, size)` — the
   * server's AGGREGATE chars/s at that point.
   */
  function makeHandClockedTuner(overrides: Partial<EmbeddingThroughputTunerConfig> = {}) {
    let clock = 2_000_000;
    const drained: EmbeddingThroughputAdaptation[] = [];
    const tuner = new EmbeddingThroughputTuner({
      ceiling: 256,
      floor: 16,
      configuredConcurrency: 1,
      samplesPerSize: 2,
      recoveryStreak: 1000,
      reprobeAfterBatches: 100_000,
      minImprovement: 0.05,
      now: () => clock,
      ...overrides,
    });
    tuner.begin(REMOTE);
    return {
      tuner,
      clock: (): number => clock,
      advance(ms: number): void {
        clock += ms;
      },
      adaptations: (): EmbeddingThroughputAdaptation[] => {
        drained.push(...tuner.drainAdaptations());
        return drained;
      },
      serial(durationMs: number): void {
        const size = tuner.decision().batchSize;
        const startedAt = clock;
        clock += durationMs;
        tuner.observe({ size, inputChars: size * CHARS_PER_TEXT, durationMs, startedAt, ok: true, endpoint: REMOTE });
      },
      waves(server: (concurrency: number, size: number) => number, count: number): void {
        for (let w = 0; w < count; w++) {
          const { batchSize, concurrency } = tuner.decision();
          const inputChars = batchSize * CHARS_PER_TEXT;
          const startedAt = clock;
          const durationMs = ((concurrency * inputChars) / server(concurrency, batchSize)) * 1000;
          clock = startedAt + durationMs;
          for (let i = 0; i < concurrency; i++) {
            tuner.observe({ size: batchSize, inputChars, durationMs, startedAt, ok: true, endpoint: REMOTE });
          }
        }
      },
    };
  }

  describe("aggregate size climb", () => {
    it("never counts a batch of the probed size that started before the size probe opened", () => {
      const run = makeHandClockedTuner();
      run.serial(1000);
      run.serial(1000);
      expect(run.tuner.decision().batchSize).toBe(128);
      // A 128 batch formed before the probe opened completes now: it is no sample of it.
      run.tuner.observe({
        size: 128,
        inputChars: 128 * CHARS_PER_TEXT,
        durationMs: 1000,
        startedAt: run.clock() - 1500,
        ok: true,
        endpoint: REMOTE,
      });
      run.serial(1000);
      expect(run.adaptations().some((a) => a.reason === "settle")).toBe(false);
      run.serial(1000);
      expect(run.adaptations()).toContainEqual(expect.objectContaining({ reason: "settle", to: 256 }));
    });

    it("judges a size only after samplesPerSize × concurrency full batches", () => {
      const run = makeHandClockedTuner({ configuredConcurrency: 4 });
      for (let i = 0; i < 7; i++) run.serial(1000);
      expect(run.tuner.decision().batchSize).toBe(256);
      run.serial(1000);
      expect(run.tuner.decision().batchSize).toBe(128);
    });

    it("measures a size on the wall span of its overlapping batches, not per call", () => {
      const run = makeHandClockedTuner({ configuredConcurrency: 4, samplesPerSize: 1 });
      // Four 256 batches in flight together: 1,024,000 chars in one second
      // aggregate, 256,000 chars/s per call.
      const startedAt = run.clock();
      run.advance(1000);
      for (let i = 0; i < 4; i++) {
        run.tuner.observe({
          size: 256,
          inputChars: 256 * CHARS_PER_TEXT,
          durationMs: 1000,
          startedAt,
          ok: true,
          endpoint: REMOTE,
        });
      }
      // Four 128 batches one after another: ~427k chars/s per call AND aggregate.
      // Per call 128 would win; on aggregate 256 does.
      for (let i = 0; i < 4; i++) run.serial(300);
      const settle = run.adaptations().find((a) => a.reason === "settle");
      expect(settle?.to).toBe(256);
      expect(settle?.charsPerSecond).toBeCloseTo(1_024_000, 0);
    });

    it("re-measures a size whose window was filled under another concurrency", () => {
      const run = makeHandClockedTuner({ configuredConcurrency: 8 });
      const SIZE: Record<number, number> = { 64: 0.6, 128: 0.8, 256: 1 };
      const CONCURRENCY: Record<number, number> = { 2: 0.5, 4: 1, 8: 0.8 };
      const server = (c: number, size: number) => 100_000 * (CONCURRENCY[c] ?? 0.1) * (SIZE[size] ?? 0.1);
      // Size climb at concurrency 8 measures 256 and 128 (16 batches each), then
      // the concurrency climb settles at 4.
      for (let i = 0; i < 40 && !run.adaptations().some((a) => a.reason === "concurrency-settle"); i++) {
        run.waves(server, 1);
      }
      expect(run.tuner.decision()).toEqual({ batchSize: 256, concurrency: 4 });
      run.tuner.observe({ size: 256, inputChars: 256_000, durationMs: 1000, ok: false, endpoint: REMOTE });
      expect(run.tuner.decision()).toEqual({ batchSize: 128, concurrency: 4 });
      // The 128 window holds 16 batches measured at concurrency 8 — enough for
      // samplesPerSize × 4, but not a measurement at 4: 128 is measured afresh.
      run.waves(server, 1);
      expect(run.tuner.decision()).toEqual({ batchSize: 128, concurrency: 4 });
      run.waves(server, 1);
      expect(run.tuner.decision()).toEqual({ batchSize: 64, concurrency: 4 });
    });
  });

  describe("endpoint failure", () => {
    it("taints the open window without touching the size cap", () => {
      const run = makeHandClockedTuner();
      run.serial(1000);
      run.tuner.noteEndpointFailure(REMOTE);
      expect(run.tuner.decision()).toEqual({ batchSize: 256, concurrency: 1 });
      run.serial(1000); // the 256 window completes — tainted, so no measured point
      run.serial(1000);
      run.serial(1000); // the 128 window completes untainted
      expect(run.adaptations().some((a) => a.reason === "failure")).toBe(false);
      expect(run.tuner.settledOptima()[0]?.optimum).toMatchObject({ batchSize: 128, measurement: "aggregate" });
    });
  });

  describe("best-point re-probe", () => {
    const BY_CONCURRENCY: Record<number, number> = { 1: 0.3, 2: 0.5, 4: 0.75, 8: 1 };
    const HEALTHY_BY_SIZE: Record<number, number> = { 16: 0.3, 32: 0.4, 64: 0.6, 128: 0.8, 256: 1 };
    const DEGRADED_BY_SIZE: Record<number, number> = { 16: 0.2, 32: 0.4, 64: 0.6, 128: 0.45, 256: 0.3 };
    /** 256×8 at 100k chars/s. */
    const healthy = (c: number, size: number) => 100_000 * (BY_CONCURRENCY[c] ?? 0.1) * (HEALTHY_BY_SIZE[size] ?? 0.1);
    /** 64×8 at 60k chars/s is the best a degraded server offers; 256×8 drops to 30k. */
    const degraded = (c: number, size: number) =>
      100_000 * (BY_CONCURRENCY[c] ?? 0.1) * (DEGRADED_BY_SIZE[size] ?? 0.1);
    const bestReprobes = (log: EmbeddingThroughputAdaptation[]) =>
      log.filter((a) => a.reason === "best-reprobe" && a.kind === "batchSize");

    /** Settle healthy at 256×8, fail a batch, and re-settle on the degraded server at 64×8. */
    function settledDegradedAfterHealthy(recoveryStreak = 16) {
      const run = makeHandClockedTuner({ configuredConcurrency: 8, recoveryStreak });
      for (let i = 0; i < 40 && !run.adaptations().some((a) => a.reason === "concurrency-settle"); i++) {
        run.waves(healthy, 1);
      }
      expect(run.tuner.decision()).toEqual({ batchSize: 256, concurrency: 8 });
      run.tuner.observe({ size: 256, inputChars: 256_000, durationMs: 1000, ok: false, endpoint: REMOTE });
      const settles = () => run.adaptations().filter((a) => a.reason === "concurrency-settle").length;
      for (let i = 0; i < 60 && settles() < 2; i++) run.waves(degraded, 1);
      expect(run.tuner.decision()).toEqual({ batchSize: 64, concurrency: 8 });
      return run;
    }

    it("jumps back to the run's best point after 64 settled batches and adopts it when faster", () => {
      const run = settledDegradedAfterHealthy();
      run.waves(degraded, 7);
      expect(bestReprobes(run.adaptations())).toHaveLength(0);
      run.waves(degraded, 1);
      expect(bestReprobes(run.adaptations())).toEqual([expect.objectContaining({ from: 64, to: 256 })]);
      expect(run.tuner.decision()).toEqual({ batchSize: 256, concurrency: 8 });
      run.waves(healthy, 30);
      expect(run.tuner.decision()).toEqual({ batchSize: 256, concurrency: 8 });
      expect(bestReprobes(run.adaptations()).some((a) => a.to === 64)).toBe(false);
    });

    it("reverts a slower best-point window and doubles the wait before the next jump", () => {
      const run = settledDegradedAfterHealthy();
      run.waves(degraded, 8);
      run.waves(degraded, 2);
      expect(run.tuner.decision()).toEqual({ batchSize: 64, concurrency: 8 });
      expect(bestReprobes(run.adaptations()).at(-1)).toMatchObject({ from: 256, to: 64 });
      const before = bestReprobes(run.adaptations()).length;
      run.waves(degraded, 15);
      expect(bestReprobes(run.adaptations())).toHaveLength(before);
      run.waves(degraded, 1);
      expect(bestReprobes(run.adaptations())).toHaveLength(before + 1);
      expect(run.tuner.decision()).toEqual({ batchSize: 256, concurrency: 8 });
    });

    it("abandons the re-probe on an endpoint failure without doubling the wait", () => {
      const run = settledDegradedAfterHealthy();
      run.waves(degraded, 8);
      expect(run.tuner.decision().batchSize).toBe(256);
      run.tuner.noteEndpointFailure(REMOTE);
      expect(run.tuner.decision()).toEqual({ batchSize: 64, concurrency: 8 });
      const before = bestReprobes(run.adaptations()).length;
      run.waves(degraded, 8);
      expect(bestReprobes(run.adaptations())).toHaveLength(before + 1);
      expect(run.tuner.decision().batchSize).toBe(256);
    });

    it("defers the jump while the cap is below the run-best size, then jumps once it recovers", () => {
      // The failure capped the size at 128 and the success streak doubles it back
      // only after 200 batches — long after the 64-batch wait elapses.
      const run = settledDegradedAfterHealthy(200);
      const settles = () => run.adaptations().filter((a) => a.reason === "settle").length;
      const settledBefore = settles();
      run.waves(degraded, 8);
      expect(bestReprobes(run.adaptations())).toHaveLength(0);
      expect(run.tuner.decision()).toEqual({ batchSize: 64, concurrency: 8 });
      // The cap recovers to 256: the size climb re-settles at 64.
      for (let i = 0; i < 16 && settles() === settledBefore; i++) run.waves(degraded, 1);
      expect(settles()).toBe(settledBefore + 1);
      expect(bestReprobes(run.adaptations())).toHaveLength(0);
      for (let i = 0; i < 16 && bestReprobes(run.adaptations()).length === 0; i++) run.waves(degraded, 1);
      expect(bestReprobes(run.adaptations())).toEqual([expect.objectContaining({ from: 64, to: 256 })]);
      expect(run.tuner.decision()).toEqual({ batchSize: 256, concurrency: 8 });
    });
  });
});

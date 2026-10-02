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
  isLoopbackEmbeddingEndpoint,
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

function makeTuner(overrides: Partial<EmbeddingThroughputTunerConfig> = {}) {
  const drained: EmbeddingThroughputAdaptation[] = [];
  const clock = Date.parse("2026-10-02T00:00:00.000Z");
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
  for (let i = 0; i < batches; i++) {
    const size = tuner.decision().batchSize;
    sent.push(size);
    const inputChars = size * CHARS_PER_TEXT;
    if (embedder.failAbove !== undefined && size > embedder.failAbove) {
      tuner.observe({ size, inputChars, durationMs: 1000, ok: false, endpoint });
      continue;
    }
    const durationMs = (inputChars / embedder.rate(size)) * 1000;
    tuner.observe({ size, inputChars, durationMs, ok: true, endpoint });
  }
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

  describe("concurrency by endpoint locality", () => {
    it.each([
      ["http://localhost:11434", true],
      ["http://127.0.0.1:11434", true],
      ["http://127.1.2.3:11434", true],
      ["http://[::1]:11434", true],
      ["http://192.168.1.71:11434", false],
      ["http://10.0.0.5:11434", false],
      ["https://api.openai.com/v1", false],
    ])("%s is loopback = %s", (url, expected) => {
      expect(isLoopbackEmbeddingEndpoint(url)).toBe(expected);
    });

    it("treats an absent or unparsable url as unknown", () => {
      expect(isLoopbackEmbeddingEndpoint(undefined)).toBeUndefined();
      expect(isLoopbackEmbeddingEndpoint("not a url")).toBeUndefined();
    });

    it("runs a local endpoint at concurrency 1 and a remote one at the configured concurrency", () => {
      expect(makeTuner().tuner.begin(LOCAL).concurrency).toBe(1);
      expect(makeTuner().tuner.begin(REMOTE).concurrency).toBe(4);
    });

    it("keeps the configured concurrency when the endpoint has no url", () => {
      expect(makeTuner().tuner.begin({ model: "onnx" }).concurrency).toBe(4);
    });

    it("re-evaluates concurrency and re-seeds the size when failover moves the active endpoint", () => {
      const { tuner, adaptations } = makeTuner({ seed: (e) => (e.url === LOCAL.url ? 32 : 128) });
      expect(tuner.begin(REMOTE)).toEqual({ batchSize: 128, concurrency: 4 });
      tuner.observe({ size: 128, inputChars: 1000, durationMs: 10, ok: true, endpoint: LOCAL });
      expect(tuner.decision()).toEqual({ batchSize: 32, concurrency: 1 });
      expect(adaptations()).toContainEqual(
        expect.objectContaining({ kind: "concurrency", from: 4, to: 1, reason: "endpoint-local" }),
      );
      tuner.observe({ size: 32, inputChars: 1000, durationMs: 10, ok: true, endpoint: REMOTE });
      expect(tuner.decision()).toEqual({ batchSize: 128, concurrency: 4 });
      expect(adaptations()).toContainEqual(
        expect.objectContaining({ kind: "concurrency", from: 1, to: 4, reason: "endpoint-remote" }),
      );
    });

    it("keeps a separate settled optimum per endpoint", () => {
      const { tuner } = makeTuner();
      tuner.begin(REMOTE);
      drive(tuner, { rate: peakedCurve(64) }, 40, REMOTE);
      tuner.observe({ size: 64, inputChars: 1, durationMs: 1, ok: true, endpoint: LOCAL });
      drive(tuner, { rate: peakedCurve(32) }, 40, LOCAL);
      const byUrl = Object.fromEntries(tuner.settledOptima().map((o) => [o.endpoint.url, o.optimum]));
      expect(byUrl[REMOTE.url!]).toMatchObject({ batchSize: 64, concurrency: 4 });
      expect(byUrl[LOCAL.url!]).toMatchObject({ batchSize: 32, concurrency: 1 });
    });
  });
});

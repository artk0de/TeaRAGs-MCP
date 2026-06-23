import { describe, expect, it } from "vitest";

import {
  computeEtaSeconds,
  OverallTimer,
  PhaseProgressTracker,
} from "../../../src/cli/index-progress/phase-tracker.js";

describe("computeEtaSeconds", () => {
  it.each([
    // applied, total, elapsedMs, expectedSeconds
    [50, 100, 1000, 1], // 50 units in 1s → 50 remaining → 1s
    [25, 100, 1000, 3], // 25 units in 1s → 75 remaining → 3s
    [100, 100, 5000, 0], // done → 0 remaining → 0s
  ])("applied=%i total=%i elapsed=%ims → %is", (applied, total, elapsedMs, expected) => {
    expect(computeEtaSeconds(applied, total, elapsedMs)).toBe(expected);
  });

  it("returns null when no throughput yet (applied=0)", () => {
    expect(computeEtaSeconds(0, 100, 1000)).toBeNull();
  });

  it("returns null when elapsed is zero (avoid divide-by-zero)", () => {
    expect(computeEtaSeconds(10, 100, 0)).toBeNull();
  });

  it("never returns a negative ETA when applied exceeds total", () => {
    expect(computeEtaSeconds(120, 100, 1000)).toBe(0);
  });
});

describe("PhaseProgressTracker", () => {
  it("returns etaSeconds for a single phase", () => {
    const t = new PhaseProgressTracker(0);
    t.record("embedding", 50, 100, 1000);
    // firstSeenMs=1000; at nowMs=2000 → elapsed=1000ms
    // applied=50, remaining=50, rate=0.05/ms → 50/0.05/1000 = 1s
    expect(t.etaSeconds("embedding", 2000)).toBe(1);
  });

  it("keeps only the latest record per phase (cumulative applied)", () => {
    const t = new PhaseProgressTracker(0);
    t.record("embedding", 10, 100, 500);
    t.record("embedding", 50, 100, 1000);
    // firstSeenMs=500; at nowMs=1000 → elapsed=500ms
    // applied=50, remaining=50, rate=0.1/ms → 50/0.1/1000 = 0.5s
    expect(t.etaSeconds("embedding", 1000)).toBeCloseTo(0.5, 5);
  });

  it("returns null before any record for a phase", () => {
    const t = new PhaseProgressTracker(0);
    expect(t.etaSeconds("embedding", 1000)).toBeNull();
  });

  it("returns null for unknown phase", () => {
    const t = new PhaseProgressTracker(0);
    t.record("embedding", 50, 100, 1000);
    expect(t.etaSeconds("enrichment", 1000)).toBeNull();
  });

  it("elapsedMs is per-phase wall-clock (first-record to now)", () => {
    const t = new PhaseProgressTracker(0);
    t.record("embedding", 10, 100, 1000);
    t.record("embedding", 50, 100, 3000);
    expect(t.elapsedMs("embedding", 3000)).toBe(2000); // 3000 - 1000
  });

  it("elapsedMs uses nowMs when later than last record", () => {
    const t = new PhaseProgressTracker(0);
    t.record("embedding", 50, 100, 1000);
    expect(t.elapsedMs("embedding", 4000)).toBe(3000); // 4000 - 1000
  });

  it("elapsedMs returns 0 for unknown phase", () => {
    const t = new PhaseProgressTracker(0);
    expect(t.elapsedMs("unknown", 5000)).toBe(0);
  });

  it("tracks multiple phases independently", () => {
    const t = new PhaseProgressTracker(0);
    t.record("embedding", 50, 100, 1000);
    t.record("enrichment", 10, 100, 2000);
    expect(t.elapsedMs("embedding", 3000)).toBe(2000); // 3000 - 1000
    expect(t.elapsedMs("enrichment", 3000)).toBe(1000); // 3000 - 2000
    // embedding: applied=50, total=100, elapsed=2000ms → rate 0.025/ms → remaining 50 → 2s
    expect(t.etaSeconds("embedding", 3000)).toBe(2);
    // enrichment: applied=10, total=100, elapsed=1000ms → rate 0.01/ms → remaining 90 → 9s
    expect(t.etaSeconds("enrichment", 3000)).toBe(9);
  });
});

describe("OverallTimer", () => {
  it("measures start→stop wall-clock, not a sum of phases", () => {
    const t = new OverallTimer(1000);
    t.stop(5000);
    expect(t.elapsedMs()).toBe(4000);
  });

  it("elapsedMs with nowMs when not yet stopped", () => {
    const t = new OverallTimer(1000);
    expect(t.elapsedMs(3000)).toBe(2000);
  });

  it("elapsedMs returns stop-based duration after stop()", () => {
    const t = new OverallTimer(0);
    t.stop(8000);
    // calling with nowMs after stop should still return start→stop
    expect(t.elapsedMs(99999)).toBe(8000);
  });

  it("elapsedMs returns 0 when not stopped and no nowMs", () => {
    const t = new OverallTimer(1000);
    // no nowMs, not stopped → 0
    expect(t.elapsedMs()).toBe(0);
  });
});

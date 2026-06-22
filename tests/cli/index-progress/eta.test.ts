import { describe, expect, it } from "vitest";

import { computeEtaSeconds, EnrichmentEtaTracker } from "../../../src/cli/index-progress/eta.js";

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

describe("EnrichmentEtaTracker", () => {
  it("aggregates remaining units across providers and levels", () => {
    const t = new EnrichmentEtaTracker(0); // startMs = 0
    t.record({ providerKey: "git", level: "file", applied: 10, total: 20 }, 1000);
    t.record({ providerKey: "git", level: "chunk", applied: 10, total: 30 }, 1000);
    // applied total = 20, total = 50, elapsed = 1000ms → rate 0.02/ms → remaining 30 → 1500ms → 1.5s
    expect(t.etaSeconds(1000)).toBeCloseTo(1.5, 5);
  });

  it("keeps only the latest event per provider+level (cumulative applied)", () => {
    const t = new EnrichmentEtaTracker(0);
    t.record({ providerKey: "git", level: "file", applied: 5, total: 20 }, 500);
    t.record({ providerKey: "git", level: "file", applied: 15, total: 20 }, 1000);
    // latest: applied 15 of 20, elapsed 1000 → remaining 5, rate 0.015/ms → 333ms → 0.333s
    expect(t.etaSeconds(1000)).toBeCloseTo(0.333, 2);
  });

  it("returns null before any event recorded", () => {
    const t = new EnrichmentEtaTracker(0);
    expect(t.etaSeconds(1000)).toBeNull();
  });
});

/**
 * CodegraphPhaseTimings (bd tea-rags-mcp-6aytq) — the observation-only
 * accumulator that attributes a codegraph enrichment run's wall clock to
 * pass-1 extraction, pass-2 resolve, DuckDB flush, checkpoint and metric
 * recompute, split per language where a language exists.
 *
 * The aggregation is what these tests pin: totals add up, language splits stay
 * separate, the summary shape is machine-parseable, and a nonsense duration can
 * never poison the numbers (this thing runs on a hot path in a diagnostics-only
 * role — it must degrade, never throw).
 */

import { describe, expect, it } from "vitest";

import { CodegraphPhaseTimings } from "../../../../../../src/core/domains/trajectory/codegraph/symbols/phase-timings.js";

/** Deterministic clock: each read advances by one millisecond unless set. */
function fakeClock(): { now: () => number; set: (ms: number) => void } {
  let value = 1000;
  return {
    now: () => value,
    set: (ms: number) => {
      value = ms;
    },
  };
}

describe("CodegraphPhaseTimings aggregation", () => {
  it("sums durations and counts per phase", () => {
    const timings = new CodegraphPhaseTimings();

    timings.record("pass2", 10);
    timings.record("pass2", 5);
    timings.record("flush", 40);

    const snapshot = timings.snapshot();
    expect(snapshot.phases.pass2).toEqual({ ms: 15, count: 2 });
    expect(snapshot.phases.flush).toEqual({ ms: 40, count: 1 });
  });

  it("reports every phase, zeroed when never recorded", () => {
    const snapshot = new CodegraphPhaseTimings().snapshot();

    expect(snapshot.phases.pass1).toEqual({ ms: 0, count: 0 });
    expect(snapshot.phases.pass2).toEqual({ ms: 0, count: 0 });
    expect(snapshot.phases.flush).toEqual({ ms: 0, count: 0 });
    expect(snapshot.phases.checkpoint).toEqual({ ms: 0, count: 0 });
    expect(snapshot.phases.metrics).toEqual({ ms: 0, count: 0 });
  });

  it("keeps per-language splits separate while still folding into the phase total", () => {
    const timings = new CodegraphPhaseTimings();

    timings.record("pass1", 100, { language: "typescript" });
    timings.record("pass1", 20, { language: "ruby" });
    timings.record("pass1", 30, { language: "typescript" });

    const snapshot = timings.snapshot();
    expect(snapshot.phases.pass1).toEqual({ ms: 150, count: 3 });
    expect(snapshot.byLanguage.pass1).toEqual({
      typescript: { ms: 130, count: 2 },
      ruby: { ms: 20, count: 1 },
    });
  });

  it("does not attribute an unlabelled record to any language", () => {
    const timings = new CodegraphPhaseTimings();

    timings.record("pass2", 7);

    expect(timings.snapshot().byLanguage.pass2).toEqual({});
  });

  it("honours an explicit count so a batched unit is one record", () => {
    const timings = new CodegraphPhaseTimings();

    timings.record("flush", 12, { count: 256 });

    expect(timings.snapshot().phases.flush).toEqual({ ms: 12, count: 256 });
  });

  it("counts recorded units per phase for progress cadence", () => {
    const timings = new CodegraphPhaseTimings();

    timings.record("pass1", 1, { language: "ruby" });
    timings.record("pass1", 1, { language: "ruby" });

    expect(timings.count("pass1")).toBe(2);
    expect(timings.count("metrics")).toBe(0);
  });

  it("clamps a negative or non-finite duration to zero instead of throwing", () => {
    const timings = new CodegraphPhaseTimings();

    timings.record("pass1", -5, { language: "go" });
    timings.record("pass1", Number.NaN, { language: "go" });

    const snapshot = timings.snapshot();
    expect(snapshot.phases.pass1).toEqual({ ms: 0, count: 2 });
    expect(snapshot.byLanguage.pass1.go).toEqual({ ms: 0, count: 2 });
  });

  it("measures elapsed wall clock from construction", () => {
    const clock = fakeClock();
    const timings = new CodegraphPhaseTimings(clock.now);

    clock.set(4200);

    expect(timings.elapsedMs()).toBe(3200);
    expect(timings.snapshot().elapsedMs).toBe(3200);
  });
});

describe("CodegraphPhaseTimings summary", () => {
  it("names pass units files and non-pass units calls", () => {
    const clock = fakeClock();
    const timings = new CodegraphPhaseTimings(clock.now);

    timings.record("pass1", 100, { language: "typescript" });
    timings.record("pass2", 50, { language: "typescript" });
    timings.record("flush", 40);
    timings.record("checkpoint", 30);
    timings.record("metrics", 20);
    clock.set(1500);

    expect(timings.toSummary()).toEqual({
      elapsedMs: 500,
      pass1: { ms: 100, files: 1, byLanguage: { typescript: { ms: 100, files: 1 } } },
      pass2: { ms: 50, files: 1, byLanguage: { typescript: { ms: 50, files: 1 } } },
      flush: { ms: 40, calls: 1 },
      checkpoint: { ms: 30, calls: 1 },
      metrics: { ms: 20, calls: 1 },
    });
  });

  it("omits byLanguage entirely when nothing carried a language", () => {
    const timings = new CodegraphPhaseTimings();

    timings.record("pass1", 9);

    expect(timings.toSummary().pass1).toEqual({ ms: 9, files: 1 });
  });

  it("serialises to a single parseable JSON line", () => {
    const timings = new CodegraphPhaseTimings();
    timings.record("pass1", 3, { language: "ruby" });

    const parsed = JSON.parse(timings.toJson()) as Record<string, { ms: number }>;

    expect(parsed.pass1.ms).toBe(3);
    expect(timings.toJson().includes("\n")).toBe(false);
  });
});

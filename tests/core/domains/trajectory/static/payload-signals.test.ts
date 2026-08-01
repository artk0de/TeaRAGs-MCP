/**
 * Symbol-mass descriptors — spec
 * docs/superpowers/specs/2026-08-01-risk-assessment-structural-axis-design.md §A.
 *
 * A signal without `stats.labels` is silently skipped by IndexMetricsQuery, so
 * the labels are the contract that makes these fields visible in
 * `get_index_metrics` and in the ranking overlay.
 */

import { describe, expect, it } from "vitest";

import type { PayloadSignalDescriptor } from "../../../../../src/core/contracts/types/trajectory.js";
import { BASE_PAYLOAD_SIGNALS } from "../../../../../src/core/domains/trajectory/static/payload-signals.js";

function descriptor(key: string): PayloadSignalDescriptor {
  const found = BASE_PAYLOAD_SIGNALS.find((s) => s.key === key);
  expect(found, `BASE_PAYLOAD_SIGNALS must declare "${key}"`).toBeDefined();
  return found as PayloadSignalDescriptor;
}

describe("symbol-mass payload signals", () => {
  it("labels memberCount by class-size tier, scoped to class chunks", () => {
    const sig = descriptor("memberCount");
    expect(sig.type).toBe("number");
    expect(sig.stats?.labels).toEqual({ p50: "typical", p75: "large", p95: "god-class" });
    expect(sig.stats?.chunkTypeFilter).toBe("class");
  });

  it("labels classLines by span tier, scoped to class chunks", () => {
    const sig = descriptor("classLines");
    expect(sig.type).toBe("number");
    expect(sig.stats?.labels).toEqual({ p50: "small", p75: "large", p95: "megaclass" });
    expect(sig.stats?.chunkTypeFilter).toBe("class");
  });

  it("labels fileSymbolCount by module-mass tier across every chunk type", () => {
    const sig = descriptor("fileSymbolCount");
    expect(sig.type).toBe("number");
    expect(sig.stats?.labels).toEqual({ p50: "typical", p75: "busy", p95: "god-module" });
    expect(sig.stats?.chunkTypeFilter).toBeUndefined();
  });

  it("computes fileSymbolCount percentiles over distinct files, not chunks", () => {
    // The value repeats on every chunk of a file; without per-file dedupe a
    // many-chunk file would dominate its own distribution.
    expect(descriptor("fileSymbolCount").stats?.dedupeByFile).toBe(true);
    expect(descriptor("memberCount").stats?.dedupeByFile).toBeUndefined();
  });
});

/**
 * Symbol-mass descriptors — spec
 * docs/superpowers/specs/2026-08-02-module-mass-signals-design.md.
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
  it("labels memberCount by container-size tier, unfiltered by chunk type", () => {
    const sig = descriptor("memberCount");
    expect(sig.type).toBe("number");
    expect(sig.stats?.labels).toEqual({ p50: "typical", p75: "large", p95: "god-module" });
    // The value exists only on each container's representative chunk, so a
    // chunkType filter would only re-narrow an already-narrow sample — and
    // filtering on "class" selected member-LESS classes exclusively.
    expect(sig.stats?.chunkTypeFilter).toBeUndefined();
  });

  it("labels moduleLines by file-size tier across every chunk type", () => {
    const sig = descriptor("moduleLines");
    expect(sig.type).toBe("number");
    expect(sig.stats?.labels).toEqual({ p50: "small", p75: "large", p95: "god-module" });
    expect(sig.stats?.chunkTypeFilter).toBeUndefined();
  });

  it("labels fileMethodCount by module-mass tier across every chunk type", () => {
    const sig = descriptor("fileMethodCount");
    expect(sig.type).toBe("number");
    expect(sig.stats?.labels).toEqual({ p50: "typical", p75: "busy", p95: "god-module" });
    expect(sig.stats?.chunkTypeFilter).toBeUndefined();
  });

  it("computes the file-scoped percentiles over distinct files, not chunks", () => {
    // The value repeats on every chunk of a file; without per-file dedupe a
    // many-chunk file would dominate its own distribution.
    expect(descriptor("fileMethodCount").stats?.dedupeByFile).toBe(true);
    expect(descriptor("moduleLines").stats?.dedupeByFile).toBe(true);
    // memberCount is stamped once per container, so it needs no dedupe.
    expect(descriptor("memberCount").stats?.dedupeByFile).toBeUndefined();
  });
});

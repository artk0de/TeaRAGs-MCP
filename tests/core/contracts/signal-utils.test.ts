import { describe, expect, it } from "vitest";

import {
  blend,
  computeAlpha,
  confidenceDampening,
  describeStatsSamplingContract,
  normalize,
  p95,
  toPhysicalPayloadKey,
} from "../../../src/core/contracts/signal-utils.js";
import type { PayloadSignalDescriptor } from "../../../src/core/contracts/types/trajectory.js";

describe("normalize", () => {
  it("normalizes value within range", () => {
    expect(normalize(50, 100)).toBe(0.5);
  });
  it("clamps to 1 when value exceeds max", () => {
    expect(normalize(150, 100)).toBe(1);
  });
  it("returns 0 when max is 0", () => {
    expect(normalize(10, 0)).toBe(0);
  });
});

describe("p95", () => {
  it("returns 1 for empty array", () => {
    expect(p95([])).toBe(1);
  });
  it("returns p95 of array", () => {
    const arr = Array.from({ length: 100 }, (_, i) => i + 1);
    expect(p95(arr)).toBeGreaterThanOrEqual(94);
  });
});

describe("computeAlpha", () => {
  it("returns 0 when chunkCount is 0", () => {
    expect(computeAlpha(0, 10)).toBe(0);
  });
  it("returns 0 when fileCount is 0", () => {
    expect(computeAlpha(5, 0)).toBe(0);
  });
  it("blends proportionally", () => {
    expect(computeAlpha(3, 3, 3)).toBe(1);
  });
});

describe("blend", () => {
  it("returns fileValue when chunkValue is undefined", () => {
    expect(blend(undefined, 0.8, 0.5)).toBe(0.8);
  });
  it("blends chunk and file values by alpha", () => {
    expect(blend(0.6, 0.4, 0.5)).toBeCloseTo(0.5);
  });
});

describe("confidenceDampening", () => {
  it("returns 1 when sampleCount >= threshold", () => {
    expect(confidenceDampening(10, 10)).toBe(1);
  });
  it("returns quadratic fraction for small samples", () => {
    expect(confidenceDampening(5, 10)).toBeCloseTo(0.25);
  });
});

describe("toPhysicalPayloadKey", () => {
  it("maps codegraph logical file key to nested symbols path", () => {
    expect(toPhysicalPayloadKey("codegraph.file.instability")).toBe("codegraph.symbols.file.instability");
  });
  it("maps codegraph logical chunk key to nested symbols path", () => {
    expect(toPhysicalPayloadKey("codegraph.chunk.fanIn")).toBe("codegraph.symbols.chunk.fanIn");
  });
  it("passes git keys through unchanged", () => {
    expect(toPhysicalPayloadKey("git.file.commitCount")).toBe("git.file.commitCount");
  });
  it("passes top-level static keys through unchanged", () => {
    expect(toPhysicalPayloadKey("isTest")).toBe("isTest");
  });
});

describe("describeStatsSamplingContract", () => {
  function signal(stats: PayloadSignalDescriptor["stats"]): PayloadSignalDescriptor {
    return { key: "git.file.bugFixRate", type: "number", description: "bug-fix share", stats };
  }

  // Dropping the test bucket changes WHICH values the stats file holds, so an
  // index built before the flip keeps stale test-scope percentiles unless the
  // drift axis can see the difference.
  it("moves when a signal stops sampling the test scope", () => {
    const before = describeStatsSamplingContract([signal({ labels: { p50: "healthy" } })]);
    const after = describeStatsSamplingContract([signal({ labels: { p50: "healthy" }, sourceScopeOnly: true })]);

    expect(after["git.file.bugFixRate"]).not.toBe(before["git.file.bugFixRate"]);
  });

  it("stays put when the declaration is unchanged", () => {
    const stats: PayloadSignalDescriptor["stats"] = { labels: { p50: "healthy" }, sourceScopeOnly: true };

    expect(describeStatsSamplingContract([signal(stats)])).toEqual(describeStatsSamplingContract([signal(stats)]));
  });

  // The support gate drops every unit the collection barely observed, so the
  // percentiles on disk describe a different population the moment it is
  // declared — and nothing about the numbers says so.
  it("moves when a signal starts gating on its support", () => {
    const before = describeStatsSamplingContract([signal({ labels: { p50: "healthy" } })]);
    const after = describeStatsSamplingContract([signal({ labels: { p50: "healthy" }, minSupportPercentile: 75 })]);

    expect(after["git.file.bugFixRate"]).not.toBe(before["git.file.bugFixRate"]);
  });

  it("moves again when the gate's percentile changes", () => {
    const at75 = describeStatsSamplingContract([signal({ labels: { p50: "healthy" }, minSupportPercentile: 75 })]);
    const at50 = describeStatsSamplingContract([signal({ labels: { p50: "healthy" }, minSupportPercentile: 50 })]);

    expect(at50["git.file.bugFixRate"]).not.toBe(at75["git.file.bugFixRate"]);
  });

  it("stays put when the support gate is unchanged", () => {
    const stats: PayloadSignalDescriptor["stats"] = { labels: { p50: "healthy" }, minSupportPercentile: 75 };

    expect(describeStatsSamplingContract([signal(stats)])).toEqual(describeStatsSamplingContract([signal(stats)]));
  });
  // Structural atoms leave the sample, so the percentiles on disk describe a
  // different population once they are declared.
  it("moves when a signal starts dropping structural atoms", () => {
    const before = describeStatsSamplingContract([signal({ labels: { p50: "healthy" } })]);
    const after = describeStatsSamplingContract([signal({ labels: { p50: "healthy" }, structuralAtoms: [0, 1] })]);

    expect(after["git.file.bugFixRate"]).not.toBe(before["git.file.bugFixRate"]);
  });

  it("moves again when the atom set changes", () => {
    const both = describeStatsSamplingContract([signal({ labels: { p50: "healthy" }, structuralAtoms: [0, 1] })]);
    const one = describeStatsSamplingContract([signal({ labels: { p50: "healthy" }, structuralAtoms: [1] })]);

    expect(one["git.file.bugFixRate"]).not.toBe(both["git.file.bugFixRate"]);
  });

  it("does not move when the atoms are declared in another order", () => {
    const ordered = describeStatsSamplingContract([signal({ labels: { p50: "healthy" }, structuralAtoms: [0, 1] })]);
    const reversed = describeStatsSamplingContract([signal({ labels: { p50: "healthy" }, structuralAtoms: [1, 0] })]);

    expect(reversed).toEqual(ordered);
  });

  // An existing index's stamp was written without the term. A signal that
  // declares no atoms samples exactly what it sampled before, so its stamp must
  // not change either — otherwise every signal on every index reports drift
  // for a recompute that could not move a single digit.
  it("leaves the stamp of a signal that declares no atoms unchanged", () => {
    const stamp = describeStatsSamplingContract([signal({ labels: { p50: "healthy" } })])["git.file.bugFixRate"];

    expect(stamp).toBe(
      "p=50 chunkTypes=* perFile=false zeroCounts=false sourceOnly=false minSupport=* mean=false stddev=false",
    );
  });

  it("treats an empty atom set as no atoms", () => {
    const none = describeStatsSamplingContract([signal({ labels: { p50: "healthy" } })]);
    const empty = describeStatsSamplingContract([signal({ labels: { p50: "healthy" }, structuralAtoms: [] })]);

    expect(empty).toEqual(none);
  });
});

import { describe, expect, it } from "vitest";

import { StaticTrajectory } from "../../../../../src/core/domains/trajectory/static/index.js";

describe("StaticTrajectory", () => {
  const trajectory = new StaticTrajectory();

  it("has key 'static'", () => {
    expect(trajectory.key).toBe("static");
  });

  it("has no enrichment provider", () => {
    expect(trajectory.enrichment).toBeUndefined();
  });

  it("has payload signals including base fields", () => {
    const keys = trajectory.payloadSignals.map((s) => s.key);
    expect(keys).toContain("relativePath");
    expect(keys).toContain("language");
    expect(keys).toContain("methodLines");
    expect(keys).toContain("methodDensity");
    expect(keys).toContain("contentSize");
    expect(keys).toContain("isTest");
  });

  it("has 7 derived signals", () => {
    expect(trajectory.derivedSignals).toHaveLength(7);
    const names = trajectory.derivedSignals.map((d) => d.name);
    expect(names).toContain("similarity");
    expect(names).toContain("chunkSize");
    expect(names).toContain("chunkDensity");
    expect(names).toContain("headingRelevance");
  });

  it("has 3 presets", () => {
    expect(trajectory.presets).toHaveLength(3);
    expect(trajectory.presets.map((p) => p.name)).toContain("relevance");
    expect(trajectory.presets.map((p) => p.name)).toContain("decomposition");
    expect(trajectory.presets.map((p) => p.name)).toContain("documentationRelevance");
  });

  it("has 7 static filters", () => {
    expect(trajectory.filters).toHaveLength(7);
    expect(trajectory.filters.map((f) => f.param)).toEqual(
      expect.arrayContaining([
        "language",
        "fileExtension",
        "chunkType",
        "documentation",
        "testFile",
        "pathPattern",
        "symbolId",
      ]),
    );
  });
});

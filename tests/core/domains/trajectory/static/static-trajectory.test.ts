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
  });

  it("has 6 derived signals", () => {
    expect(trajectory.derivedSignals).toHaveLength(6);
    const names = trajectory.derivedSignals.map((d) => d.name);
    expect(names).toContain("similarity");
    expect(names).toContain("chunkSize");
    expect(names).toContain("chunkDensity");
  });

  it("has 2 presets", () => {
    expect(trajectory.presets).toHaveLength(2);
    expect(trajectory.presets.map((p) => p.name)).toContain("relevance");
    expect(trajectory.presets.map((p) => p.name)).toContain("decomposition");
  });

  it("has 6 static filters", () => {
    expect(trajectory.filters).toHaveLength(6);
    expect(trajectory.filters.map((f) => f.param)).toEqual(
      expect.arrayContaining(["language", "fileExtension", "chunkType", "documentation", "pathPattern", "symbolId"]),
    );
  });
});

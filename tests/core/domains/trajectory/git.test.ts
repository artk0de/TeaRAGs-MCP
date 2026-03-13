import { describe, expect, it } from "vitest";

import { GitTrajectory } from "../../../../src/core/domains/trajectory/git.js";

describe("GitTrajectory", () => {
  const trajectory = new GitTrajectory();

  it("has key 'git'", () => {
    expect(trajectory.key).toBe("git");
  });

  it("has name and description", () => {
    expect(trajectory.name).toBeTruthy();
    expect(trajectory.description).toBeTruthy();
  });

  it("exposes payloadSignals", () => {
    expect(trajectory.payloadSignals.length).toBeGreaterThan(0);
    expect(trajectory.payloadSignals[0]).toHaveProperty("key");
    expect(trajectory.payloadSignals[0]).toHaveProperty("type");
  });

  it("exposes derivedSignals", () => {
    expect(trajectory.derivedSignals.length).toBeGreaterThan(0);
  });

  it("exposes filters", () => {
    expect(trajectory.filters.length).toBeGreaterThan(0);
  });

  it("exposes presets", () => {
    expect(trajectory.presets.length).toBeGreaterThan(0);
  });

  it("exposes enrichment provider (ISP)", () => {
    expect(trajectory.enrichment).toBeDefined();
    expect(typeof trajectory.enrichment.resolveRoot).toBe("function");
    expect(typeof trajectory.enrichment.buildFileSignals).toBe("function");
  });
});

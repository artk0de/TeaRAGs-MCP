import { describe, expect, it } from "vitest";

import type { CompositeScorer } from "../../../src/core/api/scorer.js";
import { createCompositeScorers } from "../../../src/core/api/scorers.js";

describe("createCompositeScorers", () => {
  it("should return an array of CompositeScorer instances", () => {
    const composites = createCompositeScorers();
    expect(Array.isArray(composites)).toBe(true);
    expect(composites.length).toBeGreaterThanOrEqual(2);
  });

  it("should include TechDebtScorer and HotspotScorer", () => {
    const composites = createCompositeScorers();
    const names = composites.map((c) => c.name);
    expect(names).toContain("techDebt");
    expect(names).toContain("hotspot");
  });

  it("should return class instances (not plain objects)", () => {
    const composites = createCompositeScorers();
    for (const c of composites) {
      expect(c.constructor.name).not.toBe("Object");
    }
  });

  it("should have all required CompositeScorer properties", () => {
    const composites = createCompositeScorers();
    for (const c of composites) {
      expect(typeof c.name).toBe("string");
      expect(typeof c.description).toBe("string");
      expect(typeof c.extract).toBe("function");
      expect(typeof c.bind).toBe("function");
      expect(Array.isArray(c.dependencies)).toBe(true);
      expect(c.dependencies.length).toBeGreaterThan(0);
    }
  });

  it("should all return 0 before bind() is called", () => {
    const composites = createCompositeScorers();
    for (const c of composites) {
      expect(c.extract({})).toBe(0);
    }
  });

  it("should return new instances on each call (not singletons)", () => {
    const a = createCompositeScorers();
    const b = createCompositeScorers();
    expect(a[0]).not.toBe(b[0]);
  });

  it("should be assignable to CompositeScorer[]", () => {
    const composites: CompositeScorer[] = createCompositeScorers();
    expect(composites).toBeDefined();
  });
});

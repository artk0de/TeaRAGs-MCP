import { describe, expect, it } from "vitest";

import type { CompositeScorer, Scorer } from "../../../src/core/api/scorer.js";

describe("Scorer interface", () => {
  it("should allow creating a concrete Scorer implementation", () => {
    const scorer: Scorer = {
      name: "testScorer",
      description: "A test scorer",
      extract: (_payload: Record<string, unknown>) => 0.5,
    };

    expect(scorer.name).toBe("testScorer");
    expect(scorer.description).toBe("A test scorer");
    expect(scorer.extract({})).toBe(0.5);
  });

  it("should support optional defaultBound", () => {
    const scorer: Scorer = {
      name: "bounded",
      description: "Scorer with bound",
      defaultBound: 100,
      extract: () => 0,
    };

    expect(scorer.defaultBound).toBe(100);
  });

  it("should support optional needsConfidence flag", () => {
    const scorer: Scorer = {
      name: "confident",
      description: "Needs confidence",
      needsConfidence: true,
      confidenceField: "commitCount",
      extract: () => 0,
    };

    expect(scorer.needsConfidence).toBe(true);
    expect(scorer.confidenceField).toBe("commitCount");
  });

  it("should allow needsConfidence=false without confidenceField", () => {
    const scorer: Scorer = {
      name: "noConfidence",
      description: "No confidence needed",
      needsConfidence: false,
      extract: () => 0.7,
    };

    expect(scorer.needsConfidence).toBe(false);
    expect(scorer.confidenceField).toBeUndefined();
  });
});

describe("CompositeScorer interface", () => {
  it("should extend Scorer with dependencies and bind", () => {
    const leafA: Scorer = {
      name: "a",
      description: "leaf A",
      extract: () => 0.4,
    };

    const leafB: Scorer = {
      name: "b",
      description: "leaf B",
      extract: () => 0.6,
    };

    let bound = false;
    const composite: CompositeScorer = {
      name: "composite",
      description: "A composite scorer",
      dependencies: ["a", "b"],
      bind(scorers: Map<string, Scorer>) {
        bound = true;
        expect(scorers.get("a")).toBeDefined();
        expect(scorers.get("b")).toBeDefined();
      },
      extract: () => 0.5,
    };

    expect(composite.dependencies).toEqual(["a", "b"]);

    const scorerMap = new Map<string, Scorer>();
    scorerMap.set("a", leafA);
    scorerMap.set("b", leafB);
    composite.bind(scorerMap);

    expect(bound).toBe(true);
  });

  it("should be assignable to Scorer (structural subtype)", () => {
    const composite: CompositeScorer = {
      name: "comp",
      description: "composite",
      dependencies: ["x"],
      bind: () => {},
      extract: () => 0,
    };

    // CompositeScorer must be assignable to Scorer
    const asScorer: Scorer = composite;
    expect(asScorer.name).toBe("comp");
    expect(asScorer.extract({})).toBe(0);
  });

  it("should support defaultBound on CompositeScorer", () => {
    const composite: CompositeScorer = {
      name: "comp",
      description: "composite with bound",
      defaultBound: 50,
      dependencies: ["x"],
      bind: () => {},
      extract: () => 0,
    };

    expect(composite.defaultBound).toBe(50);
  });
});

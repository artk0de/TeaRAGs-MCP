import { describe, expect, it } from "vitest";

import type { Scorer } from "../../../../src/core/api/scorer.js";
import { HotspotScorer } from "../../../../src/core/search/scorers/hotspot.js";

describe("HotspotScorer", () => {
  it("should implement CompositeScorer interface", () => {
    const scorer = new HotspotScorer();
    expect(scorer.name).toBe("hotspot");
    expect(typeof scorer.description).toBe("string");
    expect(typeof scorer.extract).toBe("function");
    expect(typeof scorer.bind).toBe("function");
    expect(scorer.dependencies).toEqual(["churn", "bugFix", "burstActivity"]);
  });

  it("should be a class instance (not a plain object)", () => {
    const scorer = new HotspotScorer();
    expect(scorer.constructor.name).toBe("HotspotScorer");
  });

  it("should return 0 before bind() is called (empty sources)", () => {
    const scorer = new HotspotScorer();
    expect(scorer.extract({})).toBe(0);
  });

  it("should compute churn * 0.4 + bugFix * 0.3 + burstActivity * 0.3 after binding", () => {
    const scorer = new HotspotScorer();

    const map = new Map<string, Scorer>();
    map.set("churn", { name: "churn", description: "", extract: () => 0.5 });
    map.set("bugFix", { name: "bugFix", description: "", extract: () => 0.6 });
    map.set("burstActivity", { name: "burstActivity", description: "", extract: () => 0.8 });
    scorer.bind(map);

    // 0.5 * 0.4 + 0.6 * 0.3 + 0.8 * 0.3 = 0.2 + 0.18 + 0.24 = 0.62
    expect(scorer.extract({})).toBeCloseTo(0.62, 5);
  });

  it("should pass payload through to leaf scorers", () => {
    const scorer = new HotspotScorer();
    const payloads: Record<string, unknown>[] = [];

    const map = new Map<string, Scorer>();
    map.set("churn", {
      name: "churn",
      description: "",
      extract: (p) => {
        payloads.push(p);
        return 0;
      },
    });
    map.set("bugFix", {
      name: "bugFix",
      description: "",
      extract: (p) => {
        payloads.push(p);
        return 0;
      },
    });
    map.set("burstActivity", {
      name: "burstActivity",
      description: "",
      extract: (p) => {
        payloads.push(p);
        return 0;
      },
    });
    scorer.bind(map);

    const testPayload = { foo: "bar" };
    scorer.extract(testPayload);
    expect(payloads).toHaveLength(3);
    expect(payloads.every((p) => p === testPayload)).toBe(true);
  });

  it("should handle edge case: all leaf scorers return 0", () => {
    const scorer = new HotspotScorer();
    const map = new Map<string, Scorer>();
    map.set("churn", { name: "churn", description: "", extract: () => 0 });
    map.set("bugFix", { name: "bugFix", description: "", extract: () => 0 });
    map.set("burstActivity", { name: "burstActivity", description: "", extract: () => 0 });
    scorer.bind(map);

    expect(scorer.extract({})).toBe(0);
  });

  it("should handle edge case: all leaf scorers return 1", () => {
    const scorer = new HotspotScorer();
    const map = new Map<string, Scorer>();
    map.set("churn", { name: "churn", description: "", extract: () => 1 });
    map.set("bugFix", { name: "bugFix", description: "", extract: () => 1 });
    map.set("burstActivity", { name: "burstActivity", description: "", extract: () => 1 });
    scorer.bind(map);

    // 1 * 0.4 + 1 * 0.3 + 1 * 0.3 = 1.0
    expect(scorer.extract({})).toBeCloseTo(1.0, 5);
  });

  it("should be assignable to Scorer", () => {
    const scorer: Scorer = new HotspotScorer();
    expect(scorer.name).toBe("hotspot");
  });
});

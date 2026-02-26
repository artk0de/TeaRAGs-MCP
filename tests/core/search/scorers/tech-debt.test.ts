import { describe, expect, it } from "vitest";

import type { Scorer } from "../../../../src/core/api/scorer.js";
import { TechDebtScorer } from "../../../../src/core/search/scorers/tech-debt.js";

describe("TechDebtScorer", () => {
  it("should implement CompositeScorer interface", () => {
    const scorer = new TechDebtScorer();
    expect(scorer.name).toBe("techDebt");
    expect(typeof scorer.description).toBe("string");
    expect(typeof scorer.extract).toBe("function");
    expect(typeof scorer.bind).toBe("function");
    expect(scorer.dependencies).toEqual(["age", "churn"]);
  });

  it("should be a class instance (not a plain object)", () => {
    const scorer = new TechDebtScorer();
    expect(scorer.constructor.name).toBe("TechDebtScorer");
  });

  it("should return 0 before bind() is called (empty sources)", () => {
    const scorer = new TechDebtScorer();
    expect(scorer.extract({})).toBe(0);
  });

  it("should compute age * 0.4 + churn * 0.6 after binding", () => {
    const scorer = new TechDebtScorer();

    const mockAge: Scorer = {
      name: "age",
      description: "mock age",
      extract: () => 0.5,
    };
    const mockChurn: Scorer = {
      name: "churn",
      description: "mock churn",
      extract: () => 0.8,
    };

    const map = new Map<string, Scorer>();
    map.set("age", mockAge);
    map.set("churn", mockChurn);
    scorer.bind(map);

    // 0.5 * 0.4 + 0.8 * 0.6 = 0.2 + 0.48 = 0.68
    expect(scorer.extract({})).toBeCloseTo(0.68, 5);
  });

  it("should pass payload through to leaf scorers", () => {
    const scorer = new TechDebtScorer();
    const payloads: Record<string, unknown>[] = [];

    const mockAge: Scorer = {
      name: "age",
      description: "mock age",
      extract: (p) => {
        payloads.push(p);
        return 0.3;
      },
    };
    const mockChurn: Scorer = {
      name: "churn",
      description: "mock churn",
      extract: (p) => {
        payloads.push(p);
        return 0.7;
      },
    };

    const map = new Map<string, Scorer>();
    map.set("age", mockAge);
    map.set("churn", mockChurn);
    scorer.bind(map);

    const testPayload = { git: { file: { ageDays: 100 } } };
    scorer.extract(testPayload);

    expect(payloads).toHaveLength(2);
    expect(payloads[0]).toBe(testPayload);
    expect(payloads[1]).toBe(testPayload);
  });

  it("should handle edge case: both leaf scorers return 0", () => {
    const scorer = new TechDebtScorer();
    const map = new Map<string, Scorer>();
    map.set("age", { name: "age", description: "", extract: () => 0 });
    map.set("churn", { name: "churn", description: "", extract: () => 0 });
    scorer.bind(map);

    expect(scorer.extract({})).toBe(0);
  });

  it("should handle edge case: both leaf scorers return 1", () => {
    const scorer = new TechDebtScorer();
    const map = new Map<string, Scorer>();
    map.set("age", { name: "age", description: "", extract: () => 1 });
    map.set("churn", { name: "churn", description: "", extract: () => 1 });
    scorer.bind(map);

    // 1 * 0.4 + 1 * 0.6 = 1.0
    expect(scorer.extract({})).toBeCloseTo(1.0, 5);
  });

  it("should be assignable to Scorer", () => {
    const scorer: Scorer = new TechDebtScorer();
    expect(scorer.name).toBe("techDebt");
  });
});

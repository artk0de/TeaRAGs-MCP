import { describe, expect, it } from "vitest";

import { gitDerivedSignals } from "../../../../src/core/trajectory/git/signals.js";

describe("gitDerivedSignals", () => {
  const fakePayload = (git?: Record<string, unknown>) =>
    ({ relativePath: "a.ts", startLine: 1, endLine: 50, git }) as Record<string, unknown>;

  it("has 14 derived signal descriptors", () => {
    expect(gitDerivedSignals).toHaveLength(14);
  });

  it("every descriptor has name, description, non-empty sources, and extract function", () => {
    for (const d of gitDerivedSignals) {
      expect(d.name).toBeTruthy();
      expect(d.description).toBeTruthy();
      expect(d.sources.length).toBeGreaterThan(0);
      expect(typeof d.extract).toBe("function");
    }
  });

  it("extract returns 0-1 for all descriptors given valid data", () => {
    const payload = fakePayload({
      file: {
        ageDays: 100,
        commitCount: 10,
        bugFixRate: 30,
        dominantAuthorPct: 80,
        churnVolatility: 20,
        changeDensity: 8,
        relativeChurn: 2.0,
        recencyWeightedFreq: 5,
        contributorCount: 2,
      },
      chunk: { commitCount: 5, churnRatio: 0.3 },
    });
    for (const d of gitDerivedSignals) {
      const val = d.extract(payload);
      expect(val, `${d.name} should be >= 0`).toBeGreaterThanOrEqual(0);
      expect(val, `${d.name} should be <= 1`).toBeLessThanOrEqual(1);
    }
  });

  it("extract returns 0-1 for empty payload (no git data)", () => {
    const payload = fakePayload();
    for (const d of gitDerivedSignals) {
      const val = d.extract(payload);
      expect(val, `${d.name} should be >= 0`).toBeGreaterThanOrEqual(0);
      expect(val, `${d.name} should be <= 1`).toBeLessThanOrEqual(1);
    }
  });

  describe("individual signals", () => {
    it("recency: 1 - ageDays/365", () => {
      const d = gitDerivedSignals.find((s) => s.name === "recency")!;
      expect(d.sources).toContain("ageDays");
      const val = d.extract(fakePayload({ file: { ageDays: 182.5 } }));
      expect(val).toBeCloseTo(0.5, 2);
    });

    it("churn: commitCount/50", () => {
      const d = gitDerivedSignals.find((s) => s.name === "churn")!;
      expect(d.sources).toContain("commitCount");
      expect(d.extract(fakePayload({ file: { commitCount: 25 } }))).toBeCloseTo(0.5, 2);
    });

    it("ownership: from dominantAuthorPct", () => {
      const d = gitDerivedSignals.find((s) => s.name === "ownership")!;
      expect(d.sources).toContain("dominantAuthorPct");
      expect(d.sources).toContain("authors");
      const val = d.extract(fakePayload({ file: { dominantAuthorPct: 80 } }));
      expect(val).toBeCloseTo(0.8, 2);
    });

    it("ownership: from authors array when no dominantAuthorPct", () => {
      const d = gitDerivedSignals.find((s) => s.name === "ownership")!;
      expect(d.extract(fakePayload({ file: { authors: ["a", "b"] } }))).toBeCloseTo(0.5, 2);
    });

    it("knowledgeSilo: categorical from contributorCount", () => {
      const d = gitDerivedSignals.find((s) => s.name === "knowledgeSilo")!;
      expect(d.extract(fakePayload({ file: { contributorCount: 1 } }))).toBeCloseTo(1.0);
      expect(d.extract(fakePayload({ file: { contributorCount: 2 } }))).toBeCloseTo(0.5);
      expect(d.extract(fakePayload({ file: { contributorCount: 5 } }))).toBe(0);
    });

    it("blockPenalty: 1 for block without chunk data, 0 for non-block", () => {
      const d = gitDerivedSignals.find((s) => s.name === "blockPenalty")!;
      expect(d.extract({ ...fakePayload({ file: { commitCount: 10 } }), chunkType: "block" })).toBeCloseTo(1.0);
      expect(d.extract({ ...fakePayload({ file: { commitCount: 10 } }), chunkType: "function" })).toBe(0);
    });

    it("chunkChurn: normalize chunk.commitCount", () => {
      const d = gitDerivedSignals.find((s) => s.name === "chunkChurn")!;
      expect(d.extract(fakePayload({ chunk: { commitCount: 15 } }))).toBeCloseTo(0.5, 2);
    });

    it("burstActivity: from recencyWeightedFreq", () => {
      const d = gitDerivedSignals.find((s) => s.name === "burstActivity")!;
      expect(d.extract(fakePayload({ file: { recencyWeightedFreq: 5.0 } }))).toBeCloseTo(0.5, 2);
    });

    it("supports flat git format (backward compat)", () => {
      const d = gitDerivedSignals.find((s) => s.name === "recency")!;
      // flat format: git fields at root level, no file/chunk nesting
      expect(d.extract(fakePayload({ ageDays: 182.5 }))).toBeCloseTo(0.5, 2);
    });
  });
});

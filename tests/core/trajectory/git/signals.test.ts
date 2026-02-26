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

  describe("individual signals (file-only, no blending)", () => {
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

    it("chunkChurn: 0 when no file commitCount (alpha=0)", () => {
      const d = gitDerivedSignals.find((s) => s.name === "chunkChurn")!;
      // chunkChurn is dampened by alpha. No file commitCount → alpha=0 → 0
      expect(d.extract(fakePayload({ chunk: { commitCount: 15 } }))).toBe(0);
    });

    it("chunkChurn: normalized and alpha-dampened when both file+chunk exist", () => {
      const d = gitDerivedSignals.find((s) => s.name === "chunkChurn")!;
      // file: 20 commits, chunk: 10 commits
      // alpha = min(1, (10/20) * min(1, 10/3)) = min(1, 0.5 * 1) = 0.5
      // chunkChurn = normalize(10, 30) * alpha = 0.333 * 0.5 = 0.167
      const val = d.extract(fakePayload({ file: { commitCount: 20 }, chunk: { commitCount: 10 } }));
      expect(val).toBeCloseTo(0.167, 2);
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

  describe("L3 alpha-blending", () => {
    const byName = (n: string) => gitDerivedSignals.find((s) => s.name === n)!;

    it("recency blends chunk+file ageDays when chunk data exists", () => {
      // file: ageDays=200, commitCount=20
      // chunk: ageDays=50, commitCount=10
      // alpha = min(1, (10/20) * min(1, 10/3)) = min(1, 0.5 * 1) = 0.5
      // effectiveAge = 0.5 * 50 + 0.5 * 200 = 125
      // recency = 1 - 125/365 = 0.6575
      const payload = fakePayload({
        file: { ageDays: 200, commitCount: 20 },
        chunk: { ageDays: 50, commitCount: 10 },
      });
      expect(byName("recency").extract(payload)).toBeCloseTo(0.6575, 2);
    });

    it("stability blends chunk+file commitCount", () => {
      // file: commitCount=40, chunk: commitCount=10
      // alpha = min(1, (10/40) * min(1, 10/3)) = min(1, 0.25 * 1) = 0.25
      // effectiveCC = 0.25 * 10 + 0.75 * 40 = 32.5
      // stability = 1 - 32.5/50 = 0.35
      const payload = fakePayload({
        file: { commitCount: 40 },
        chunk: { commitCount: 10 },
      });
      expect(byName("stability").extract(payload)).toBeCloseTo(0.35, 2);
    });

    it("maturity factor reduces alpha for low chunk commits", () => {
      // file: commitCount=20, chunk: commitCount=2 (below CHUNK_MATURITY_THRESHOLD=3)
      // alpha = min(1, (2/20) * min(1, 2/3)) = min(1, 0.1 * 0.667) = 0.0667
      // vs without maturity: alpha = min(1, 2/20) = 0.1
      const payload = fakePayload({
        file: { ageDays: 100, commitCount: 20 },
        chunk: { ageDays: 10, commitCount: 2 },
      });
      // effectiveAge = 0.0667 * 10 + 0.9333 * 100 = 94.0
      // recency = 1 - 94.0/365 = 0.7425
      expect(byName("recency").extract(payload)).toBeCloseTo(0.7425, 2);
    });

    it("alpha=0 when chunk commitCount=0, falls back to file only", () => {
      const payload = fakePayload({
        file: { ageDays: 200, commitCount: 20 },
        chunk: { ageDays: 10, commitCount: 0 },
      });
      // alpha=0 → pure file: recency = 1 - 200/365 = 0.4521
      expect(byName("recency").extract(payload)).toBeCloseTo(0.4521, 2);
    });

    it("bugFix blends file+chunk bugFixRate", () => {
      // file: bugFixRate=80, commitCount=20
      // chunk: bugFixRate=40, commitCount=10
      // alpha = min(1, (10/20) * min(1, 10/3)) = 0.5
      // effectiveBFR = 0.5 * 40 + 0.5 * 80 = 60
      // bugFix = 60/100 = 0.6
      const payload = fakePayload({
        file: { bugFixRate: 80, commitCount: 20 },
        chunk: { bugFixRate: 40, commitCount: 10 },
      });
      expect(byName("bugFix").extract(payload)).toBeCloseTo(0.6, 2);
    });

    it("density blends file+chunk changeDensity", () => {
      // file: changeDensity=10, commitCount=20
      // chunk: changeDensity=4, commitCount=10
      // alpha = 0.5
      // effectiveDensity = 0.5 * 4 + 0.5 * 10 = 7
      // density = 7/20 = 0.35
      const payload = fakePayload({
        file: { changeDensity: 10, commitCount: 20 },
        chunk: { changeDensity: 4, commitCount: 10 },
      });
      expect(byName("density").extract(payload)).toBeCloseTo(0.35, 2);
    });

    it("burstActivity blends file+chunk recencyWeightedFreq", () => {
      // file: recencyWeightedFreq=8, commitCount=20
      // chunk: recencyWeightedFreq=2, commitCount=10
      // alpha = 0.5
      // effective = 0.5 * 2 + 0.5 * 8 = 5
      // burstActivity = 5/10 = 0.5
      const payload = fakePayload({
        file: { recencyWeightedFreq: 8, commitCount: 20 },
        chunk: { recencyWeightedFreq: 2, commitCount: 10 },
      });
      expect(byName("burstActivity").extract(payload)).toBeCloseTo(0.5, 2);
    });

    it("chunkRelativeChurn is alpha-dampened", () => {
      // file: commitCount=20, chunk: churnRatio=0.5, commitCount=10
      // alpha = 0.5
      // chunkRelativeChurn = normalize(0.5, 1.0) * alpha = 0.5 * 0.5 = 0.25
      const payload = fakePayload({
        file: { commitCount: 20 },
        chunk: { churnRatio: 0.5, commitCount: 10 },
      });
      expect(byName("chunkRelativeChurn").extract(payload)).toBeCloseTo(0.25, 2);
    });

    it("knowledgeSilo blends effective contributorCount", () => {
      // file: contributorCount=1, commitCount=20
      // chunk: contributorCount=2, commitCount=10
      // alpha = 0.5
      // effectiveContributorCount = 0.5 * 2 + 0.5 * 1 = 1.5
      // 1.5 rounds to... actually it's continuous: 1 → 1.0, 2 → 0.5, so 1.5 → 0.5 (if >=2, count check)
      // Actually the monolith uses getKnowledgeSiloScore(result, effectiveContributorCount):
      //   if count <= 0: 0; if count === 1: 1.0; if count === 2: 0.5; else 0
      //   count=1.5 → not 1, not 2, count > 0 → actually falls to else → 0
      // Wait, the monolith checks `count === 1` and `count === 2` with strict equality.
      // 1.5 is not 1 and not 2, so it returns 0.
      // Hmm, that's weird. But that's how the monolith works.
      const payload = fakePayload({
        file: { contributorCount: 1, commitCount: 20 },
        chunk: { contributorCount: 2, commitCount: 10 },
      });
      // effectiveContributorCount = 1.5 → not 1, not 2, not <=0 → returns 0
      expect(byName("knowledgeSilo").extract(payload)).toBe(0);
    });
  });

  describe("adaptive bounds via bound parameter", () => {
    const byName = (n: string) => gitDerivedSignals.find((s) => s.name === n)!;

    it("recency uses custom bound when provided", () => {
      // ageDays=200, bound=1000 → 1 - 200/1000 = 0.8
      const payload = fakePayload({ file: { ageDays: 200 } });
      expect(byName("recency").extract(payload, 1000)).toBeCloseTo(0.8, 2);
    });

    it("churn uses custom bound when provided", () => {
      // commitCount=25, bound=100 → 25/100 = 0.25
      const payload = fakePayload({ file: { commitCount: 25 } });
      expect(byName("churn").extract(payload, 100)).toBeCloseTo(0.25, 2);
    });

    it("bugFix uses custom bound when provided", () => {
      // bugFixRate=50, bound=200 → 50/200 = 0.25
      const payload = fakePayload({ file: { bugFixRate: 50 } });
      expect(byName("bugFix").extract(payload, 200)).toBeCloseTo(0.25, 2);
    });

    it("falls back to defaultBound when bound not provided", () => {
      const payload = fakePayload({ file: { ageDays: 182.5 } });
      // Without bound: 1 - 182.5/365 = 0.5
      expect(byName("recency").extract(payload)).toBeCloseTo(0.5, 2);
    });
  });
});

import { describe, expect, it } from "vitest";

import type { ExtractContext } from "../../../../src/core/contracts/types/trajectory.js";
import { gitDerivedSignals } from "../../../../src/core/trajectory/git/rerank/derived-signals/index.js";

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
      expect(d.sources).toContain("file.ageDays");
      const val = d.extract(fakePayload({ file: { ageDays: 182.5 } }));
      expect(val).toBeCloseTo(0.5, 2);
    });

    it("churn: commitCount/50", () => {
      const d = gitDerivedSignals.find((s) => s.name === "churn")!;
      expect(d.sources).toContain("file.commitCount");
      expect(d.extract(fakePayload({ file: { commitCount: 25 } }))).toBeCloseTo(0.5, 2);
    });

    it("ownership: from dominantAuthorPct", () => {
      const d = gitDerivedSignals.find((s) => s.name === "ownership")!;
      expect(d.sources).toContain("file.dominantAuthorPct");
      expect(d.sources).toContain("file.authors");
      // commitCount >= fallback threshold (5) so confidence dampening = 1
      const val = d.extract(fakePayload({ file: { dominantAuthorPct: 80, commitCount: 10 } }));
      expect(val).toBeCloseTo(0.8, 2);
    });

    it("ownership: from authors array when no dominantAuthorPct", () => {
      const d = gitDerivedSignals.find((s) => s.name === "ownership")!;
      expect(d.extract(fakePayload({ file: { authors: ["a", "b"], commitCount: 10 } }))).toBeCloseTo(0.5, 2);
    });

    it("knowledgeSilo: categorical from contributorCount", () => {
      const d = gitDerivedSignals.find((s) => s.name === "knowledgeSilo")!;
      // commitCount >= fallback threshold (5) so confidence dampening = 1
      expect(d.extract(fakePayload({ file: { contributorCount: 1, commitCount: 10 } }))).toBeCloseTo(1.0);
      expect(d.extract(fakePayload({ file: { contributorCount: 2, commitCount: 10 } }))).toBeCloseTo(0.5);
      expect(d.extract(fakePayload({ file: { contributorCount: 5, commitCount: 10 } }))).toBe(0);
    });

    it("blockPenalty: 1 for block without chunk data, 0 for non-block", () => {
      const d = gitDerivedSignals.find((s) => s.name === "blockPenalty")!;
      expect(d.extract({ ...fakePayload({ file: { commitCount: 10 } }), chunkType: "block" })).toBeCloseTo(1.0);
      expect(d.extract({ ...fakePayload({ file: { commitCount: 10 } }), chunkType: "function" })).toBe(0);
    });

    it("chunkChurn: uses chunk data when file absent (alpha=1)", () => {
      const d = gitDerivedSignals.find((s) => s.name === "chunkChurn")!;
      // chunk-only: alpha=1 → normalize(15, 30) * 1 = 0.5
      expect(d.extract(fakePayload({ chunk: { commitCount: 15 } }))).toBeCloseTo(0.5, 2);
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

  describe("L3 alpha-blending (per-source normalization)", () => {
    const byName = (n: string) => gitDerivedSignals.find((s) => s.name === n)!;

    it("recency normalizes per-source then blends", () => {
      // file: ageDays=200, commitCount=20
      // chunk: ageDays=50, commitCount=10
      // alpha = min(1, (10/20) * min(1, 10/3)) = 0.5
      // normalizedFile = 200/365 = 0.5479
      // normalizedChunk = 50/365 = 0.1370
      // blended = 0.5 * 0.1370 + 0.5 * 0.5479 = 0.3425
      // recency = 1 - 0.3425 = 0.6575
      const payload = fakePayload({
        file: { ageDays: 200, commitCount: 20 },
        chunk: { ageDays: 50, commitCount: 10 },
      });
      expect(byName("recency").extract(payload)).toBeCloseTo(0.6575, 2);
    });

    it("stability normalizes per-source then blends", () => {
      // file: commitCount=40, chunk: commitCount=10
      // alpha = min(1, (10/40) * min(1, 10/3)) = 0.25
      // normalizedFile = 40/50 = 0.8
      // normalizedChunk = 10/50 = 0.2
      // blended = 0.25 * 0.2 + 0.75 * 0.8 = 0.65
      // stability = 1 - 0.65 = 0.35
      const payload = fakePayload({
        file: { commitCount: 40 },
        chunk: { commitCount: 10 },
      });
      expect(byName("stability").extract(payload)).toBeCloseTo(0.35, 2);
    });

    it("maturity factor reduces alpha for low chunk commits", () => {
      // file: commitCount=20, chunk: commitCount=2 (below CHUNK_MATURITY_THRESHOLD=3)
      // alpha = min(1, (2/20) * min(1, 2/3)) = 0.0667
      // normalizedFile = 100/365 = 0.2740
      // normalizedChunk = 10/365 = 0.0274
      // blended = 0.0667 * 0.0274 + 0.9333 * 0.2740 = 0.2575
      // recency = 1 - 0.2575 = 0.7425
      const payload = fakePayload({
        file: { ageDays: 100, commitCount: 20 },
        chunk: { ageDays: 10, commitCount: 2 },
      });
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

    it("bugFix normalizes per-source then blends", () => {
      // file: bugFixRate=80, commitCount=20, chunk: bugFixRate=40, commitCount=10
      // alpha = 0.5
      // normalizedFile = 80/100 = 0.8
      // normalizedChunk = 40/100 = 0.4
      // blended = 0.5 * 0.4 + 0.5 * 0.8 = 0.6
      const payload = fakePayload({
        file: { bugFixRate: 80, commitCount: 20 },
        chunk: { bugFixRate: 40, commitCount: 10 },
      });
      expect(byName("bugFix").extract(payload)).toBeCloseTo(0.6, 2);
    });

    it("density normalizes per-source then blends", () => {
      // file: changeDensity=10, commitCount=20, chunk: changeDensity=4, commitCount=10
      // alpha = 0.5
      // normalizedFile = 10/20 = 0.5
      // normalizedChunk = 4/20 = 0.2
      // blended = 0.5 * 0.2 + 0.5 * 0.5 = 0.35
      const payload = fakePayload({
        file: { changeDensity: 10, commitCount: 20 },
        chunk: { changeDensity: 4, commitCount: 10 },
      });
      expect(byName("density").extract(payload)).toBeCloseTo(0.35, 2);
    });

    it("burstActivity normalizes per-source then blends", () => {
      // file: recencyWeightedFreq=8, commitCount=20, chunk: rwf=2, commitCount=10
      // alpha = 0.5
      // normalizedFile = 8/10 = 0.8
      // normalizedChunk = 2/10 = 0.2
      // blended = 0.5 * 0.2 + 0.5 * 0.8 = 0.5
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

    it("knowledgeSilo blends effective contributorCount (raw, not normalized)", () => {
      // file: contributorCount=1, commitCount=20, chunk: contributorCount=2, commitCount=10
      // alpha = 0.5
      // effectiveContributorCount = 0.5 * 2 + 0.5 * 1 = 1.5
      // 1.5 is not exactly 1 or 2 → returns 0 (strict equality check)
      const payload = fakePayload({
        file: { contributorCount: 1, commitCount: 20 },
        chunk: { contributorCount: 2, commitCount: 10 },
      });
      expect(byName("knowledgeSilo").extract(payload)).toBe(0);
    });
  });

  describe("chunk-only payloads (no file-level data)", () => {
    const byName = (n: string) => gitDerivedSignals.find((s) => s.name === n)!;
    const chunkOnly = (chunk: Record<string, unknown>) => fakePayload({ chunk });

    it("recency and stability produce DIFFERENT values for chunk-only payload", () => {
      // chunk: ageDays=50 (young), commitCount=10 (moderate churn)
      // recency should be HIGH (young code), stability should be LOW (many commits)
      const payload = chunkOnly({ ageDays: 50, commitCount: 10 });
      const recency = byName("recency").extract(payload);
      const stability = byName("stability").extract(payload);
      expect(recency).not.toBeCloseTo(stability, 2);
    });

    it("recency uses chunk ageDays when file data absent", () => {
      // chunk: ageDays=100, commitCount=5
      // Should compute: 1 - normalize(100, 365) = 1 - 0.274 = 0.726
      const payload = chunkOnly({ ageDays: 100, commitCount: 5 });
      const val = byName("recency").extract(payload);
      expect(val).toBeCloseTo(0.726, 2);
    });

    it("stability uses chunk commitCount when file data absent", () => {
      // chunk: commitCount=25
      // Should compute: 1 - normalize(25, 50) = 1 - 0.5 = 0.5
      const payload = chunkOnly({ commitCount: 25 });
      const val = byName("stability").extract(payload);
      expect(val).toBeCloseTo(0.5, 2);
    });

    it("churn uses chunk commitCount when file data absent", () => {
      // chunk: commitCount=25
      // Should compute: normalize(25, 50) = 0.5
      const payload = chunkOnly({ commitCount: 25 });
      const val = byName("churn").extract(payload);
      expect(val).toBeCloseTo(0.5, 2);
    });

    it("age uses chunk ageDays when file data absent", () => {
      // chunk: ageDays=182.5, commitCount=5
      // Should compute: normalize(182.5, 365) = 0.5
      const payload = chunkOnly({ ageDays: 182.5, commitCount: 5 });
      const val = byName("age").extract(payload);
      expect(val).toBeCloseTo(0.5, 2);
    });
  });

  describe("dampening threshold via ctx.dampeningThreshold", () => {
    const byName = (n: string) => gitDerivedSignals.find((s) => s.name === n)!;

    it("ownership uses dampeningThreshold from ctx instead of collectionStats", () => {
      // commitCount=3, dampeningThreshold=10 → dampening = (3/10)^2 = 0.09
      // dominantAuthorPct=80 → value=0.8 * 0.09 = 0.072
      const payload = fakePayload({ file: { dominantAuthorPct: 80, commitCount: 3 } });
      expect(byName("ownership").extract(payload, { dampeningThreshold: 10 })).toBeCloseTo(0.072, 2);
    });

    it("bugFix uses dampeningThreshold from ctx", () => {
      // commitCount=4, dampeningThreshold=20 → dampening = (4/20)^2 = 0.04
      // bugFixRate=50, bound=100 → normalized=0.5, damped=0.5*0.04 = 0.02
      const payload = fakePayload({ file: { bugFixRate: 50, commitCount: 4 } });
      expect(byName("bugFix").extract(payload, { dampeningThreshold: 20 })).toBeCloseTo(0.02, 2);
    });

    it("falls back to per-signal FALLBACK_THRESHOLD when dampeningThreshold not in ctx", () => {
      // ownership FALLBACK_THRESHOLD=5, commitCount=5 → dampening=(5/5)^2=1
      const payload = fakePayload({ file: { dominantAuthorPct: 80, commitCount: 5 } });
      expect(byName("ownership").extract(payload)).toBeCloseTo(0.8, 2);
    });

    it("does not accept collectionStats in ExtractContext", () => {
      // ExtractContext should have bounds (Record) not bound (number)
      const ctx: ExtractContext = { bounds: { "file.ageDays": 365 } };
      expect(ctx).not.toHaveProperty("collectionStats");
      expect(ctx).not.toHaveProperty("bound");
    });
  });

  describe("adaptive bounds via per-source bounds", () => {
    const byName = (n: string) => gitDerivedSignals.find((s) => s.name === n)!;

    it("recency uses custom per-source bounds when provided", () => {
      // ageDays=200, file bound=1000 → 1 - 200/1000 = 0.8
      const payload = fakePayload({ file: { ageDays: 200 } });
      expect(
        byName("recency").extract(payload, { bounds: { "file.ageDays": 1000, "chunk.ageDays": 1000 } }),
      ).toBeCloseTo(0.8, 2);
    });

    it("churn uses custom per-source bounds when provided", () => {
      // commitCount=25, file bound=100 → 25/100 = 0.25
      const payload = fakePayload({ file: { commitCount: 25 } });
      expect(
        byName("churn").extract(payload, { bounds: { "file.commitCount": 100, "chunk.commitCount": 100 } }),
      ).toBeCloseTo(0.25, 2);
    });

    it("bugFix uses custom per-source bounds when provided", () => {
      // bugFixRate=50, file bound=200 → 50/200 = 0.25 (commitCount >= threshold so dampening = 1)
      const payload = fakePayload({ file: { bugFixRate: 50, commitCount: 10 } });
      expect(
        byName("bugFix").extract(payload, { bounds: { "file.bugFixRate": 200, "chunk.bugFixRate": 200 } }),
      ).toBeCloseTo(0.25, 2);
    });

    it("falls back to defaultBound when bounds not provided", () => {
      const payload = fakePayload({ file: { ageDays: 182.5 } });
      // Without bounds: 1 - 182.5/365 = 0.5
      expect(byName("recency").extract(payload)).toBeCloseTo(0.5, 2);
    });
  });
});

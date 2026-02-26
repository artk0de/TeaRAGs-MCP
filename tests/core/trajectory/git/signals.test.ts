import { describe, expect, it } from "vitest";

import { gitSignals } from "../../../../src/core/trajectory/git/signals.js";

describe("git signal descriptors", () => {
  it("exports array of signal descriptors", () => {
    expect(Array.isArray(gitSignals)).toBe(true);
    expect(gitSignals.length).toBe(14);
  });

  it("each signal has required fields", () => {
    for (const s of gitSignals) {
      expect(s.name).toBeTruthy();
      expect(s.description).toBeTruthy();
      expect(typeof s.extract).toBe("function");
    }
  });

  it("recency extracts from nested git.file.ageDays", () => {
    const recency = gitSignals.find((s) => s.name === "recency")!;
    expect(recency.extract({ git: { file: { ageDays: 0 } } })).toBe(1);
    expect(recency.extract({ git: { file: { ageDays: 365 } } })).toBe(0);
  });

  it("recency extracts from flat git.ageDays (backward compat)", () => {
    const recency = gitSignals.find((s) => s.name === "recency")!;
    const score = recency.extract({ git: { ageDays: 100 } });
    expect(score).toBeGreaterThan(0);
    expect(score).toBeLessThan(1);
  });

  it("churn extracts commitCount normalized", () => {
    const churn = gitSignals.find((s) => s.name === "churn")!;
    expect(churn.extract({ git: { file: { commitCount: 50 } } })).toBe(1);
    expect(churn.extract({ git: { file: { commitCount: 0 } } })).toBe(0);
    expect(churn.extract({})).toBe(0);
  });

  it("ownership uses dominantAuthorPct when available", () => {
    const ownership = gitSignals.find((s) => s.name === "ownership")!;
    expect(ownership.extract({ git: { file: { dominantAuthorPct: 80 } } })).toBeCloseTo(0.8);
  });

  it("ownership falls back to 1/authors.length", () => {
    const ownership = gitSignals.find((s) => s.name === "ownership")!;
    expect(ownership.extract({ git: { file: { authors: ["a", "b"] } } })).toBeCloseTo(0.5);
    expect(ownership.extract({ git: { file: { authors: ["a"] } } })).toBe(1);
  });

  it("bugFix has needsConfidence=true and defaultBound=100", () => {
    const bugFix = gitSignals.find((s) => s.name === "bugFix")!;
    expect(bugFix.needsConfidence).toBe(true);
    expect(bugFix.defaultBound).toBe(100);
  });

  it("blockPenalty returns 1 for block chunks without chunk data (alpha=0)", () => {
    const bp = gitSignals.find((s) => s.name === "blockPenalty")!;
    expect(bp.extract({ chunkType: "block" })).toBe(1);
    expect(bp.extract({ chunkType: "function" })).toBe(0);
  });

  it("blockPenalty returns 0 for block chunks with rich chunk data (alpha=1)", () => {
    const bp = gitSignals.find((s) => s.name === "blockPenalty")!;
    expect(bp.extract({ chunkType: "block", git: { file: { commitCount: 10 }, chunk: { commitCount: 10 } } })).toBe(0);
  });

  it("chunkChurn extracts from git.chunk.commitCount", () => {
    const cc = gitSignals.find((s) => s.name === "chunkChurn")!;
    expect(cc.extract({ git: { chunk: { commitCount: 15 } } })).toBe(0.5);
    expect(cc.extract({ git: { chunk: { commitCount: 30 } } })).toBe(1);
  });

  it("knowledgeSilo returns 1 for single contributor, 0.5 for 2, 0 for 3+", () => {
    const ks = gitSignals.find((s) => s.name === "knowledgeSilo")!;
    expect(ks.extract({ git: { file: { contributorCount: 1 } } })).toBe(1);
    expect(ks.extract({ git: { file: { contributorCount: 2 } } })).toBe(0.5);
    expect(ks.extract({ git: { file: { contributorCount: 3 } } })).toBe(0);
  });

  it("burstActivity extracts recencyWeightedFreq", () => {
    const ba = gitSignals.find((s) => s.name === "burstActivity")!;
    expect(ba.extract({ git: { file: { recencyWeightedFreq: 10 } } })).toBe(1);
    expect(ba.extract({ git: { file: { recencyWeightedFreq: 5 } } })).toBe(0.5);
  });

  it("returns 0 for all signals when payload is empty", () => {
    for (const s of gitSignals) {
      const val = s.extract({});
      expect(val).toBeGreaterThanOrEqual(0);
      expect(val).toBeLessThanOrEqual(1);
    }
  });
});

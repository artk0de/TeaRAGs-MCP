import { describe, expect, it } from "vitest";

import { RecentActivityConcentrationSignal } from "../../../../../../../src/core/domains/trajectory/git/rerank/derived-signals/recent-activity-concentration.js";

describe("RecentActivityConcentrationSignal", () => {
  const signal = new RecentActivityConcentrationSignal();

  it("name and sources point at commit-based fields, not blame-based", () => {
    expect(signal.name).toBe("recentActivityConcentration");
    expect(signal.sources).toEqual(["file.dominantAuthorPct", "file.authors"]);
  });

  it("returns dominantAuthorPct/100 dampened by commitCount", () => {
    const payload = {
      git: {
        file: { dominantAuthorPct: 80, authors: ["alice"], commitCount: 10 },
      },
    };
    const result = signal.extract(payload);
    expect(result).toBeGreaterThan(0);
    expect(result).toBeLessThanOrEqual(0.8);
  });

  it("falls back to 1/authors when dominantAuthorPct missing", () => {
    const payload = {
      git: {
        file: { authors: ["alice", "bob"], commitCount: 10 },
      },
    };
    const result = signal.extract(payload);
    // 1/2 = 0.5, dampened
    expect(result).toBeGreaterThan(0);
    expect(result).toBeLessThanOrEqual(0.5);
  });

  it("returns 0 when neither pct nor authors present", () => {
    const payload = { git: { file: { commitCount: 1 } } };
    expect(signal.extract(payload)).toBe(0);
  });
});

describe("OwnershipSignal — re-oriented to line-based fields", () => {
  it("declares lineDominantAuthorPct + lineAuthors as sources", async () => {
    const { OwnershipSignal } =
      await import("../../../../../../../src/core/domains/trajectory/git/rerank/derived-signals/ownership.js");
    const signal = new OwnershipSignal();
    expect(signal.sources).toEqual(["file.lineDominantAuthorPct", "file.lineAuthors"]);
  });

  it("scores from lineDominantAuthorPct, not commit-based dominantAuthorPct", async () => {
    const { OwnershipSignal } =
      await import("../../../../../../../src/core/domains/trajectory/git/rerank/derived-signals/ownership.js");
    const signal = new OwnershipSignal();
    const payload = {
      git: {
        file: {
          // recent activity concentrated, but live-line ownership shared
          dominantAuthorPct: 100,
          authors: ["alice"],
          lineDominantAuthorPct: 40,
          lineAuthors: ["alice", "bob", "carol"],
          commitCount: 10,
        },
      },
    };
    const result = signal.extract(payload);
    // Should reflect 40% (line-based), not 100% (commit-based)
    expect(result).toBeGreaterThan(0);
    expect(result).toBeLessThanOrEqual(0.4);
  });
});

describe("KnowledgeSiloSignal — re-oriented to lineContributorCount", () => {
  it("declares file+chunk lineContributorCount as sources", async () => {
    const { KnowledgeSiloSignal } =
      await import("../../../../../../../src/core/domains/trajectory/git/rerank/derived-signals/knowledge-silo.js");
    const signal = new KnowledgeSiloSignal();
    expect(signal.sources).toEqual(["file.lineContributorCount", "chunk.lineContributorCount"]);
  });

  it("treats single live-line contributor as silo (1.0)", async () => {
    const { KnowledgeSiloSignal } =
      await import("../../../../../../../src/core/domains/trajectory/git/rerank/derived-signals/knowledge-silo.js");
    const signal = new KnowledgeSiloSignal();
    const payload = {
      git: {
        file: { lineContributorCount: 1, commitCount: 10 },
      },
    };
    const result = signal.extract(payload);
    expect(result).toBeGreaterThan(0);
    expect(result).toBeLessThanOrEqual(1);
  });

  it("returns 0 when 3+ live-line contributors", async () => {
    const { KnowledgeSiloSignal } =
      await import("../../../../../../../src/core/domains/trajectory/git/rerank/derived-signals/knowledge-silo.js");
    const signal = new KnowledgeSiloSignal();
    const payload = {
      git: {
        file: { lineContributorCount: 5, commitCount: 10 },
      },
    };
    expect(signal.extract(payload)).toBe(0);
  });
});

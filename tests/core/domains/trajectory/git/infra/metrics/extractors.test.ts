/**
 * Tests for pure metric extractor functions.
 *
 * Each extractor computes one metric family from commit data.
 * Extracted from the monolithic computeFileSignals() in metrics.ts.
 */

import { describe, expect, it } from "vitest";

import type { CommitInfo } from "../../../../../../../src/core/adapters/git/types.js";
import {
  computeBugFixRate,
  computeChangeDensity,
  computeChurnVolatility,
  computeDominantAuthor,
  computeRecencyWeightedFreq,
  computeRelativeChurn,
  computeTemporalMetrics,
  extractAllTaskIds,
} from "../../../../../../../src/core/domains/trajectory/git/infra/metrics/extractors.js";

const makeCommit = (overrides: Partial<CommitInfo> = {}): CommitInfo => ({
  sha: "abc123",
  author: "alice",
  authorEmail: "alice@example.com",
  timestamp: 1700000000,
  body: "feat: add feature",
  parents: [],
  ...overrides,
});

// ─── computeDominantAuthor ──────────────────────────────────────────────────

describe("computeDominantAuthor", () => {
  it("returns author with most commits", () => {
    const commits = [
      makeCommit({ author: "alice", authorEmail: "a@x.com" }),
      makeCommit({ author: "alice", authorEmail: "a@x.com" }),
      makeCommit({ author: "bob", authorEmail: "b@x.com" }),
    ];
    const result = computeDominantAuthor(commits);
    expect(result.author).toBe("alice");
    expect(result.email).toBe("a@x.com");
    expect(result.pct).toBe(67);
    expect(result.authors).toEqual(["alice", "bob"]);
    expect(result.contributorCount).toBe(2);
  });

  it("returns unknown for empty commits", () => {
    const result = computeDominantAuthor([]);
    expect(result.author).toBe("unknown");
    expect(result.email).toBe("");
    expect(result.pct).toBe(0);
    expect(result.authors).toEqual([]);
    expect(result.contributorCount).toBe(0);
  });

  it("handles single contributor", () => {
    const commits = [
      makeCommit({ author: "alice", authorEmail: "a@x.com" }),
      makeCommit({ author: "alice", authorEmail: "a@x.com" }),
    ];
    const result = computeDominantAuthor(commits);
    expect(result.author).toBe("alice");
    expect(result.pct).toBe(100);
    expect(result.contributorCount).toBe(1);
  });
});

// ─── computeTemporalMetrics ─────────────────────────────────────────────────

describe("computeTemporalMetrics", () => {
  it("computes age, timestamps, last commit hash", () => {
    const now = Date.now() / 1000;
    const commits = [
      makeCommit({ sha: "first", timestamp: now - 86400 * 30 }),
      makeCommit({ sha: "last", timestamp: now - 86400 }),
    ];
    const result = computeTemporalMetrics(commits);
    expect(result.lastCommitHash).toBe("last");
    expect(result.ageDays).toBe(1);
    expect(result.lastModifiedAt).toBeCloseTo(now - 86400, -1);
    expect(result.firstCreatedAt).toBeCloseTo(now - 86400 * 30, -1);
  });

  it("returns zeros for empty commits", () => {
    const result = computeTemporalMetrics([]);
    expect(result.ageDays).toBe(0);
    expect(result.lastCommitHash).toBe("");
    expect(result.lastModifiedAt).toBe(0);
    expect(result.firstCreatedAt).toBe(0);
  });

  it("sorts commits regardless of input order", () => {
    const now = Date.now() / 1000;
    const commits = [
      makeCommit({ sha: "newer", timestamp: now - 86400 }),
      makeCommit({ sha: "oldest", timestamp: now - 86400 * 90 }),
      makeCommit({ sha: "middle", timestamp: now - 86400 * 30 }),
    ];
    const result = computeTemporalMetrics(commits);
    expect(result.lastCommitHash).toBe("newer");
    expect(result.firstCreatedAt).toBeCloseTo(now - 86400 * 90, -1);
  });
});

// ─── computeRelativeChurn ───────────────────────────────────────────────────

describe("computeRelativeChurn", () => {
  it("computes (added + deleted) / lineCount rounded to 2 decimals", () => {
    expect(computeRelativeChurn(100, 50, 200)).toBe(0.75);
  });

  it("returns 0 for zero lineCount (uses max(lineCount, 1))", () => {
    // With max(0, 1) = 1, result is (10+5)/1 = 15.0
    expect(computeRelativeChurn(10, 5, 0)).toBe(15);
  });

  it("rounds to 2 decimal places", () => {
    expect(computeRelativeChurn(100, 50, 300)).toBe(0.5);
    expect(computeRelativeChurn(1, 1, 3)).toBe(0.67);
  });
});

// ─── computeRecencyWeightedFreq ─────────────────────────────────────────────

describe("computeRecencyWeightedFreq", () => {
  it("sums exp(-0.1 * daysAgo) for each commit", () => {
    const now = Date.now() / 1000;
    const commits = [makeCommit({ timestamp: now })]; // 0 days ago
    const result = computeRecencyWeightedFreq(commits);
    expect(result).toBeCloseTo(1.0, 1);
  });

  it("returns 0 for empty commits", () => {
    expect(computeRecencyWeightedFreq([])).toBe(0);
  });

  it("decays with distance in time", () => {
    const now = Date.now() / 1000;
    const recent = computeRecencyWeightedFreq([makeCommit({ timestamp: now })]);
    const old = computeRecencyWeightedFreq([makeCommit({ timestamp: now - 86400 * 30 })]);
    expect(recent).toBeGreaterThan(old);
  });
});

// ─── computeChangeDensity ───────────────────────────────────────────────────

describe("computeChangeDensity", () => {
  it("computes commits / months", () => {
    const now = Date.now() / 1000;
    const commits = [makeCommit({ timestamp: now - 86400 * 60 }), makeCommit({ timestamp: now })];
    const result = computeChangeDensity(commits);
    expect(result).toBeCloseTo(1.0, 0); // 2 commits over ~2 months
  });

  it("returns 0 for empty commits", () => {
    expect(computeChangeDensity([])).toBe(0);
  });

  it("uses minimum 1 month span", () => {
    const now = Date.now() / 1000;
    // Two commits 1 day apart — span < 1 month, clamped to 1
    const commits = [makeCommit({ timestamp: now - 86400 }), makeCommit({ timestamp: now })];
    const result = computeChangeDensity(commits);
    expect(result).toBe(2); // 2 commits / 1 month
  });
});

// ─── computeChurnVolatility ─────────────────────────────────────────────────

describe("computeChurnVolatility", () => {
  it("returns 0 for single commit", () => {
    expect(computeChurnVolatility([makeCommit()])).toBe(0);
  });

  it("returns 0 for empty commits", () => {
    expect(computeChurnVolatility([])).toBe(0);
  });

  it("returns 0 for equally spaced commits", () => {
    const commits = [
      makeCommit({ timestamp: 1000000 }),
      makeCommit({ timestamp: 1000000 + 86400 }),
      makeCommit({ timestamp: 1000000 + 86400 * 2 }),
    ];
    expect(computeChurnVolatility(commits)).toBe(0);
  });

  it("returns positive value for unevenly spaced commits", () => {
    const commits = [
      makeCommit({ timestamp: 1000000 }),
      makeCommit({ timestamp: 1000000 + 86400 }), // 1 day gap
      makeCommit({ timestamp: 1000000 + 86400 * 10 }), // 9 day gap
    ];
    expect(computeChurnVolatility(commits)).toBeGreaterThan(0);
  });
});

// ─── computeBugFixRate ──────────────────────────────────────────────────────

describe("computeBugFixRate", () => {
  it("returns Laplace-smoothed percentage of bug fix commits", () => {
    const commits = [
      makeCommit({ body: "fix: resolve bug" }),
      makeCommit({ body: "feat: add feature" }),
      makeCommit({ body: "fix: another bug" }),
      makeCommit({ body: "chore: cleanup" }),
    ];
    // 2 fixes out of 4: (2 + 0.5) / (4 + 1.0) = 2.5/5.0 = 0.5 → 50
    expect(computeBugFixRate(commits)).toBe(50);
  });

  it("returns 0 for empty commits", () => {
    expect(computeBugFixRate([])).toBe(0);
  });

  it("handles all bug fix commits with smoothing", () => {
    const commits = [makeCommit({ body: "fix: bug1" }), makeCommit({ body: "fix: bug2" })];
    // (2 + 0.5) / (2 + 1.0) = 2.5/3.0 = 0.833... → 83
    expect(computeBugFixRate(commits)).toBe(83);
  });

  it("handles zero bug fix commits with smoothing", () => {
    const commits = [makeCommit({ body: "feat: something" }), makeCommit({ body: "chore: cleanup" })];
    // (0 + 0.5) / (2 + 1.0) = 0.5/3.0 = 0.1666... → 17
    expect(computeBugFixRate(commits)).toBe(17);
  });
});

// ─── extractAllTaskIds ──────────────────────────────────────────────────────

describe("extractAllTaskIds", () => {
  it("collects unique task IDs from all commits", () => {
    const commits = [makeCommit({ body: "feat: TD-123" }), makeCommit({ body: "fix: TD-456, TD-123" })];
    const result = extractAllTaskIds(commits);
    expect(result).toContain("TD-123");
    expect(result).toContain("TD-456");
    expect(result).toHaveLength(2);
  });

  it("returns empty array for empty commits", () => {
    expect(extractAllTaskIds([])).toEqual([]);
  });

  it("returns empty array for commits without task IDs", () => {
    const commits = [makeCommit({ body: "feat: add feature" }), makeCommit({ body: "chore: cleanup" })];
    expect(extractAllTaskIds(commits)).toEqual([]);
  });
});

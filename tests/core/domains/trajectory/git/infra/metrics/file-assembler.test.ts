/**
 * Tests for file-level metadata assembler.
 *
 * The assembler composes pure metric extractors into a complete
 * GitFileSignals object.
 */

import { describe, expect, it } from "vitest";

import type { BlameLine, FileChurnData } from "../../../../../../../src/core/adapters/git/types.js";
import { assembleFileSignals } from "../../../../../../../src/core/domains/trajectory/git/infra/metrics/file-assembler.js";

describe("assembleFileSignals", () => {
  it("composes all extractors into GitFileSignals", () => {
    const now = Date.now() / 1000;
    const churnData: FileChurnData = {
      commits: [
        { sha: "a1", author: "alice", authorEmail: "a@x.com", timestamp: now - 86400 * 10, body: "feat: add" },
        { sha: "a2", author: "alice", authorEmail: "a@x.com", timestamp: now - 86400, body: "fix: bug" },
        { sha: "a3", author: "bob", authorEmail: "b@x.com", timestamp: now, body: "chore: cleanup" },
      ],
      linesAdded: 200,
      linesDeleted: 50,
    };
    const result = assembleFileSignals(churnData, 300);

    expect(result.recentDominantAuthor).toBe("alice");
    expect(result.recentDominantAuthorEmail).toBe("a@x.com");
    expect(result.recentAuthors).toContain("alice");
    expect(result.recentAuthors).toContain("bob");
    expect(result.recentDominantAuthorPct).toBe(67);
    expect(result.commitCount).toBe(3);
    expect(result.linesAdded).toBe(200);
    expect(result.linesDeleted).toBe(50);
    expect(result.fileChurnCount).toBe(250);
    expect(result.relativeChurn).toBeCloseTo(0.83, 1);
    // Laplace-smoothed: (1 + 0.5) / (3 + 1.0) = 1.5/4.0 = 0.375 → 38
    expect(result.bugFixRate).toBe(38);
    expect(result.recentContributorCount).toBe(2);
    expect(result.lastCommitHash).toBe("a3");
  });

  it("returns zero-value metadata for empty commits", () => {
    const churnData: FileChurnData = { commits: [], linesAdded: 0, linesDeleted: 0 };
    const result = assembleFileSignals(churnData, 100);
    expect(result.recentDominantAuthor).toBe("unknown");
    expect(result.commitCount).toBe(0);
    expect(result.fileChurnCount).toBe(0);
    expect(result.bugFixRate).toBe(0);
    expect(result.relativeChurn).toBe(0);
    expect(result.recencyWeightedFreq).toBe(0);
    expect(result.changeDensity).toBe(0);
    expect(result.churnVolatility).toBe(0);
    expect(result.recentContributorCount).toBe(0);
    expect(result.taskIds).toEqual([]);
  });

  it("preserves linesAdded/linesDeleted from churn data", () => {
    const churnData: FileChurnData = {
      commits: [{ sha: "a1", author: "alice", authorEmail: "a@x.com", timestamp: 1700000000, body: "feat: TD-123" }],
      linesAdded: 42,
      linesDeleted: 7,
    };
    const result = assembleFileSignals(churnData, 50);
    expect(result.linesAdded).toBe(42);
    expect(result.linesDeleted).toBe(7);
  });

  it("extracts task IDs from commit messages", () => {
    const churnData: FileChurnData = {
      commits: [
        { sha: "a1", author: "alice", authorEmail: "a@x.com", timestamp: 1700000000, body: "feat: TD-123 implement" },
        { sha: "a2", author: "alice", authorEmail: "a@x.com", timestamp: 1700000100, body: "fix: TD-456, TD-123" },
      ],
      linesAdded: 10,
      linesDeleted: 5,
    };
    const result = assembleFileSignals(churnData, 100);
    expect(result.taskIds).toContain("TD-123");
    expect(result.taskIds).toContain("TD-456");
    expect(result.taskIds).toHaveLength(2);
  });

  it("populates line-based ownership when blameLines provided", () => {
    const churnData: FileChurnData = {
      commits: [{ sha: "a1", author: "alice", authorEmail: "a@x.com", timestamp: 1700000000, body: "feat" }],
      linesAdded: 10,
      linesDeleted: 0,
    };
    const blameLines: BlameLine[] = [
      { lineNumber: 1, sha: "x", author: "Carol", authorEmail: "c@x.com", timestamp: 1700000000 },
      { lineNumber: 2, sha: "x", author: "Carol", authorEmail: "c@x.com", timestamp: 1700000000 },
      { lineNumber: 3, sha: "y", author: "Dave", authorEmail: "d@x.com", timestamp: 1700000100 },
    ];
    const result = assembleFileSignals(churnData, 10, undefined, undefined, blameLines);

    // Recent activity (commit-based) — alice is sole committer
    expect(result.recentDominantAuthor).toBe("alice");
    // Live-line ownership — carol owns 2/3 of lines, decoupled from commits
    expect(result.blameDominantAuthor).toBe("Carol");
    expect(result.blameDominantAuthorPct).toBe(67);
    expect(result.blameAuthors).toEqual(["Carol", "Dave"]);
    expect(result.blameContributorCount).toBe(2);
  });

  it("falls back to unknown line ownership when blameLines is empty", () => {
    const churnData: FileChurnData = {
      commits: [{ sha: "a1", author: "alice", authorEmail: "a@x.com", timestamp: 1700000000, body: "feat" }],
      linesAdded: 1,
      linesDeleted: 0,
    };
    const result = assembleFileSignals(churnData, 10, undefined, undefined, []);

    expect(result.blameDominantAuthor).toBe("unknown");
    expect(result.blameDominantAuthorPct).toBe(0);
    expect(result.blameContributorCount).toBe(0);
  });
});

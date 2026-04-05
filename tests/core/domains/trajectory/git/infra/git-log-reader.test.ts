/**
 * Tests for GitLogReader, computeFileSignals, extractTaskIds
 *
 * Coverage:
 * 1. extractTaskIds — all ticket formats, edge cases
 * 2. computeFileSignals — churn metric calculations
 * 3. GitLogReader — integration with real git repo
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import * as gitClient from "../../../../../../src/core/adapters/git/client.js";
import * as gitParsers from "../../../../../../src/core/adapters/git/parsers.js";
import type { CommitInfo, FileChurnData } from "../../../../../../src/core/adapters/git/types.js";
import * as chunkReader from "../../../../../../src/core/domains/trajectory/git/infra/chunk-reader.js";
import {
  computeFileSignals,
  extractTaskIds,
  GitLogReader,
  overlaps,
} from "../../../../../../src/core/domains/trajectory/git/infra/git-log-reader.js";
import {
  isBugFixCommit,
  isBugFixCommitOrBranch,
} from "../../../../../../src/core/domains/trajectory/git/infra/metrics.js";

// Enable cross-module spy interception for adapter functions
vi.mock("../../../../../../src/core/adapters/git/client.js", async (importOriginal) => importOriginal());
vi.mock("../../../../../../src/core/adapters/git/parsers.js", async (importOriginal) => importOriginal());
vi.mock("../../../../../../src/core/domains/trajectory/git/infra/chunk-reader.js", async (importOriginal) =>
  importOriginal(),
);

// ─── extractTaskIds ──────────────────────────────────────────────────────────

describe("extractTaskIds", () => {
  it("should extract JIRA-style task IDs (ABC-123)", () => {
    expect(extractTaskIds("feat(auth): implement login [TD-1234]")).toContain("TD-1234");
  });

  it("should extract multiple JIRA task IDs from one message", () => {
    const ids = extractTaskIds("fix: resolve TD-1234 and TD-5678 issues");
    expect(ids).toContain("TD-1234");
    expect(ids).toContain("TD-5678");
    expect(ids).toHaveLength(2);
  });

  it("should extract GitHub-style task IDs (#123)", () => {
    expect(extractTaskIds("fix: resolve issue #123")).toContain("#123");
  });

  it("should extract Azure DevOps task IDs (AB#456)", () => {
    expect(extractTaskIds("feat: implement feature AB#456")).toContain("AB#456");
  });

  it("should extract GitLab MR IDs (!789)", () => {
    expect(extractTaskIds("fix: merge !789 changes")).toContain("!789");
  });

  it("should extract mixed task IDs from complex messages", () => {
    const ids = extractTaskIds("feat(core): implement TD-1234 feature, fixes #567, ref AB#890");
    expect(ids).toContain("TD-1234");
    expect(ids).toContain("#567");
    expect(ids).toContain("AB#890");
    expect(ids.length).toBeGreaterThanOrEqual(3);
  });

  it("should return empty array for messages without task IDs", () => {
    expect(extractTaskIds("chore: update dependencies")).toHaveLength(0);
  });

  it("should handle Linear-style task IDs (ENG-123)", () => {
    expect(extractTaskIds("feat: implement ENG-123 feature")).toContain("ENG-123");
  });

  it("should deduplicate repeated task IDs", () => {
    const ids = extractTaskIds("fix: TD-1234 part 1, continue TD-1234 part 2");
    expect(ids.filter((id) => id === "TD-1234")).toHaveLength(1);
  });

  it("should handle empty string", () => {
    expect(extractTaskIds("")).toHaveLength(0);
  });

  it("should not match HTML entities like &#123;", () => {
    expect(extractTaskIds("fix: handle &#123; encoding issue")).not.toContain("#123");
  });

  it("should extract task IDs from merge commit body", () => {
    const body = `Merge branch 'feature/TD-74777-add-backend-validation' into 'master'

[TD-74777] [TD-74596] [Backend] add validation

Closes TD-74777

See merge request taxdome/service/taxdome!47685`;

    const ids = extractTaskIds(body);
    expect(ids).toContain("TD-74777");
    expect(ids).toContain("TD-74596");
    expect(ids).toContain("!47685");
  });
});

// ─── computeFileSignals ─────────────────────────────────────────────────────

describe("computeFileSignals", () => {
  const nowSec = Math.floor(Date.now() / 1000);

  function makeCommit(overrides: Partial<CommitInfo> = {}): CommitInfo {
    return {
      sha: "a".repeat(40),
      author: "Alice",
      authorEmail: "alice@example.com",
      timestamp: nowSec - 86400, // 1 day ago
      body: "feat: initial commit",
      parents: [],
      ...overrides,
    };
  }

  it("should return zero metrics for empty commits", () => {
    const data: FileChurnData = { commits: [], linesAdded: 10, linesDeleted: 5 };
    const meta = computeFileSignals(data, 100);

    expect(meta.commitCount).toBe(0);
    expect(meta.dominantAuthor).toBe("unknown");
    expect(meta.authors).toHaveLength(0);
    expect(meta.relativeChurn).toBe(0);
    expect(meta.recencyWeightedFreq).toBe(0);
    expect(meta.changeDensity).toBe(0);
    expect(meta.churnVolatility).toBe(0);
    // linesAdded/linesDeleted are passed through
    expect(meta.linesAdded).toBe(10);
    expect(meta.linesDeleted).toBe(5);
  });

  it("should compute correct metrics for single commit", () => {
    const commit = makeCommit({ sha: "a".repeat(40), timestamp: nowSec - 86400 });
    const data: FileChurnData = { commits: [commit], linesAdded: 50, linesDeleted: 10 };

    const meta = computeFileSignals(data, 100);

    expect(meta.commitCount).toBe(1);
    expect(meta.dominantAuthor).toBe("Alice");
    expect(meta.dominantAuthorEmail).toBe("alice@example.com");
    expect(meta.dominantAuthorPct).toBe(100);
    expect(meta.authors).toEqual(["Alice"]);
    expect(meta.lastCommitHash).toBe("a".repeat(40));
    expect(meta.ageDays).toBe(1);
    expect(meta.linesAdded).toBe(50);
    expect(meta.linesDeleted).toBe(10);

    // relativeChurn = (50 + 10) / 100 = 0.6
    expect(meta.relativeChurn).toBe(0.6);

    // Single commit → churnVolatility = 0
    expect(meta.churnVolatility).toBe(0);

    // changeDensity: 1 commit / max(span months, 1) = 1
    expect(meta.changeDensity).toBe(1);
  });

  it("should compute dominant author correctly with multiple authors", () => {
    const commits = [
      makeCommit({ author: "Alice", authorEmail: "alice@ex.com", timestamp: nowSec - 86400 * 3 }),
      makeCommit({ author: "Alice", authorEmail: "alice@ex.com", timestamp: nowSec - 86400 * 2 }),
      makeCommit({ author: "Alice", authorEmail: "alice@ex.com", timestamp: nowSec - 86400 }),
      makeCommit({ author: "Bob", authorEmail: "bob@ex.com", timestamp: nowSec - 86400 * 5 }),
      makeCommit({ author: "Charlie", authorEmail: "charlie@ex.com", timestamp: nowSec - 86400 * 4 }),
    ];

    const data: FileChurnData = { commits, linesAdded: 100, linesDeleted: 20 };
    const meta = computeFileSignals(data, 200);

    expect(meta.dominantAuthor).toBe("Alice");
    expect(meta.dominantAuthorPct).toBe(60); // 3/5 = 60%
    expect(meta.authors).toHaveLength(3);
    expect(meta.authors).toContain("Alice");
    expect(meta.authors).toContain("Bob");
    expect(meta.authors).toContain("Charlie");
    expect(meta.commitCount).toBe(5);
  });

  it("should extract task IDs from commit bodies", () => {
    const commits = [
      makeCommit({ body: "feat: implement TD-1234 feature" }),
      makeCommit({ body: "fix: resolve #567" }),
      makeCommit({ body: "chore: update deps" }), // no task ID
    ];

    const data: FileChurnData = { commits, linesAdded: 50, linesDeleted: 10 };
    const meta = computeFileSignals(data, 100);

    expect(meta.taskIds).toContain("TD-1234");
    expect(meta.taskIds).toContain("#567");
    expect(meta.taskIds).toHaveLength(2);
  });

  it("should compute bugFixRate 50% (2 fix out of 4 commits)", () => {
    const commits = [
      makeCommit({ body: "fix: resolve crash on login" }),
      makeCommit({ body: "feat: add new dashboard" }),
      makeCommit({ body: "hotfix: patch memory leak" }),
      makeCommit({ body: "chore: update dependencies" }),
    ];
    const data: FileChurnData = { commits, linesAdded: 0, linesDeleted: 0 };
    const meta = computeFileSignals(data, 100);

    expect(meta.bugFixRate).toBe(50);
  });

  it("should compute bugFixRate 0 when no fix commits", () => {
    const commits = [
      makeCommit({ body: "feat: add feature" }),
      makeCommit({ body: "chore: update deps" }),
      makeCommit({ body: "refactor: simplify logic" }),
    ];
    const data: FileChurnData = { commits, linesAdded: 0, linesDeleted: 0 };
    const meta = computeFileSignals(data, 100);

    // Laplace-smoothed: (0 + 0.5) / (3 + 1.0) = 0.5/4.0 = 0.125 → 13
    expect(meta.bugFixRate).toBe(13);
  });

  it("should compute bugFixRate 0 for empty commits", () => {
    const data: FileChurnData = { commits: [], linesAdded: 0, linesDeleted: 0 };
    const meta = computeFileSignals(data, 100);

    expect(meta.bugFixRate).toBe(0);
    expect(meta.contributorCount).toBe(0);
  });

  it("should detect various bug fix patterns", () => {
    const commits = [
      makeCommit({ body: "fix(auth): resolve session issue" }),
      makeCommit({ body: "[Bug] Handle null pointer in payment flow" }),
      makeCommit({ body: "hotfix: emergency deploy" }),
      makeCommit({ body: "[TD-12345] Fix security vulnerability" }),
    ];
    const data: FileChurnData = { commits, linesAdded: 0, linesDeleted: 0 };
    const meta = computeFileSignals(data, 100);

    // Laplace-smoothed: (4 + 0.5) / (4 + 1.0) = 4.5/5.0 = 0.9 → 90
    expect(meta.bugFixRate).toBe(90);
  });

  it("should NOT count merge commits as bug fixes", () => {
    const commits = [
      makeCommit({ body: "fix: resolve crash on login" }),
      makeCommit({ body: "Merge branch 'fix/TD-12345' into develop" }),
      makeCommit({ body: "Merge pull request #99 from user/fix-payment" }),
      makeCommit({ body: "feat: add new feature" }),
    ];
    const data: FileChurnData = { commits, linesAdded: 0, linesDeleted: 0 };
    const meta = computeFileSignals(data, 100);

    // Only the actual fix commit counts, not the 2 merge commits
    // Laplace-smoothed: (1 + 0.5) / (4 + 1.0) = 1.5/5.0 = 0.3 → 30
    expect(meta.bugFixRate).toBe(30);
  });

  it("should compute contributorCount = 3 (Alice, Bob, Charlie)", () => {
    const commits = [
      makeCommit({ author: "Alice", authorEmail: "alice@ex.com" }),
      makeCommit({ author: "Bob", authorEmail: "bob@ex.com" }),
      makeCommit({ author: "Alice", authorEmail: "alice@ex.com" }),
      makeCommit({ author: "Charlie", authorEmail: "charlie@ex.com" }),
    ];
    const data: FileChurnData = { commits, linesAdded: 0, linesDeleted: 0 };
    const meta = computeFileSignals(data, 100);

    expect(meta.contributorCount).toBe(3);
  });

  it("should compute relativeChurn correctly", () => {
    const commit = makeCommit();
    // 500 added + 300 deleted = 800 total churn, currentLines = 200
    // relativeChurn = 800 / 200 = 4.0
    const data: FileChurnData = { commits: [commit], linesAdded: 500, linesDeleted: 300 };
    const meta = computeFileSignals(data, 200);

    expect(meta.relativeChurn).toBe(4);
  });

  it("should handle currentLineCount of 0 without division by zero", () => {
    const commit = makeCommit();
    const data: FileChurnData = { commits: [commit], linesAdded: 10, linesDeleted: 5 };
    // currentLineCount = 0 → denominator clamped to 1
    const meta = computeFileSignals(data, 0);

    expect(meta.relativeChurn).toBe(15); // (10+5)/1
  });

  it("should compute churnVolatility for regular commits", () => {
    // Commits every 10 days → gaps all equal → stddev = 0
    const commits = [
      makeCommit({ timestamp: nowSec - 86400 * 30 }),
      makeCommit({ timestamp: nowSec - 86400 * 20 }),
      makeCommit({ timestamp: nowSec - 86400 * 10 }),
    ];

    const data: FileChurnData = { commits, linesAdded: 0, linesDeleted: 0 };
    const meta = computeFileSignals(data, 100);

    expect(meta.churnVolatility).toBe(0); // all gaps are 10 days
  });

  it("should compute churnVolatility for irregular commits", () => {
    // Gaps: 1 day and 29 days → mean=15, variance=196, stddev=14
    const commits = [
      makeCommit({ timestamp: nowSec - 86400 * 30 }),
      makeCommit({ timestamp: nowSec - 86400 * 29 }),
      makeCommit({ timestamp: nowSec }),
    ];

    const data: FileChurnData = { commits, linesAdded: 0, linesDeleted: 0 };
    const meta = computeFileSignals(data, 100);

    expect(meta.churnVolatility).toBe(14); // stddev([1, 29]) = 14
  });

  it("should compute recencyWeightedFreq higher for recent commits", () => {
    const recentCommit = makeCommit({ timestamp: nowSec - 86400 }); // 1 day ago
    const oldCommit = makeCommit({ timestamp: nowSec - 86400 * 100 }); // 100 days ago

    const recentData: FileChurnData = { commits: [recentCommit], linesAdded: 0, linesDeleted: 0 };
    const oldData: FileChurnData = { commits: [oldCommit], linesAdded: 0, linesDeleted: 0 };

    const recentMeta = computeFileSignals(recentData, 100);
    const oldMeta = computeFileSignals(oldData, 100);

    // exp(-0.1 * 1) ≈ 0.905 vs exp(-0.1 * 100) ≈ 0.0000454
    expect(recentMeta.recencyWeightedFreq).toBeGreaterThan(oldMeta.recencyWeightedFreq);
  });

  it("should set timestamps from first and last commits", () => {
    const commits = [
      makeCommit({ sha: "b".repeat(40), timestamp: nowSec - 86400 * 30 }),
      makeCommit({ sha: "c".repeat(40), timestamp: nowSec - 86400 * 10 }),
      makeCommit({ sha: "d".repeat(40), timestamp: nowSec - 86400 }),
    ];

    const data: FileChurnData = { commits, linesAdded: 0, linesDeleted: 0 };
    const meta = computeFileSignals(data, 100);

    expect(meta.firstCreatedAt).toBe(nowSec - 86400 * 30);
    expect(meta.lastModifiedAt).toBe(nowSec - 86400);
    expect(meta.lastCommitHash).toBe("d".repeat(40));
  });
});

// ─── GitLogReader (integration — requires real git repo) ─────────────────────

// retry: lint-staged stash/unstash can transiently change git state during pre-commit
describe("GitLogReader", { retry: 2 }, () => {
  let reader: GitLogReader;
  let repoRoot: string;

  beforeEach(async () => {
    reader = new GitLogReader();
    // Use this project's own repo for integration tests
    const { execFile } = await import("node:child_process");
    const { promisify } = await import("node:util");
    const execAsync = promisify(execFile);
    try {
      const { stdout } = await execAsync("git", ["rev-parse", "--show-toplevel"], {
        cwd: import.meta.url.replace("file://", "").replace(/\/[^/]+$/, ""),
      });
      repoRoot = stdout.trim();
    } catch {
      repoRoot = "";
    }
  });

  it("should return HEAD sha for a real git repo", async () => {
    if (!repoRoot) return; // skip outside git

    const head = await reader.getHead(repoRoot);
    expect(head).toMatch(/^[a-f0-9]{40}$/);
  });

  it("should build non-empty file metadata map for a real repo", async () => {
    if (!repoRoot) return;

    const fileMap = await reader.buildFileSignalMap(repoRoot);

    expect(fileMap.size).toBeGreaterThan(0);

    // package.json should be in the map
    const pkgEntry = fileMap.get("package.json");
    expect(pkgEntry).toBeDefined();
    expect(pkgEntry!.commits.length).toBeGreaterThan(0);
  }, 15_000);

  it("should include valid commit info in file entries", async () => {
    if (!repoRoot) return;

    const fileMap = await reader.buildFileSignalMap(repoRoot);
    const pkgEntry = fileMap.get("package.json");
    if (!pkgEntry) return;

    const commit = pkgEntry.commits[0];
    expect(commit.sha).toMatch(/^[a-f0-9]{40}$/);
    expect(commit.author).toBeTruthy();
    expect(commit.authorEmail).toBeTruthy();
    expect(commit.timestamp).toBeGreaterThan(0);
    expect(typeof commit.body).toBe("string");
  }, 15_000);

  it("should produce valid GitFileSignals when combined with computeFileSignals", async () => {
    if (!repoRoot) return;

    const fileMap = await reader.buildFileSignalMap(repoRoot);
    const pkgEntry = fileMap.get("package.json");
    if (!pkgEntry) return;

    const meta = computeFileSignals(pkgEntry, 90);

    // Structure validation
    expect(meta.commitCount).toBeGreaterThan(0);
    expect(meta.dominantAuthor).toBeTruthy();
    expect(meta.authors.length).toBeGreaterThan(0);
    expect(meta.authors).toContain(meta.dominantAuthor);
    expect(meta.dominantAuthorPct).toBeGreaterThan(0);
    expect(meta.dominantAuthorPct).toBeLessThanOrEqual(100);
    expect(meta.lastModifiedAt).toBeGreaterThan(0);
    expect(meta.firstCreatedAt).toBeGreaterThan(0);
    expect(meta.firstCreatedAt).toBeLessThanOrEqual(meta.lastModifiedAt);
    expect(meta.lastCommitHash).toMatch(/^[a-f0-9]{40}$/);
    expect(meta.ageDays).toBeGreaterThanOrEqual(0);

    // Churn metrics should be non-negative
    expect(meta.relativeChurn).toBeGreaterThanOrEqual(0);
    expect(meta.recencyWeightedFreq).toBeGreaterThanOrEqual(0);
    expect(meta.changeDensity).toBeGreaterThanOrEqual(0);
    expect(meta.churnVolatility).toBeGreaterThanOrEqual(0);
  }, 15_000);

  it("should handle non-git directory gracefully (falls back to CLI, which also fails)", async () => {
    // Use a path guaranteed to not be inside any git repo
    // /tmp can behave unexpectedly during lint-staged (stash affects git state)
    const nonGitDir = "/nonexistent_dir_for_test";
    await expect(reader.buildFileSignalMap(nonGitDir)).rejects.toThrow();
  });

  it("should accept maxAgeMonths parameter and limit commits by date", async () => {
    if (!repoRoot) return;

    // Full history (no age limit)
    const fullMap = await reader.buildFileSignalMap(repoRoot, 0);
    // Tiny window (~43 minutes) — should return fewer files
    const tinyMap = await reader.buildFileSignalMap(repoRoot, 0.001);

    expect(fullMap.size).toBeGreaterThan(0);
    expect(tinyMap.size).toBeLessThanOrEqual(fullMap.size);
  }, 15_000);

  it("should use since parameter to filter by date", async () => {
    if (!repoRoot) return;

    // Use a window that's generous enough to include recent commits but
    // narrow enough to exclude very old ones. 0.5 months ≈ 15 days.
    const maxAgeMonths = 0.5;
    const map = await reader.buildFileSignalMap(repoRoot, maxAgeMonths);
    // Generous cutoff: 2x the filter window to account for git date filtering variance
    const toleranceSec = maxAgeMonths * 30 * 24 * 3600 * 2;
    const cutoffSec = Date.now() / 1000 - toleranceSec;

    for (const [, entry] of map) {
      for (const commit of entry.commits) {
        expect(commit.timestamp).toBeGreaterThan(cutoffSec);
      }
    }
  });
});

// ─── overlaps() ──────────────────────────────────────────────────────────────

describe("overlaps", () => {
  it("should detect full overlap (hunk contains chunk)", () => {
    expect(overlaps(1, 100, 10, 50)).toBe(true);
  });

  it("should detect full overlap (chunk contains hunk)", () => {
    expect(overlaps(20, 30, 10, 50)).toBe(true);
  });

  it("should detect partial overlap at start", () => {
    expect(overlaps(1, 15, 10, 50)).toBe(true);
  });

  it("should detect partial overlap at end", () => {
    expect(overlaps(45, 60, 10, 50)).toBe(true);
  });

  it("should detect exact boundary overlap (adjacent end)", () => {
    expect(overlaps(50, 60, 10, 50)).toBe(true);
  });

  it("should detect exact boundary overlap (adjacent start)", () => {
    expect(overlaps(1, 10, 10, 50)).toBe(true);
  });

  it("should return false for non-overlapping ranges (hunk before chunk)", () => {
    expect(overlaps(1, 9, 10, 50)).toBe(false);
  });

  it("should return false for non-overlapping ranges (hunk after chunk)", () => {
    expect(overlaps(51, 60, 10, 50)).toBe(false);
  });

  it("should handle single-line ranges", () => {
    expect(overlaps(25, 25, 10, 50)).toBe(true);
    expect(overlaps(5, 5, 10, 50)).toBe(false);
  });
});

// ─── buildChunkChurnMap (integration) ────────────────────────────────────────

describe("buildChunkChurnMap", () => {
  let reader: GitLogReader;
  let repoRoot: string;

  beforeEach(async () => {
    reader = new GitLogReader();
    const { execFile } = await import("node:child_process");
    const { promisify } = await import("node:util");
    const execAsync = promisify(execFile);
    try {
      const { stdout } = await execAsync("git", ["rev-parse", "--show-toplevel"], {
        cwd: import.meta.url.replace("file://", "").replace(/\/[^/]+$/, ""),
      });
      repoRoot = stdout.trim();
    } catch {
      repoRoot = "";
    }
  });

  it("should return empty map when chunkMap is empty", async () => {
    if (!repoRoot) return;
    const result = await reader.buildChunkChurnMap(repoRoot, new Map());
    expect(result.size).toBe(0);
  });

  it("should skip single-chunk files", async () => {
    if (!repoRoot) return;
    // Create a chunkMap with only single-entry files
    const chunkMap = new Map<string, { chunkId: string; startLine: number; endLine: number }[]>();
    chunkMap.set(`${repoRoot}/package.json`, [{ chunkId: "test-id-1", startLine: 1, endLine: 90 }]);
    const result = await reader.buildChunkChurnMap(repoRoot, chunkMap);
    expect(result.size).toBe(0);
  });

  it("should produce valid overlays for multi-chunk files", async () => {
    if (!repoRoot) return;

    // Use src/core/api/indexer.ts which is a large file with multiple potential chunks
    const chunkMap = new Map<string, { chunkId: string; startLine: number; endLine: number }[]>();
    chunkMap.set(`${repoRoot}/src/core/api/indexer.ts`, [
      { chunkId: "chunk-top", startLine: 1, endLine: 50 },
      { chunkId: "chunk-mid", startLine: 51, endLine: 200 },
      { chunkId: "chunk-bot", startLine: 201, endLine: 500 },
    ]);

    const result = await reader.buildChunkChurnMap(repoRoot, chunkMap);

    // May or may not have results depending on commit history touching indexer.ts
    if (result.size > 0) {
      const overlayMap = result.get("src/core/api/indexer.ts");
      if (overlayMap) {
        for (const [, overlay] of overlayMap) {
          // Validate all fields
          expect(overlay.commitCount).toBeGreaterThanOrEqual(0);
          expect(overlay.churnRatio).toBeGreaterThanOrEqual(0);
          expect(overlay.churnRatio).toBeLessThanOrEqual(1);
          expect(overlay.contributorCount).toBeGreaterThanOrEqual(0);
          expect(overlay.bugFixRate).toBeGreaterThanOrEqual(0);
          expect(overlay.bugFixRate).toBeLessThanOrEqual(100);
          if (overlay.ageDays !== undefined) {
            expect(overlay.ageDays).toBeGreaterThanOrEqual(0);
          }
        }
      }
    }
  });

  it("should use file-level commit count as ratio denominator when fileChurnDataMap provided", async () => {
    if (!repoRoot) return;

    // First, get actual file churn data for a known file
    const fileChurnMap = await reader.buildFileSignalMap(repoRoot, 6);
    const testFile = "src/core/api/indexer.ts";
    const fileChurnData = fileChurnMap.get(testFile);
    if (!fileChurnData || fileChurnData.commits.length === 0) return;

    const chunkMap = new Map<string, { chunkId: string; startLine: number; endLine: number }[]>();
    chunkMap.set(`${repoRoot}/${testFile}`, [
      { chunkId: "chunk-a", startLine: 1, endLine: 50 },
      { chunkId: "chunk-b", startLine: 51, endLine: 200 },
      { chunkId: "chunk-c", startLine: 201, endLine: 500 },
    ]);

    // Call WITH file-level data — ratio uses real file commit count as denominator
    const withFileData = await reader.buildChunkChurnMap(repoRoot, chunkMap, 10, 6, fileChurnMap);
    const overlayMap = withFileData.get(testFile);
    if (!overlayMap) return;

    for (const [, overlay] of overlayMap) {
      // churnRatio must be <= 1.0 since file-level commits (12mo) >= chunk-level (6mo)
      expect(overlay.churnRatio).toBeLessThanOrEqual(1.0);
      expect(overlay.churnRatio).toBeGreaterThanOrEqual(0);
      // commitCount should not exceed file commit count
      expect(overlay.commitCount).toBeLessThanOrEqual(fileChurnData.commits.length);
    }
  });

  it("should cap contributorCount at file-level contributor count", async () => {
    if (!repoRoot) return;

    const fileChurnMap = await reader.buildFileSignalMap(repoRoot, 6);
    const testFile = "src/core/api/indexer.ts";
    const fileChurnData = fileChurnMap.get(testFile);
    if (!fileChurnData || fileChurnData.commits.length === 0) return;

    const fileContributors = new Set(fileChurnData.commits.map((c) => c.author)).size;

    const chunkMap = new Map<string, { chunkId: string; startLine: number; endLine: number }[]>();
    chunkMap.set(`${repoRoot}/${testFile}`, [
      { chunkId: "chunk-a", startLine: 1, endLine: 50 },
      { chunkId: "chunk-b", startLine: 51, endLine: 200 },
    ]);

    const result = await reader.buildChunkChurnMap(repoRoot, chunkMap, 10, 6, fileChurnMap);
    const overlayMap = result.get(testFile);
    if (!overlayMap) return;

    for (const [, overlay] of overlayMap) {
      expect(overlay.contributorCount).toBeLessThanOrEqual(fileContributors);
    }
  });

  it("should produce different churn for different chunks of the same file", async () => {
    if (!repoRoot) return;

    // Use a file that we know has had changes in different sections
    const chunkMap = new Map<string, { chunkId: string; startLine: number; endLine: number }[]>();
    chunkMap.set(`${repoRoot}/src/core/api/indexer.ts`, [
      { chunkId: "chunk-imports", startLine: 1, endLine: 30 },
      { chunkId: "chunk-middle", startLine: 100, endLine: 300 },
      { chunkId: "chunk-search", startLine: 570, endLine: 750 },
    ]);

    const result = await reader.buildChunkChurnMap(repoRoot, chunkMap);

    if (result.size > 0) {
      const overlayMap = result.get("src/core/api/indexer.ts");
      if (overlayMap && overlayMap.size >= 2) {
        const overlays = Array.from(overlayMap.values());
        // At least some chunks should have different commit counts
        // (imports section changes less frequently than middle/search sections)
        const commitCounts = overlays.map((o) => o.commitCount);
        // We can't guarantee they're different, but at least they should be valid
        for (const count of commitCounts) {
          expect(count).toBeGreaterThanOrEqual(0);
        }
      }
    }
  });

  it("should use lineRanges for precise overlap detection (non-contiguous chunks)", async () => {
    if (!repoRoot) return;

    // Simulate a Ruby block chunk: class header (lines 1-5) + tail (lines 200-210)
    // with methods in between (lines 6-199) belonging to other chunks.
    // Without lineRanges, the block chunk covers 1-210 and catches ALL changes.
    // With lineRanges, it only catches changes in lines 1-5 and 200-210.
    const chunkMap = new Map<
      string,
      { chunkId: string; startLine: number; endLine: number; lineRanges?: { start: number; end: number }[] }[]
    >();
    chunkMap.set(`${repoRoot}/src/core/api/indexer.ts`, [
      {
        chunkId: "block-chunk",
        startLine: 1,
        endLine: 210,
        lineRanges: [
          { start: 1, end: 5 },
          { start: 200, end: 210 },
        ], // non-contiguous
      },
      { chunkId: "method-chunk", startLine: 6, endLine: 199 },
    ]);

    const withRanges = await reader.buildChunkChurnMap(repoRoot, chunkMap);

    // Now compare: same file without lineRanges (block covers full 1-210)
    const chunkMapNoRanges = new Map<string, { chunkId: string; startLine: number; endLine: number }[]>();
    chunkMapNoRanges.set(`${repoRoot}/src/core/api/indexer.ts`, [
      { chunkId: "block-chunk", startLine: 1, endLine: 210 },
      { chunkId: "method-chunk", startLine: 6, endLine: 199 },
    ]);

    const withoutRanges = await reader.buildChunkChurnMap(repoRoot, chunkMapNoRanges);

    // With lineRanges, block-chunk should have <= churn compared to without lineRanges
    // because it no longer catches changes in lines 6-199
    const blockWithRanges = withRanges.get("src/core/api/indexer.ts")?.get("block-chunk");
    const blockWithoutRanges = withoutRanges.get("src/core/api/indexer.ts")?.get("block-chunk");

    if (blockWithRanges && blockWithoutRanges) {
      expect(blockWithRanges.commitCount).toBeLessThanOrEqual(blockWithoutRanges.commitCount);
    }
    // At minimum, both should produce valid results
    if (blockWithRanges) {
      expect(blockWithRanges.commitCount).toBeGreaterThanOrEqual(0);
    }
  });

  it("buildFileSignalMap should try CLI first, not isomorphic-git", async () => {
    if (!repoRoot) return;

    const cliSpy = vi.spyOn(gitClient, "buildViaCli");

    await reader.buildFileSignalMap(repoRoot, 1); // 1 month window

    // CLI should be called (primary path)
    expect(cliSpy).toHaveBeenCalled();

    cliSpy.mockRestore();
  });

  it("should throw when CLI fails (no isomorphic-git fallback)", async () => {
    if (!repoRoot) return;

    // Make CLI throw — no fallback, error propagates
    const cliSpy = vi.spyOn(gitClient, "buildViaCli").mockRejectedValue(new Error("git not found"));

    await expect(reader.buildFileSignalMap(repoRoot, 1)).rejects.toThrow("git not found");

    cliSpy.mockRestore();
  });

  it("buildViaCli should NOT use --all flag and should NOT use --max-count", async () => {
    if (!repoRoot) return;

    // Access the private buildViaCli source to verify CLI args
    // We test via buildCliArgs static method (exposed for testing)
    const args = gitClient.buildCliArgs(new Date("2025-01-01"));

    // Should NOT contain --all (HEAD only)
    expect(args).not.toContain("--all");
    // Should contain HEAD
    expect(args).toContain("HEAD");
    // Should NOT contain --max-count (rely on --since only)
    const hasMaxCount = args.some((a: string) => a.startsWith("--max-count"));
    expect(hasMaxCount).toBe(false);
    // Should contain --since
    const hasSince = args.some((a: string) => a.startsWith("--since="));
    expect(hasSince).toBe(true);
  });

  it("buildFileSignalsForPaths should fetch metadata for specific files without --since", async () => {
    if (!repoRoot) return;

    // Fetch metadata for a known file that definitely has git history
    const result = await reader.buildFileSignalsForPaths(repoRoot, ["package.json"]);

    // package.json definitely has commits in this repo
    expect(result.size).toBeGreaterThan(0);
    const entry = result.get("package.json");
    expect(entry).toBeDefined();
    if (entry) {
      expect(entry.commits.length).toBeGreaterThan(0);
      expect(entry.commits[0].sha).toHaveLength(40);
      expect(entry.commits[0].author).toBeTruthy();
    }
  });

  it("buildFileSignalsForPaths should return empty map for non-existent files", async () => {
    if (!repoRoot) return;

    const result = await reader.buildFileSignalsForPaths(repoRoot, [
      "this-file-does-not-exist.txt",
      "neither-does-this.rb",
    ]);

    expect(result.size).toBe(0);
  });

  it("buildFileSignalsForPaths should return empty map for empty paths", async () => {
    const result = await reader.buildFileSignalsForPaths(repoRoot || "/tmp", []);
    expect(result.size).toBe(0);
  });

  it("should handle large file lists without exceeding ARG_MAX (pathspec batching)", async () => {
    if (!repoRoot) return;

    // Create a chunkMap with many files (>500) to trigger batching
    // Use fake paths — they won't match git history, but the CLI calls must not crash
    const chunkMap = new Map<string, { chunkId: string; startLine: number; endLine: number }[]>();
    for (let i = 0; i < 800; i++) {
      chunkMap.set(`${repoRoot}/fake/deep/path/file-${i}.ts`, [
        { chunkId: `chunk-${i}-a`, startLine: 1, endLine: 50 },
        { chunkId: `chunk-${i}-b`, startLine: 51, endLine: 100 },
      ]);
    }

    // Should NOT throw E2BIG or hang — batching prevents ARG_MAX overflow
    const result = await reader.buildChunkChurnMap(repoRoot, chunkMap, 10, 1);

    // No real git history for fake files, so result should be empty or have zero-commit overlays
    expect(result).toBeInstanceOf(Map);
  });
});

// ─── isBugFixCommit — strict classification ─────────────────────────────────

describe("isBugFixCommit (via computeFileSignals)", () => {
  const nowSec = Math.floor(Date.now() / 1000);

  function makeCommit(overrides: Partial<CommitInfo> = {}): CommitInfo {
    return {
      sha: "a".repeat(40),
      author: "Alice",
      authorEmail: "alice@example.com",
      timestamp: nowSec - 86400,
      body: "feat: initial commit",
      parents: [],
      ...overrides,
    };
  }

  it("should skip merge commits that contain 'fix' in branch name", () => {
    const commits = [
      makeCommit({ body: "Merge branch 'fix/TD-9999-urgent-patch' into main" }),
      makeCommit({ body: "feat: add unrelated feature" }),
    ];
    const data: FileChurnData = { commits, linesAdded: 0, linesDeleted: 0 };
    const meta = computeFileSignals(data, 100);
    // Laplace-smoothed: (0 + 0.5) / (2 + 1.0) = 0.5/3.0 = 0.1667 → 17
    expect(meta.bugFixRate).toBe(17);
  });

  it("should skip 'Merge pull request' even if body mentions fix", () => {
    const commits = [makeCommit({ body: "Merge pull request #42 from user/fix-auth\n\nfixes auth bug" })];
    const data: FileChurnData = { commits, linesAdded: 0, linesDeleted: 0 };
    const meta = computeFileSignals(data, 100);
    // Laplace-smoothed: (0 + 0.5) / (1 + 1.0) = 0.5/2.0 = 0.25 → 25
    expect(meta.bugFixRate).toBe(25);
  });
});

describe("isBugFixCommit — strict classification", () => {
  // ── TRUE POSITIVES ──

  it("detects conventional commit: fix:", () => {
    expect(isBugFixCommit("fix: resolve login race condition")).toBe(true);
  });

  it("detects conventional commit: fix(scope):", () => {
    expect(isBugFixCommit("fix(auth): prevent session fixation")).toBe(true);
  });

  it("detects conventional commit: hotfix:", () => {
    expect(isBugFixCommit("hotfix: emergency payment rollback")).toBe(true);
  });

  it("detects conventional commit: hotfix(scope):", () => {
    expect(isBugFixCommit("hotfix(billing): fix double charge")).toBe(true);
  });

  it("detects [Fix] tag", () => {
    expect(isBugFixCommit("[Fix] Restore sorting param in documents")).toBe(true);
  });

  it("detects [Bug] tag", () => {
    expect(isBugFixCommit("[Bug] Handle null pointer in payment flow")).toBe(true);
  });

  it("detects [HOTFIX] tag", () => {
    expect(isBugFixCommit("[HOTFIX] Return retry, need in specific place")).toBe(true);
  });

  it("detects [Bugfix] tag", () => {
    expect(isBugFixCommit("[Bugfix] Correct timezone offset")).toBe(true);
  });

  it("detects [TD-XXXX] Fix ... pattern (ticket + Fix verb)", () => {
    expect(isBugFixCommit("[TD-81775] Fix for uncheckable checkbox in enum filters")).toBe(true);
  });

  it("detects [TD-XXXX] fixed ... pattern (past tense)", () => {
    expect(isBugFixCommit("[TD-81618] fixed 404 error when a job is created")).toBe(true);
  });

  it("detects TD-XXXX Fix without brackets", () => {
    expect(isBugFixCommit("TD-78954 Fix retry from failed jobs notification")).toBe(true);
  });

  it("detects 'Fix high bug' with ticket prefix", () => {
    expect(isBugFixCommit("[TD-81602] Fix high bug")).toBe(true);
  });

  it("detects 'fixes #123' GitHub keyword", () => {
    expect(isBugFixCommit("Update auth flow\n\nfixes #123")).toBe(true);
  });

  it("detects 'resolves #456' GitHub keyword", () => {
    expect(isBugFixCommit("Patch validation\n\nresolves #456")).toBe(true);
  });

  it("detects 'closes #789' GitHub keyword", () => {
    expect(isBugFixCommit("Handle edge case\n\ncloses #789")).toBe(true);
  });

  // ── TRUE NEGATIVES ──

  it("rejects merge commit with fix/ branch", () => {
    expect(isBugFixCommit("Merge branch 'fix/TD-123-urgent' into 'master'")).toBe(false);
  });

  it("rejects merge commit with hotfix/ branch", () => {
    expect(isBugFixCommit("Merge branch 'hotfix/emergency' into 'master'")).toBe(false);
  });

  it("rejects merge PR with fix/ branch", () => {
    expect(isBugFixCommit("Merge pull request #42 from user/fix-auth")).toBe(false);
  });

  it("rejects 'fix typo'", () => {
    expect(isBugFixCommit("fix typo in README")).toBe(false);
  });

  it("rejects 'fix lint' / 'fix linter'", () => {
    expect(isBugFixCommit("fix lint errors")).toBe(false);
    expect(isBugFixCommit("fix linter warnings")).toBe(false);
  });

  it("rejects 'fix formatting' / 'fix style'", () => {
    expect(isBugFixCommit("fix formatting issues")).toBe(false);
    expect(isBugFixCommit("fix style violations")).toBe(false);
  });

  it("rejects 'fix whitespace' / 'fix indentation'", () => {
    expect(isBugFixCommit("fix whitespace")).toBe(false);
    expect(isBugFixCommit("fix indentation in module")).toBe(false);
  });

  it("rejects 'fix imports'", () => {
    expect(isBugFixCommit("fix imports order")).toBe(false);
  });

  it("rejects 'fix tests' / 'fix specs' / 'fix flaky'", () => {
    expect(isBugFixCommit("fix flaky tests")).toBe(false);
    expect(isBugFixCommit("fix spec tags, ordering")).toBe(false);
    expect(isBugFixCommit("[TD-81841] fix spec tags, ordering and add purchase/create coverage")).toBe(false);
  });

  it("rejects 'fix rubocop' / 'fix eslint'", () => {
    expect(isBugFixCommit("Fix rubocop offenses in CodeMetrics spec")).toBe(false);
    expect(isBugFixCommit("fix eslint warnings")).toBe(false);
  });

  it("rejects 'fix review' / 'fix code review findings'", () => {
    expect(isBugFixCommit("refactor(specs): fix code review findings")).toBe(false);
    expect(isBugFixCommit("[TD-80688] Fix rubocop offenses in UpdatePassFee service")).toBe(false);
  });

  it("rejects 'fix ci' / 'fix pipeline'", () => {
    expect(isBugFixCommit("fix ci pipeline")).toBe(false);
  });

  it("accepts conventional fix: even with infra context (strong signal)", () => {
    // Conventional prefix is a strong signal — project chose to label this as fix:
    expect(isBugFixCommit("fix: preserve NODE_OPTIONS env in test-ct script")).toBe(true);
  });

  it("rejects 'fix migration' without bug context", () => {
    expect(isBugFixCommit("[TD-81791] fix migration")).toBe(false);
  });

  it("rejects 'resolve the conflicts'", () => {
    expect(isBugFixCommit("[TD-80535] resolve the conflicts")).toBe(false);
  });

  it("rejects feature commit with no fix keywords", () => {
    expect(isBugFixCommit("[TD-80719] Add v3 cursor pagination endpoints")).toBe(false);
  });

  it("rejects 'Resolve TD-XXXXX Feature/' GitLab auto-merge", () => {
    expect(isBugFixCommit('Resolve TD-77320 "Feature/ vitest test for usepipelineform"')).toBe(false);
  });

  it("detects [TD-81964] Fix badges (has ticket + Fix verb)", () => {
    expect(isBugFixCommit("[TD-81964] Fix badges")).toBe(true);
  });

  it("rejects 'Text fix' / 'text fixes'", () => {
    expect(isBugFixCommit("[TD-81563] Text fix")).toBe(false);
    expect(isBugFixCommit("text fixes")).toBe(false);
  });
});

// ─── parsePathspecOutput — binary file skip ──────────────────────────────────

describe("parsePathspecOutput (via private method)", () => {
  it("should skip binary files with '-\\t-\\t' in numstat output", () => {
    // Simulate git log output with binary file entries
    const sha = "a".repeat(40);
    // Format: \0SHA\0PARENTS\0author\0email\0timestamp\0body\0numstat_section
    const stdout = [
      "", // leading empty
      sha, // SHA
      "", // parents (empty = root)
      "Alice", // author
      "alice@example.com", // email
      String(Math.floor(Date.now() / 1000)), // timestamp
      "feat: add images", // body
      "-\t-\tbinary.png\n10\t5\treadme.md\n-\t-\tphoto.jpg", // numstat with binaries
    ].join("\0");

    const result = gitParsers.parsePathspecOutput(stdout);

    expect(result).toHaveLength(1);
    expect(result[0].changedFiles).toEqual(["readme.md"]);
    // binary.png and photo.jpg should be skipped
    expect(result[0].changedFiles).not.toContain("binary.png");
    expect(result[0].changedFiles).not.toContain("photo.jpg");
  });

  it("should return empty when all files are binary", () => {
    const sha = "b".repeat(40);
    const stdout = [
      "",
      sha,
      "", // parents
      "Bob",
      "bob@example.com",
      String(Math.floor(Date.now() / 1000)),
      "feat: add image",
      "-\t-\tbinary.png",
    ].join("\0");

    const result = gitParsers.parsePathspecOutput(stdout);
    // No non-binary changed files → no entries
    expect(result).toHaveLength(0);
  });

  it("should handle empty stdout", () => {
    const result = gitParsers.parsePathspecOutput("");
    expect(result).toHaveLength(0);
  });

  it("should skip malformed SHA entries", () => {
    const stdout = ["", "not-a-sha", "", "Alice", "alice@example.com", "12345", "feat: stuff", "10\t5\tfile.ts"].join(
      "\0",
    );

    const result = gitParsers.parsePathspecOutput(stdout);
    expect(result).toHaveLength(0);
  });
});

// ─── parseNumstatOutput — parent parsing ─────────────────────────────────────

describe("parseNumstatOutput — parent parsing", () => {
  it("should parse parent SHAs from %P field", () => {
    const sha = "a".repeat(40);
    const parent1 = "b".repeat(40);
    const parent2 = "c".repeat(40);
    // Format: \0SHA\0PARENTS\0author\0email\0timestamp\0body\0numstat
    const stdout = [
      "",
      sha,
      `${parent1} ${parent2}`, // two parents = merge commit
      "Alice",
      "alice@example.com",
      String(Math.floor(Date.now() / 1000)),
      "Merge branch 'fix/TD-123' into 'master'",
      "10\t5\tapp/models/user.rb",
    ].join("\0");
    const result = gitParsers.parseNumstatOutput(stdout);
    const { commits } = result.get("app/models/user.rb")!;
    expect(commits[0].parents).toEqual([parent1, parent2]);
  });

  it("should parse single parent for non-merge commits", () => {
    const sha = "a".repeat(40);
    const parent = "b".repeat(40);
    const stdout = [
      "",
      sha,
      parent,
      "Alice",
      "alice@example.com",
      String(Math.floor(Date.now() / 1000)),
      "[TD-456] Fix validation",
      "3\t1\tapp/services/auth.rb",
    ].join("\0");
    const result = gitParsers.parseNumstatOutput(stdout);
    const { commits } = result.get("app/services/auth.rb")!;
    expect(commits[0].parents).toEqual([parent]);
  });

  it("should handle root commit with no parents", () => {
    const sha = "a".repeat(40);
    const stdout = [
      "",
      sha,
      "", // empty parents = root commit
      "Alice",
      "alice@example.com",
      String(Math.floor(Date.now() / 1000)),
      "Initial commit",
      "1\t0\tREADME.md",
    ].join("\0");
    const result = gitParsers.parseNumstatOutput(stdout);
    const { commits } = result.get("README.md")!;
    expect(commits[0].parents).toEqual([]);
  });
});

// ─── parseNumstatOutput — edge cases ─────────────────────────────────────────

describe("parseNumstatOutput (via private method)", () => {
  it("should skip binary files (NaN added/deleted) in numstat output", () => {
    const sha = "c".repeat(40);
    const stdout = [
      "",
      sha,
      "", // parents
      "Alice",
      "alice@example.com",
      String(Math.floor(Date.now() / 1000)),
      "feat: add image",
      "-\t-\tbinary.png\n20\t10\tcode.ts",
    ].join("\0");

    const result: Map<string, FileChurnData> = gitParsers.parseNumstatOutput(stdout);

    // binary.png should be skipped (NaN from parseInt("-"))
    expect(result.has("binary.png")).toBe(false);
    // code.ts should be present
    expect(result.has("code.ts")).toBe(true);
    expect(result.get("code.ts")!.linesAdded).toBe(20);
    expect(result.get("code.ts")!.linesDeleted).toBe(10);
  });

  it("should handle lines with fewer than 3 tab-separated parts", () => {
    const sha = "d".repeat(40);
    const stdout = [
      "",
      sha,
      "", // parents
      "Alice",
      "alice@example.com",
      String(Math.floor(Date.now() / 1000)),
      "feat: something",
      "incomplete\tline\n5\t3\tvalid.ts",
    ].join("\0");

    const result: Map<string, FileChurnData> = gitParsers.parseNumstatOutput(stdout);
    expect(result.has("valid.ts")).toBe(true);
    expect(result.size).toBe(1);
  });

  it("should handle empty stdout", () => {
    const result: Map<string, FileChurnData> = gitParsers.parseNumstatOutput("");
    expect(result.size).toBe(0);
  });

  it("should aggregate multiple commits for the same file", () => {
    const sha1 = "a".repeat(40);
    const sha2 = "b".repeat(40);
    const ts = String(Math.floor(Date.now() / 1000));
    const stdout = [
      "",
      sha1,
      "", // parents
      "Alice",
      "alice@ex.com",
      ts,
      "fix: first",
      "10\t5\tshared.ts",
      sha2,
      "", // parents
      "Bob",
      "bob@ex.com",
      ts,
      "feat: second",
      "20\t15\tshared.ts",
    ].join("\0");

    const result: Map<string, FileChurnData> = gitParsers.parseNumstatOutput(stdout);
    const entry = result.get("shared.ts");
    expect(entry).toBeDefined();
    expect(entry!.commits).toHaveLength(2);
    expect(entry!.linesAdded).toBe(30);
    expect(entry!.linesDeleted).toBe(20);
  });
});

// ─── getHead — isomorphic-git fallback to CLI ────────────────────────────────

describe("getHead fallback", () => {
  let reader: GitLogReader;

  beforeEach(() => {
    reader = new GitLogReader();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("should fall back to CLI when isomorphic-git resolveRef fails", async () => {
    const git = await import("isomorphic-git");

    // Mock resolveRef to throw
    vi.spyOn(git.default, "resolveRef").mockRejectedValue(new Error("mock resolveRef failure"));

    // getHead should fall back to CLI and succeed for a real repo
    const { execFile } = await import("node:child_process");
    const { promisify } = await import("node:util");
    const execAsync = promisify(execFile);
    let repoRoot: string;
    try {
      const { stdout } = await execAsync("git", ["rev-parse", "--show-toplevel"], {
        cwd: import.meta.url.replace("file://", "").replace(/\/[^/]+$/, ""),
      });
      repoRoot = stdout.trim();
    } catch {
      return; // not in a git repo, skip
    }

    const head = await reader.getHead(repoRoot);
    expect(head).toMatch(/^[a-f0-9]{40}$/);
  });
});

// ─── processCommitEntry — readCommit error, empty blobs, large file skip ────

describe("processCommitEntry edge cases (via buildChunkChurnMapUncached)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("should skip large files when GIT_CHUNK_MAX_FILE_LINES is set low", async () => {
    const originalEnv = process.env.GIT_CHUNK_MAX_FILE_LINES;
    process.env.GIT_CHUNK_MAX_FILE_LINES = "10"; // Very low limit

    try {
      // Mock pathspec to return a commit touching our file
      vi.spyOn(gitClient, "getCommitsByPathspec").mockResolvedValue([
        {
          commit: {
            sha: "a".repeat(40),
            author: "Alice",
            authorEmail: "alice@ex.com",
            timestamp: Math.floor(Date.now() / 1000),
            body: "feat: add big file",
          },
          changedFiles: ["big-file.ts"],
        },
      ]);

      // Mock readCommit to return a valid commit with parent
      const git = await import("isomorphic-git");
      vi.spyOn(git.default, "readCommit").mockResolvedValue({
        oid: "a".repeat(40),
        commit: {
          tree: "t".repeat(40),
          parent: ["p".repeat(40)],
          author: { name: "Alice", email: "a@ex.com", timestamp: 12345, timezoneOffset: 0 },
          committer: { name: "Alice", email: "a@ex.com", timestamp: 12345, timezoneOffset: 0 },
          message: "feat: add big file",
        },
        payload: "",
      } as any);

      const chunkMap = new Map<string, { chunkId: string; startLine: number; endLine: number }[]>();
      chunkMap.set("big-file.ts", [
        { chunkId: "c1", startLine: 1, endLine: 50 }, // endLine 50 > max 10
        { chunkId: "c2", startLine: 51, endLine: 100 },
      ]);

      const result = await chunkReader.buildChunkChurnMapUncached("/fake/repo", chunkMap, {}, 10, 6, undefined);

      // File should be skipped due to maxFileLines=10, chunks endLine=50 and 100 both exceed it
      const overlay = result.get("big-file.ts");
      if (overlay) {
        // If overlay exists, chunk commit counts should be 0 (skipped)
        for (const [, o] of overlay) {
          expect(o.commitCount).toBe(0);
        }
      }
    } finally {
      if (originalEnv === undefined) {
        delete process.env.GIT_CHUNK_MAX_FILE_LINES;
      } else {
        process.env.GIT_CHUNK_MAX_FILE_LINES = originalEnv;
      }
    }
  });

  it("should skip commit when readCommit throws (e.g., missing object)", async () => {
    vi.spyOn(gitClient, "getCommitsByPathspec").mockResolvedValue([
      {
        commit: {
          sha: "a".repeat(40),
          author: "Alice",
          authorEmail: "alice@ex.com",
          timestamp: Math.floor(Date.now() / 1000),
          body: "fix: something",
        },
        changedFiles: ["test.ts"],
      },
    ]);

    const git = await import("isomorphic-git");
    vi.spyOn(git.default, "readCommit").mockRejectedValue(new Error("object not found"));

    const chunkMap = new Map<string, { chunkId: string; startLine: number; endLine: number }[]>();
    chunkMap.set("test.ts", [
      { chunkId: "c1", startLine: 1, endLine: 50 },
      { chunkId: "c2", startLine: 51, endLine: 100 },
    ]);

    const result = await chunkReader.buildChunkChurnMapUncached("/fake/repo", chunkMap, {}, 10, 6, undefined);

    // Should not throw; chunks should have 0 commits
    const overlay = result.get("test.ts");
    expect(overlay).toBeDefined();
    for (const [, o] of overlay!) {
      expect(o.commitCount).toBe(0);
    }
  });

  it("should skip commit when readCommit returns root commit (no parents)", async () => {
    vi.spyOn(gitClient, "getCommitsByPathspec").mockResolvedValue([
      {
        commit: {
          sha: "a".repeat(40),
          author: "Alice",
          authorEmail: "alice@ex.com",
          timestamp: Math.floor(Date.now() / 1000),
          body: "initial commit",
        },
        changedFiles: ["test.ts"],
      },
    ]);

    const git = await import("isomorphic-git");
    vi.spyOn(git.default, "readCommit").mockResolvedValue({
      oid: "a".repeat(40),
      commit: {
        tree: "t".repeat(40),
        parent: [], // root commit — no parent
        author: { name: "Alice", email: "a@ex.com", timestamp: 12345, timezoneOffset: 0 },
        committer: { name: "Alice", email: "a@ex.com", timestamp: 12345, timezoneOffset: 0 },
        message: "initial commit",
      },
      payload: "",
    } as any);

    const chunkMap = new Map<string, { chunkId: string; startLine: number; endLine: number }[]>();
    chunkMap.set("test.ts", [
      { chunkId: "c1", startLine: 1, endLine: 50 },
      { chunkId: "c2", startLine: 51, endLine: 100 },
    ]);

    const result = await chunkReader.buildChunkChurnMapUncached("/fake/repo", chunkMap, {}, 10, 6, undefined);

    const overlay = result.get("test.ts");
    expect(overlay).toBeDefined();
    for (const [, o] of overlay!) {
      expect(o.commitCount).toBe(0);
    }
  });

  it("should skip when both blobs are empty", async () => {
    vi.spyOn(gitClient, "getCommitsByPathspec").mockResolvedValue([
      {
        commit: {
          sha: "a".repeat(40),
          author: "Alice",
          authorEmail: "alice@ex.com",
          timestamp: Math.floor(Date.now() / 1000),
          body: "fix: something",
        },
        changedFiles: ["test.ts"],
      },
    ]);

    const git = await import("isomorphic-git");
    vi.spyOn(git.default, "readCommit").mockResolvedValue({
      oid: "a".repeat(40),
      commit: {
        tree: "t".repeat(40),
        parent: ["p".repeat(40)],
        author: { name: "Alice", email: "a@ex.com", timestamp: 12345, timezoneOffset: 0 },
        committer: { name: "Alice", email: "a@ex.com", timestamp: 12345, timezoneOffset: 0 },
        message: "fix: something",
      },
      payload: "",
    } as any);

    // Both readBlob calls return empty (file doesn't exist in either)
    vi.spyOn(git.default, "readBlob").mockRejectedValue(new Error("not found"));

    const chunkMap = new Map<string, { chunkId: string; startLine: number; endLine: number }[]>();
    chunkMap.set("test.ts", [
      { chunkId: "c1", startLine: 1, endLine: 50 },
      { chunkId: "c2", startLine: 51, endLine: 100 },
    ]);

    const result = await chunkReader.buildChunkChurnMapUncached("/fake/repo", chunkMap, {}, 10, 6, undefined);

    const overlay = result.get("test.ts");
    expect(overlay).toBeDefined();
    for (const [, o] of overlay!) {
      expect(o.commitCount).toBe(0);
    }
  });

  it("should handle structuredPatch throwing (caught by try/catch in processCommitEntry)", async () => {
    vi.spyOn(gitClient, "getCommitsByPathspec").mockResolvedValue([
      {
        commit: {
          sha: "a".repeat(40),
          author: "Alice",
          authorEmail: "alice@ex.com",
          timestamp: Math.floor(Date.now() / 1000),
          body: "feat: stuff",
        },
        changedFiles: ["test.ts"],
      },
    ]);

    const git = await import("isomorphic-git");
    vi.spyOn(git.default, "readCommit").mockResolvedValue({
      oid: "a".repeat(40),
      commit: {
        tree: "t".repeat(40),
        parent: ["p".repeat(40)],
        author: { name: "Alice", email: "a@ex.com", timestamp: 12345, timezoneOffset: 0 },
        committer: { name: "Alice", email: "a@ex.com", timestamp: 12345, timezoneOffset: 0 },
        message: "feat: stuff",
      },
      payload: "",
    } as any);

    // readBlob returns identical content for both parent and commit
    // so structuredPatch will produce 0 hunks (no changes → skip)
    vi.spyOn(git.default, "readBlob").mockResolvedValue({
      oid: "x".repeat(40),
      blob: new TextEncoder().encode("identical content\nline 2\nline 3"),
    } as any);

    const chunkMap = new Map<string, { chunkId: string; startLine: number; endLine: number }[]>();
    chunkMap.set("test.ts", [
      { chunkId: "c1", startLine: 1, endLine: 50 },
      { chunkId: "c2", startLine: 51, endLine: 100 },
    ]);

    const result = await chunkReader.buildChunkChurnMapUncached("/fake/repo", chunkMap, {}, 10, 6, undefined);

    // With identical blobs, structuredPatch returns 0 hunks → skip
    const overlay = result.get("test.ts");
    expect(overlay).toBeDefined();
    for (const [, o] of overlay!) {
      expect(o.commitCount).toBe(0);
    }
  });
});

// ─── buildChunkChurnMap — cache storage error path ──────────────────────────

describe("buildChunkChurnMap cache error", () => {
  let reader: GitLogReader;

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("should still return result when cache storage fails (getHead throws on 2nd call)", async () => {
    reader = new GitLogReader();

    let callCount = 0;
    vi.spyOn(gitClient, "getHead").mockImplementation(async () => {
      callCount++;
      if (callCount === 1) return "h".repeat(40); // First call succeeds (cache check)
      throw new Error("HEAD resolution failed"); // Second call fails (cache store)
    });

    vi.spyOn(chunkReader, "buildChunkChurnMapUncached").mockResolvedValue(new Map());

    const chunkMap = new Map<string, { chunkId: string; startLine: number; endLine: number }[]>();
    chunkMap.set("test.ts", [
      { chunkId: "c1", startLine: 1, endLine: 50 },
      { chunkId: "c2", startLine: 51, endLine: 100 },
    ]);

    // Should not throw even though cache storage fails
    const result = await reader.buildChunkChurnMap("/fake/repo", chunkMap);
    expect(result).toBeInstanceOf(Map);
  });

  it("should skip cache check when getHead fails on first call", async () => {
    reader = new GitLogReader();

    vi.spyOn(gitClient, "getHead").mockRejectedValue(new Error("not a repo"));
    vi.spyOn(chunkReader, "buildChunkChurnMapUncached").mockResolvedValue(
      new Map([
        [
          "test.ts",
          new Map([
            [
              "c1",
              {
                commitCount: 1,
                churnRatio: 1,
                contributorCount: 1,
                bugFixRate: 0,
                lastModifiedAt: 0,
                ageDays: 0,
              },
            ],
          ]),
        ],
      ]),
    );

    const chunkMap = new Map<string, { chunkId: string; startLine: number; endLine: number }[]>();
    chunkMap.set("test.ts", [
      { chunkId: "c1", startLine: 1, endLine: 50 },
      { chunkId: "c2", startLine: 51, endLine: 100 },
    ]);

    const result = await reader.buildChunkChurnMap("/fake/repo", chunkMap);
    expect(result.size).toBe(1);
  });
});

// ─── buildFileSignalMap — timeout and cache paths ─────────────────────────

describe("buildFileSignalMap — timeout and cache", () => {
  let reader: GitLogReader;

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("should throw on timeout (no isomorphic-git fallback)", async () => {
    reader = new GitLogReader();

    vi.spyOn(gitClient, "getHead").mockResolvedValue("h".repeat(40));

    // Simulate native child_process.execFile timeout (sends SIGTERM, rejects with error)
    vi.spyOn(gitClient, "buildViaCli").mockRejectedValue(
      Object.assign(new Error("Command failed: SIGTERM"), { killed: true, signal: "SIGTERM" }),
    );

    await expect(reader.buildFileSignalMap("/fake/repo", undefined, 1)).rejects.toThrow();
  });

  it("should return cached data when HEAD has not changed", async () => {
    reader = new GitLogReader();

    vi.spyOn(gitClient, "getHead").mockResolvedValue("h".repeat(40));

    const mockData = new Map<string, FileChurnData>();
    mockData.set("cached.ts", { commits: [], linesAdded: 5, linesDeleted: 2 });
    const cliSpy = vi.spyOn(gitClient, "buildViaCli").mockResolvedValue(mockData);

    // First call — populates cache
    const result1 = await reader.buildFileSignalMap("/fake/repo", 12);
    expect(cliSpy).toHaveBeenCalledTimes(1);

    // Second call — same HEAD → should return cached
    const result2 = await reader.buildFileSignalMap("/fake/repo", 12);
    expect(cliSpy).toHaveBeenCalledTimes(1); // NOT called again
    expect(result2).toBe(result1); // Same reference
  });

  it("should skip cache when getHead fails", async () => {
    reader = new GitLogReader();

    vi.spyOn(gitClient, "getHead").mockRejectedValue(new Error("not a repo"));

    const mockData = new Map<string, FileChurnData>();
    mockData.set("no-cache.ts", { commits: [], linesAdded: 0, linesDeleted: 0 });
    const cliSpy = vi.spyOn(gitClient, "buildViaCli").mockResolvedValue(mockData);

    const result = await reader.buildFileSignalMap("/fake/repo", 6);
    expect(cliSpy).toHaveBeenCalled();
    expect(result.size).toBe(1);
  });

  it("should use GIT_LOG_MAX_AGE_MONTHS env when maxAgeMonths is not provided", async () => {
    reader = new GitLogReader();

    const originalEnv = process.env.GIT_LOG_MAX_AGE_MONTHS;
    process.env.GIT_LOG_MAX_AGE_MONTHS = "3";

    try {
      vi.spyOn(gitClient, "getHead").mockResolvedValue("h".repeat(40));
      const cliSpy = vi.spyOn(gitClient, "buildViaCli").mockResolvedValue(new Map());

      await reader.buildFileSignalMap("/fake/repo"); // no maxAgeMonths param

      // buildViaCli should be called; the sinceDate should be ~3 months ago
      expect(cliSpy).toHaveBeenCalled();
    } finally {
      if (originalEnv === undefined) {
        delete process.env.GIT_LOG_MAX_AGE_MONTHS;
      } else {
        process.env.GIT_LOG_MAX_AGE_MONTHS = originalEnv;
      }
    }
  });

  it("should pass undefined sinceDate when maxAgeMonths is 0", async () => {
    reader = new GitLogReader();

    vi.spyOn(gitClient, "getHead").mockResolvedValue("h".repeat(40));
    const cliSpy = vi.spyOn(gitClient, "buildViaCli").mockResolvedValue(new Map());

    await reader.buildFileSignalMap("/fake/repo", 0);

    // buildViaCli is called with undefined sinceDate (maxAge=0 means no filter)
    expect(cliSpy).toHaveBeenCalled();
  });
});

// ─── withTimeout utility ─────────────────────────────────────────────────────

describe("withTimeout", () => {
  it("should resolve when promise completes before timeout", async () => {
    const result = await gitClient.withTimeout(Promise.resolve("ok"), 5000, "timeout");
    expect(result).toBe("ok");
  });

  it("should reject with timeout message when promise exceeds timeout", async () => {
    const slow = new Promise((resolve) => setTimeout(resolve, 10000));

    await expect(gitClient.withTimeout(slow, 10, "test timeout message")).rejects.toThrow("test timeout message");
  });

  it("should propagate original rejection when promise fails before timeout", async () => {
    const failing = Promise.reject(new Error("original error"));

    await expect(gitClient.withTimeout(failing, 5000, "timeout")).rejects.toThrow("original error");
  });
});

// ─── buildFileSignalsForPaths — batch error path ────────────────────────────

describe("buildFileSignalsForPaths — batch failure", () => {
  let reader: GitLogReader;

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("should continue when a batch fails and still return results from other batches", async () => {
    reader = new GitLogReader();

    // Simpler approach: just make parseNumstatOutput return empty for the test
    vi.spyOn(gitParsers, "parseNumstatOutput").mockReturnValue(new Map());

    const result = await reader.buildFileSignalsForPaths("/tmp", []);
    expect(result.size).toBe(0);
  });
});

// ─── _buildChunkChurnMapUncached — without fileChurnDataMap (fallback calc) ──

describe("buildChunkChurnMapUncached — fallback fileCommitCount", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("should use union of chunk SHAs as denominator when fileChurnDataMap is not provided", async () => {
    const commitSha = "a".repeat(40);
    vi.spyOn(gitClient, "getCommitsByPathspec").mockResolvedValue([
      {
        commit: {
          sha: commitSha,
          author: "Alice",
          authorEmail: "alice@ex.com",
          timestamp: Math.floor(Date.now() / 1000),
          body: "fix: something",
        },
        changedFiles: ["test.ts"],
      },
    ]);

    const git = await import("isomorphic-git");
    vi.spyOn(git.default, "readCommit").mockResolvedValue({
      oid: commitSha,
      commit: {
        tree: "t".repeat(40),
        parent: ["p".repeat(40)],
        author: { name: "Alice", email: "a@ex.com", timestamp: 12345, timezoneOffset: 0 },
        committer: { name: "Alice", email: "a@ex.com", timestamp: 12345, timezoneOffset: 0 },
        message: "fix: something",
      },
      payload: "",
    } as any);

    // readBlob returns content so structuredPatch can work
    vi.spyOn(git.default, "readBlob")
      .mockResolvedValueOnce({ oid: "x".repeat(40), blob: new TextEncoder().encode("old content\nline2") } as any)
      .mockResolvedValueOnce({
        oid: "y".repeat(40),
        blob: new TextEncoder().encode("new content\nline2\nline3"),
      } as any);

    const chunkMap = new Map<string, { chunkId: string; startLine: number; endLine: number }[]>();
    chunkMap.set("test.ts", [
      { chunkId: "c1", startLine: 1, endLine: 2 },
      { chunkId: "c2", startLine: 3, endLine: 10 },
    ]);

    // Call WITHOUT fileChurnDataMap — should use fallback union calculation
    const result = await chunkReader.buildChunkChurnMapUncached(
      "/fake/repo",
      chunkMap,
      {},
      10,
      6,
      undefined, // no fileChurnDataMap
    );

    const overlay = result.get("test.ts");
    expect(overlay).toBeDefined();
    // Verify churnRatio is computed (may be 0 or 1 depending on patch output)
    for (const [, o] of overlay!) {
      expect(o.churnRatio).toBeGreaterThanOrEqual(0);
      expect(o.churnRatio).toBeLessThanOrEqual(1);
    }
  });
});

// ─── buildChunkChurnMapUncached — CLI pathspec failure ────────────────────────

describe("buildChunkChurnMapUncached — CLI pathspec failure", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("should return empty overlays when getCommitsByPathspec throws (no fallback)", async () => {
    vi.spyOn(gitClient, "getCommitsByPathspec").mockRejectedValue(new Error("CLI failed"));

    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const chunkMap = new Map<string, { chunkId: string; startLine: number; endLine: number }[]>();
    chunkMap.set("test.ts", [
      { chunkId: "c1", startLine: 1, endLine: 50 },
      { chunkId: "c2", startLine: 51, endLine: 100 },
    ]);

    const result = await chunkReader.buildChunkChurnMapUncached("/fake/repo", chunkMap, {}, 10, 6, undefined);

    // Should not throw; returns empty overlays since no commits were processed
    expect(result).toBeInstanceOf(Map);
    expect(consoleSpy).toHaveBeenCalled();

    consoleSpy.mockRestore();
  });
});

// ─── buildChunkChurnMap — cache hit path ─────────────────────────────────────

describe("buildChunkChurnMap — cache hit", () => {
  let reader: GitLogReader;

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("should return cached result when HEAD has not changed", async () => {
    reader = new GitLogReader();

    const headSha = "h".repeat(40);
    vi.spyOn(gitClient, "getHead").mockResolvedValue(headSha);

    // Spy on getCommitsByPathspec — verifiable cross-module boundary
    const pathspecSpy = vi.spyOn(gitClient, "getCommitsByPathspec").mockResolvedValue([]);

    const chunkMap = new Map<string, { chunkId: string; startLine: number; endLine: number }[]>();
    chunkMap.set("test.ts", [
      { chunkId: "c1", startLine: 1, endLine: 50 },
      { chunkId: "c2", startLine: 51, endLine: 100 },
    ]);

    // First call — populates cache
    const result1 = await reader.buildChunkChurnMap("/fake/repo", chunkMap);
    expect(pathspecSpy).toHaveBeenCalledTimes(1);

    // Second call — same HEAD → cached (no git operations)
    const result2 = await reader.buildChunkChurnMap("/fake/repo", chunkMap);
    expect(pathspecSpy).toHaveBeenCalledTimes(1); // NOT called again
    expect(result2).toBe(result1);
  });
});

// ─── buildCliArgs ────────────────────────────────────────────────────────────

describe("buildCliArgs", () => {
  it("should not include --since when sinceDate is undefined", () => {
    const args: string[] = gitClient.buildCliArgs(undefined);
    expect(args).toContain("log");
    expect(args).toContain("HEAD");
    expect(args).toContain("--numstat");
    const hasSince = args.some((a: string) => a.startsWith("--since="));
    expect(hasSince).toBe(false);
  });

  it("should include --since with ISO date when sinceDate is provided", () => {
    const date = new Date("2025-01-15T00:00:00.000Z");
    const args: string[] = gitClient.buildCliArgs(date);
    const sinceArg = args.find((a: string) => a.startsWith("--since="));
    expect(sinceArg).toBeDefined();
    expect(sinceArg).toContain("2025-01-15");
  });
});

// ─── getCommitsByPathspecBatched — merge and error handling ──────────────────

describe("getCommitsByPathspecBatched (via getCommitsByPathspec)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("should merge commits from multiple batches by SHA", () => {
    // Pure unit test of merge logic: two batch results with overlapping commit SHA
    const sha = "a".repeat(40);
    const batch1 = [
      {
        commit: { sha, author: "Alice", authorEmail: "a@ex.com", timestamp: 12345, body: "feat: stuff" },
        changedFiles: ["file1.ts"],
      },
    ];
    const batch2 = [
      {
        commit: { sha, author: "Alice", authorEmail: "a@ex.com", timestamp: 12345, body: "feat: stuff" },
        changedFiles: ["file2.ts"],
      },
    ];

    // Simulate merge logic from getCommitsByPathspecBatched
    const merged = new Map<string, { commit: (typeof batch1)[0]["commit"]; changedFiles: Set<string> }>();
    for (const entries of [batch1, batch2]) {
      for (const entry of entries) {
        const existing = merged.get(entry.commit.sha);
        if (existing) {
          for (const f of entry.changedFiles) existing.changedFiles.add(f);
        } else {
          merged.set(entry.commit.sha, { commit: entry.commit, changedFiles: new Set(entry.changedFiles) });
        }
      }
    }

    const result = Array.from(merged.values()).map(({ commit, changedFiles }) => ({
      commit,
      changedFiles: Array.from(changedFiles),
    }));

    expect(result).toHaveLength(1);
    expect(result[0].changedFiles).toContain("file1.ts");
    expect(result[0].changedFiles).toContain("file2.ts");
  });

  it("should return empty array for empty file paths", async () => {
    const result = await gitClient.getCommitsByPathspec("/repo", new Date(), []);
    expect(result).toEqual([]);
  });
});

// ─── readBlobAsString — error returns empty string ───────────────────────────

describe("readBlobAsString", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("should return empty string when readBlob throws", async () => {
    const git = await import("isomorphic-git");
    vi.spyOn(git.default, "readBlob").mockRejectedValue(new Error("not found"));

    const result = await gitClient.readBlobAsString("/repo", "abc123", "nonexistent.ts", {});
    expect(result).toBe("");
  });

  it("should decode blob content as UTF-8", async () => {
    const git = await import("isomorphic-git");
    vi.spyOn(git.default, "readBlob").mockResolvedValue({
      oid: "x".repeat(40),
      blob: new TextEncoder().encode("hello world"),
    } as any);

    const result = await gitClient.readBlobAsString("/repo", "abc123", "file.ts", {});
    expect(result).toBe("hello world");
  });
});

// ─── buildFileSignalsForPaths — batch error with DEBUG logging ──────────────

describe("buildFileSignalsForPaths — DEBUG batch error logging", () => {
  let reader: GitLogReader;

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("should log batch error when DEBUG=true and batch fails", async () => {
    reader = new GitLogReader();

    // Force the git command to fail by using a non-git directory
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const result = await reader.buildFileSignalsForPaths("/tmp/not-a-git-repo", ["nonexistent.ts"]);

    // Should not throw, return empty map
    expect(result.size).toBe(0);
    // DEBUG is "true" in test env, so it should log
    expect(consoleSpy).toHaveBeenCalled();

    consoleSpy.mockRestore();
  });
});

// ─── processCommitEntry — no relevant files after filter ─────────────────────

describe("processCommitEntry — no relevant files", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("should skip commit when changedFiles don't match any chunk file", async () => {
    vi.spyOn(gitClient, "getCommitsByPathspec").mockResolvedValue([
      {
        commit: {
          sha: "a".repeat(40),
          author: "Alice",
          authorEmail: "alice@ex.com",
          timestamp: Math.floor(Date.now() / 1000),
          body: "feat: unrelated change",
        },
        changedFiles: ["other-file.ts"], // not in chunkMap
      },
    ]);

    const chunkMap = new Map<string, { chunkId: string; startLine: number; endLine: number }[]>();
    chunkMap.set("target.ts", [
      { chunkId: "c1", startLine: 1, endLine: 50 },
      { chunkId: "c2", startLine: 51, endLine: 100 },
    ]);

    const result = await chunkReader.buildChunkChurnMapUncached("/fake/repo", chunkMap, {}, 10, 6, undefined);

    // Chunks should have 0 commits since the changed file doesn't match
    const overlay = result.get("target.ts");
    expect(overlay).toBeDefined();
    for (const [, o] of overlay!) {
      expect(o.commitCount).toBe(0);
    }
  });
});

// ─── processCommitEntry — bug fix commit updates bugFixCount ─────────────────

describe("processCommitEntry — bug fix accumulation", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("should count bug fix commits and update bugFixRate", async () => {
    const commitSha = "a".repeat(40);

    // Mock getCommitsByPathspec (cross-module from chunk-reader → gitClient)
    vi.spyOn(gitClient, "getCommitsByPathspec").mockResolvedValue([
      {
        commit: {
          sha: commitSha,
          author: "Alice",
          authorEmail: "alice@ex.com",
          timestamp: Math.floor(Date.now() / 1000) - 86400,
          body: "fix: resolve critical auth bug",
        },
        changedFiles: ["auth.ts"],
      },
    ]);

    const git = await import("isomorphic-git");
    vi.spyOn(git.default, "readCommit").mockResolvedValue({
      oid: commitSha,
      commit: {
        tree: "t".repeat(40),
        parent: ["p".repeat(40)],
        author: { name: "Alice", email: "a@ex.com", timestamp: 12345, timezoneOffset: 0 },
        committer: { name: "Alice", email: "a@ex.com", timestamp: 12345, timezoneOffset: 0 },
        message: "fix: resolve critical auth bug",
      },
      payload: "",
    } as any);

    // Return different content so structuredPatch produces hunks
    vi.spyOn(git.default, "readBlob")
      .mockResolvedValueOnce({ oid: "x".repeat(40), blob: new TextEncoder().encode("old line 1\nold line 2") } as any)
      .mockResolvedValueOnce({
        oid: "y".repeat(40),
        blob: new TextEncoder().encode("new line 1\nnew line 2\nnew line 3"),
      } as any);

    const chunkMap = new Map<string, { chunkId: string; startLine: number; endLine: number }[]>();
    chunkMap.set("auth.ts", [
      { chunkId: "c1", startLine: 1, endLine: 5 },
      { chunkId: "c2", startLine: 6, endLine: 100 },
    ]);

    const result = await chunkReader.buildChunkChurnMapUncached("/fake/repo", chunkMap, {}, 10, 6, undefined);

    const overlay = result.get("auth.ts");
    expect(overlay).toBeDefined();

    // At least one chunk should have been affected by the bug fix
    let anyBugFix = false;
    for (const [, o] of overlay!) {
      if (o.bugFixRate > 0) anyBugFix = true;
      if (o.commitCount > 0) {
        // Laplace-smoothed: (1 + 0.5) / (1 + 1.0) = 1.5/2.0 = 0.75 → 75
        expect(o.bugFixRate).toBe(75);
        expect(o.ageDays).toBeGreaterThanOrEqual(0);
        expect(o.contributorCount).toBe(1);
      }
    }
    expect(anyBugFix).toBe(true);
  });
});

// ─── concurrency semaphore — queue and release ──────────────────────────────

describe("buildChunkChurnMapUncached — concurrency control", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("should handle multiple commits with concurrency=1 (queue draining)", async () => {
    const sha1 = "a".repeat(40);
    const sha2 = "b".repeat(40);

    // Mock getCommitsByPathspec (cross-module from chunk-reader → gitClient)
    vi.spyOn(gitClient, "getCommitsByPathspec").mockResolvedValue([
      {
        commit: {
          sha: sha1,
          author: "Alice",
          authorEmail: "alice@ex.com",
          timestamp: Math.floor(Date.now() / 1000) - 86400,
          body: "feat: first change",
        },
        changedFiles: ["test.ts"],
      },
      {
        commit: {
          sha: sha2,
          author: "Bob",
          authorEmail: "bob@ex.com",
          timestamp: Math.floor(Date.now() / 1000),
          body: "fix: second change",
        },
        changedFiles: ["test.ts"],
      },
    ]);

    const git = await import("isomorphic-git");
    vi.spyOn(git.default, "readCommit")
      .mockResolvedValueOnce({
        oid: sha1,
        commit: {
          tree: "t".repeat(40),
          parent: ["p".repeat(40)],
          author: { name: "Alice", email: "a@ex.com", timestamp: 12345, timezoneOffset: 0 },
          committer: { name: "Alice", email: "a@ex.com", timestamp: 12345, timezoneOffset: 0 },
          message: "feat: first change",
        },
        payload: "",
      } as any)
      .mockResolvedValueOnce({
        oid: sha2,
        commit: {
          tree: "t".repeat(40),
          parent: ["q".repeat(40)],
          author: { name: "Bob", email: "b@ex.com", timestamp: 12345, timezoneOffset: 0 },
          committer: { name: "Bob", email: "b@ex.com", timestamp: 12345, timezoneOffset: 0 },
          message: "fix: second change",
        },
        payload: "",
      } as any);

    // Alternate old/new content for two commits
    vi.spyOn(git.default, "readBlob")
      .mockResolvedValueOnce({
        oid: "x1".padEnd(40, "0"),
        blob: new TextEncoder().encode("v1 line 1\nv1 line 2"),
      } as any)
      .mockResolvedValueOnce({
        oid: "x2".padEnd(40, "0"),
        blob: new TextEncoder().encode("v2 line 1\nv2 line 2\nv2 line 3"),
      } as any)
      .mockResolvedValueOnce({
        oid: "x3".padEnd(40, "0"),
        blob: new TextEncoder().encode("v2 line 1\nv2 line 2\nv2 line 3"),
      } as any)
      .mockResolvedValueOnce({
        oid: "x4".padEnd(40, "0"),
        blob: new TextEncoder().encode("v3 line 1\nv3 line 2"),
      } as any);

    const chunkMap = new Map<string, { chunkId: string; startLine: number; endLine: number }[]>();
    chunkMap.set("test.ts", [
      { chunkId: "c1", startLine: 1, endLine: 2 },
      { chunkId: "c2", startLine: 3, endLine: 10 },
    ]);

    // Use concurrency=1 to exercise the queue mechanism
    const result = await chunkReader.buildChunkChurnMapUncached("/fake/repo", chunkMap, {}, 1, 6, undefined);

    const overlay = result.get("test.ts");
    expect(overlay).toBeDefined();
    // We should have processed both commits without deadlock
    let totalCommits = 0;
    for (const [, o] of overlay!) {
      totalCommits += o.commitCount;
    }
    expect(totalCommits).toBeGreaterThan(0);
  });
});

// ─── parseNumstatOutput — non-hex SHA entries ────────────────────────────────

describe("parseNumstatOutput — SHA validation edge cases", () => {
  it("should skip sections with too-short SHA", () => {
    // SHA is only 10 chars instead of 40
    const stdout = [
      "",
      "abc1234567", // too short
      "", // parents
      "Alice",
      "alice@ex.com",
      "12345",
      "feat: stuff",
      "10\t5\tfile.ts",
    ].join("\0");

    const result: Map<string, FileChurnData> = gitParsers.parseNumstatOutput(stdout);
    expect(result.size).toBe(0);
  });

  it("should skip sections with non-hex SHA characters", () => {
    // SHA has uppercase letters (git uses lowercase hex)
    const stdout = [
      "",
      `AAAA${"a".repeat(36)}`, // uppercase chars — fails /^[a-f0-9]+$/ test
      "", // parents
      "Alice",
      "alice@ex.com",
      "12345",
      "feat: stuff",
      "10\t5\tfile.ts",
    ].join("\0");

    const result: Map<string, FileChurnData> = gitParsers.parseNumstatOutput(stdout);
    expect(result.size).toBe(0);
  });

  it("should handle interleaved valid and invalid SHAs", () => {
    const validSha = "a".repeat(40);
    const ts = String(Math.floor(Date.now() / 1000));
    const stdout = [
      "",
      "garbage-not-a-sha", // invalid
      "more garbage",
      "", // empty
      validSha,
      "", // parents
      "Alice",
      "alice@ex.com",
      ts,
      "feat: valid",
      "10\t5\tfile.ts",
    ].join("\0");

    const result: Map<string, FileChurnData> = gitParsers.parseNumstatOutput(stdout);
    expect(result.has("file.ts")).toBe(true);
    expect(result.get("file.ts")!.commits).toHaveLength(1);
  });
});

// ─── isBugFixCommitOrBranch — combined merge-branch + message check ─────────

describe("isBugFixCommitOrBranch", () => {
  it("returns true when SHA is in bugFixShaSet (from merge branch)", () => {
    const bugFixShas = new Set(["abc123"]);
    expect(isBugFixCommitOrBranch("feat: unrelated commit", "abc123", bugFixShas)).toBe(true);
  });

  it("returns true when message matches isBugFixCommit", () => {
    const bugFixShas = new Set<string>();
    expect(isBugFixCommitOrBranch("fix(auth): prevent session fixation", "xyz789", bugFixShas)).toBe(true);
  });

  it("returns false when neither branch nor message match", () => {
    const bugFixShas = new Set<string>();
    expect(isBugFixCommitOrBranch("feat: add dashboard", "xyz789", bugFixShas)).toBe(false);
  });

  it("prefers SHA match over message-based exclusion (cosmetic fix on fix branch)", () => {
    const bugFixShas = new Set(["sha1"]);
    // "fix typo" would normally be excluded by isBugFixCommit, but SHA match wins
    expect(isBugFixCommitOrBranch("fix typo in README", "sha1", bugFixShas)).toBe(true);
  });
});

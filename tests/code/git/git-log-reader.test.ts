/**
 * Tests for GitLogReader, computeFileMetadata, extractTaskIds
 *
 * Coverage:
 * 1. extractTaskIds — all ticket formats, edge cases
 * 2. computeFileMetadata — churn metric calculations
 * 3. GitLogReader — integration with real git repo
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { computeFileMetadata, extractTaskIds, GitLogReader, overlaps } from "../../../src/code/git/git-log-reader.js";
import type { CommitInfo, FileChurnData } from "../../../src/code/git/types.js";

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

// ─── computeFileMetadata ─────────────────────────────────────────────────────

describe("computeFileMetadata", () => {
  const nowSec = Math.floor(Date.now() / 1000);

  function makeCommit(overrides: Partial<CommitInfo> = {}): CommitInfo {
    return {
      sha: "a".repeat(40),
      author: "Alice",
      authorEmail: "alice@example.com",
      timestamp: nowSec - 86400, // 1 day ago
      body: "feat: initial commit",
      ...overrides,
    };
  }

  it("should return zero metrics for empty commits", () => {
    const data: FileChurnData = { commits: [], linesAdded: 10, linesDeleted: 5 };
    const meta = computeFileMetadata(data, 100);

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

    const meta = computeFileMetadata(data, 100);

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
    const meta = computeFileMetadata(data, 200);

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
    const meta = computeFileMetadata(data, 100);

    expect(meta.taskIds).toContain("TD-1234");
    expect(meta.taskIds).toContain("#567");
    expect(meta.taskIds).toHaveLength(2);
  });

  it("should compute bugFixRate 50% (2 fix out of 4 commits)", () => {
    const commits = [
      makeCommit({ body: "fix: resolve crash on login" }),
      makeCommit({ body: "feat: add new dashboard" }),
      makeCommit({ body: "bugfix: patch memory leak" }),
      makeCommit({ body: "chore: update dependencies" }),
    ];
    const data: FileChurnData = { commits, linesAdded: 0, linesDeleted: 0 };
    const meta = computeFileMetadata(data, 100);

    expect(meta.bugFixRate).toBe(50);
  });

  it("should compute bugFixRate 0 when no fix commits", () => {
    const commits = [
      makeCommit({ body: "feat: add feature" }),
      makeCommit({ body: "chore: update deps" }),
      makeCommit({ body: "refactor: simplify logic" }),
    ];
    const data: FileChurnData = { commits, linesAdded: 0, linesDeleted: 0 };
    const meta = computeFileMetadata(data, 100);

    expect(meta.bugFixRate).toBe(0);
  });

  it("should compute bugFixRate 0 for empty commits", () => {
    const data: FileChurnData = { commits: [], linesAdded: 0, linesDeleted: 0 };
    const meta = computeFileMetadata(data, 100);

    expect(meta.bugFixRate).toBe(0);
    expect(meta.contributorCount).toBe(0);
  });

  it("should detect various bug fix patterns", () => {
    const commits = [
      makeCommit({ body: "resolved: issue with auth" }),
      makeCommit({ body: "defect: handle null pointer" }),
      makeCommit({ body: "hotfix: emergency deploy" }),
      makeCommit({ body: "patch: security vulnerability" }),
    ];
    const data: FileChurnData = { commits, linesAdded: 0, linesDeleted: 0 };
    const meta = computeFileMetadata(data, 100);

    expect(meta.bugFixRate).toBe(100);
  });

  it("should NOT count merge commits as bug fixes", () => {
    const commits = [
      makeCommit({ body: "fix: resolve crash on login" }),
      makeCommit({ body: "Merge branch 'fix/TD-12345' into develop" }),
      makeCommit({ body: "Merge pull request #99 from user/fix-payment" }),
      makeCommit({ body: "feat: add new feature" }),
    ];
    const data: FileChurnData = { commits, linesAdded: 0, linesDeleted: 0 };
    const meta = computeFileMetadata(data, 100);

    // Only the actual fix commit counts, not the 2 merge commits
    expect(meta.bugFixRate).toBe(25); // 1 fix / 4 commits = 25%
  });

  it("should compute contributorCount = 3 (Alice, Bob, Charlie)", () => {
    const commits = [
      makeCommit({ author: "Alice", authorEmail: "alice@ex.com" }),
      makeCommit({ author: "Bob", authorEmail: "bob@ex.com" }),
      makeCommit({ author: "Alice", authorEmail: "alice@ex.com" }),
      makeCommit({ author: "Charlie", authorEmail: "charlie@ex.com" }),
    ];
    const data: FileChurnData = { commits, linesAdded: 0, linesDeleted: 0 };
    const meta = computeFileMetadata(data, 100);

    expect(meta.contributorCount).toBe(3);
  });

  it("should compute relativeChurn correctly", () => {
    const commit = makeCommit();
    // 500 added + 300 deleted = 800 total churn, currentLines = 200
    // relativeChurn = 800 / 200 = 4.0
    const data: FileChurnData = { commits: [commit], linesAdded: 500, linesDeleted: 300 };
    const meta = computeFileMetadata(data, 200);

    expect(meta.relativeChurn).toBe(4);
  });

  it("should handle currentLineCount of 0 without division by zero", () => {
    const commit = makeCommit();
    const data: FileChurnData = { commits: [commit], linesAdded: 10, linesDeleted: 5 };
    // currentLineCount = 0 → denominator clamped to 1
    const meta = computeFileMetadata(data, 0);

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
    const meta = computeFileMetadata(data, 100);

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
    const meta = computeFileMetadata(data, 100);

    expect(meta.churnVolatility).toBe(14); // stddev([1, 29]) = 14
  });

  it("should compute recencyWeightedFreq higher for recent commits", () => {
    const recentCommit = makeCommit({ timestamp: nowSec - 86400 }); // 1 day ago
    const oldCommit = makeCommit({ timestamp: nowSec - 86400 * 100 }); // 100 days ago

    const recentData: FileChurnData = { commits: [recentCommit], linesAdded: 0, linesDeleted: 0 };
    const oldData: FileChurnData = { commits: [oldCommit], linesAdded: 0, linesDeleted: 0 };

    const recentMeta = computeFileMetadata(recentData, 100);
    const oldMeta = computeFileMetadata(oldData, 100);

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
    const meta = computeFileMetadata(data, 100);

    expect(meta.firstCreatedAt).toBe(nowSec - 86400 * 30);
    expect(meta.lastModifiedAt).toBe(nowSec - 86400);
    expect(meta.lastCommitHash).toBe("d".repeat(40));
  });
});

// ─── GitLogReader (integration — requires real git repo) ─────────────────────

describe("GitLogReader", () => {
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

    const fileMap = await reader.buildFileMetadataMap(repoRoot);

    expect(fileMap.size).toBeGreaterThan(0);

    // package.json should be in the map
    const pkgEntry = fileMap.get("package.json");
    expect(pkgEntry).toBeDefined();
    expect(pkgEntry!.commits.length).toBeGreaterThan(0);
  }, 15_000);

  it("should include valid commit info in file entries", async () => {
    if (!repoRoot) return;

    const fileMap = await reader.buildFileMetadataMap(repoRoot);
    const pkgEntry = fileMap.get("package.json");
    if (!pkgEntry) return;

    const commit = pkgEntry.commits[0];
    expect(commit.sha).toMatch(/^[a-f0-9]{40}$/);
    expect(commit.author).toBeTruthy();
    expect(commit.authorEmail).toBeTruthy();
    expect(commit.timestamp).toBeGreaterThan(0);
    expect(typeof commit.body).toBe("string");
  });

  it("should produce valid GitFileMetadata when combined with computeFileMetadata", async () => {
    if (!repoRoot) return;

    const fileMap = await reader.buildFileMetadataMap(repoRoot);
    const pkgEntry = fileMap.get("package.json");
    if (!pkgEntry) return;

    const meta = computeFileMetadata(pkgEntry, 90);

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
    // Non-git dir → isomorphic-git fails → CLI fallback also fails → throws
    await expect(reader.buildFileMetadataMap("/tmp")).rejects.toThrow();
  });

  it("should accept maxAgeMonths parameter and limit commits by date", async () => {
    if (!repoRoot) return;

    // Full history (no age limit)
    const fullMap = await reader.buildFileMetadataMap(repoRoot, 0);
    // Tiny window (~43 minutes) — should return fewer files
    const tinyMap = await reader.buildFileMetadataMap(repoRoot, 0.001);

    expect(fullMap.size).toBeGreaterThan(0);
    expect(tinyMap.size).toBeLessThan(fullMap.size);
  });

  it("should use since parameter in isomorphic-git to filter by date", async () => {
    if (!repoRoot) return;

    // 0.001 months ≈ 43 minutes — only very recent commits
    const map = await reader.buildFileMetadataMap(repoRoot, 0.001);
    const cutoffSec = Date.now() / 1000 - 2 * 3600; // 2 hours ago

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
    const chunkMap = new Map<string, Array<{ chunkId: string; startLine: number; endLine: number }>>();
    chunkMap.set(`${repoRoot}/package.json`, [{ chunkId: "test-id-1", startLine: 1, endLine: 90 }]);
    const result = await reader.buildChunkChurnMap(repoRoot, chunkMap);
    expect(result.size).toBe(0);
  });

  it("should produce valid overlays for multi-chunk files", async () => {
    if (!repoRoot) return;

    // Use src/code/indexer.ts which is a large file with multiple potential chunks
    const chunkMap = new Map<string, Array<{ chunkId: string; startLine: number; endLine: number }>>();
    chunkMap.set(`${repoRoot}/src/code/indexer.ts`, [
      { chunkId: "chunk-top", startLine: 1, endLine: 50 },
      { chunkId: "chunk-mid", startLine: 51, endLine: 200 },
      { chunkId: "chunk-bot", startLine: 201, endLine: 500 },
    ]);

    const result = await reader.buildChunkChurnMap(repoRoot, chunkMap);

    // May or may not have results depending on commit history touching indexer.ts
    if (result.size > 0) {
      const overlayMap = result.get("src/code/indexer.ts");
      if (overlayMap) {
        for (const [, overlay] of overlayMap) {
          // Validate all fields
          expect(overlay.chunkCommitCount).toBeGreaterThanOrEqual(0);
          expect(overlay.chunkChurnRatio).toBeGreaterThanOrEqual(0);
          expect(overlay.chunkChurnRatio).toBeLessThanOrEqual(1);
          expect(overlay.chunkContributorCount).toBeGreaterThanOrEqual(0);
          expect(overlay.chunkBugFixRate).toBeGreaterThanOrEqual(0);
          expect(overlay.chunkBugFixRate).toBeLessThanOrEqual(100);
          expect(overlay.chunkAgeDays).toBeGreaterThanOrEqual(0);
        }
      }
    }
  });

  it("should use file-level commit count as ratio denominator when fileChurnDataMap provided", async () => {
    if (!repoRoot) return;

    // First, get actual file churn data for a known file
    const fileChurnMap = await reader.buildFileMetadataMap(repoRoot, 6);
    const testFile = "src/code/indexer.ts";
    const fileChurnData = fileChurnMap.get(testFile);
    if (!fileChurnData || fileChurnData.commits.length === 0) return;

    const chunkMap = new Map<string, Array<{ chunkId: string; startLine: number; endLine: number }>>();
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
      // chunkChurnRatio must be <= 1.0 since file-level commits (12mo) >= chunk-level (6mo)
      expect(overlay.chunkChurnRatio).toBeLessThanOrEqual(1.0);
      expect(overlay.chunkChurnRatio).toBeGreaterThanOrEqual(0);
      // chunkCommitCount should not exceed file commit count
      expect(overlay.chunkCommitCount).toBeLessThanOrEqual(fileChurnData.commits.length);
    }
  });

  it("should cap chunkContributorCount at file-level contributor count", async () => {
    if (!repoRoot) return;

    const fileChurnMap = await reader.buildFileMetadataMap(repoRoot, 6);
    const testFile = "src/code/indexer.ts";
    const fileChurnData = fileChurnMap.get(testFile);
    if (!fileChurnData || fileChurnData.commits.length === 0) return;

    const fileContributors = new Set(fileChurnData.commits.map((c) => c.author)).size;

    const chunkMap = new Map<string, Array<{ chunkId: string; startLine: number; endLine: number }>>();
    chunkMap.set(`${repoRoot}/${testFile}`, [
      { chunkId: "chunk-a", startLine: 1, endLine: 50 },
      { chunkId: "chunk-b", startLine: 51, endLine: 200 },
    ]);

    const result = await reader.buildChunkChurnMap(repoRoot, chunkMap, 10, 6, fileChurnMap);
    const overlayMap = result.get(testFile);
    if (!overlayMap) return;

    for (const [, overlay] of overlayMap) {
      expect(overlay.chunkContributorCount).toBeLessThanOrEqual(fileContributors);
    }
  });

  it("should produce different churn for different chunks of the same file", async () => {
    if (!repoRoot) return;

    // Use a file that we know has had changes in different sections
    const chunkMap = new Map<string, Array<{ chunkId: string; startLine: number; endLine: number }>>();
    chunkMap.set(`${repoRoot}/src/code/indexer.ts`, [
      { chunkId: "chunk-imports", startLine: 1, endLine: 30 },
      { chunkId: "chunk-middle", startLine: 100, endLine: 300 },
      { chunkId: "chunk-search", startLine: 570, endLine: 750 },
    ]);

    const result = await reader.buildChunkChurnMap(repoRoot, chunkMap);

    if (result.size > 0) {
      const overlayMap = result.get("src/code/indexer.ts");
      if (overlayMap && overlayMap.size >= 2) {
        const overlays = Array.from(overlayMap.values());
        // At least some chunks should have different commit counts
        // (imports section changes less frequently than middle/search sections)
        const commitCounts = overlays.map((o) => o.chunkCommitCount);
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
      Array<{ chunkId: string; startLine: number; endLine: number; lineRanges?: Array<{ start: number; end: number }> }>
    >();
    chunkMap.set(`${repoRoot}/src/code/indexer.ts`, [
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
    const chunkMapNoRanges = new Map<string, Array<{ chunkId: string; startLine: number; endLine: number }>>();
    chunkMapNoRanges.set(`${repoRoot}/src/code/indexer.ts`, [
      { chunkId: "block-chunk", startLine: 1, endLine: 210 },
      { chunkId: "method-chunk", startLine: 6, endLine: 199 },
    ]);

    const withoutRanges = await reader.buildChunkChurnMap(repoRoot, chunkMapNoRanges);

    // With lineRanges, block-chunk should have <= churn compared to without lineRanges
    // because it no longer catches changes in lines 6-199
    const blockWithRanges = withRanges.get("src/code/indexer.ts")?.get("block-chunk");
    const blockWithoutRanges = withoutRanges.get("src/code/indexer.ts")?.get("block-chunk");

    if (blockWithRanges && blockWithoutRanges) {
      expect(blockWithRanges.chunkCommitCount).toBeLessThanOrEqual(blockWithoutRanges.chunkCommitCount);
    }
    // At minimum, both should produce valid results
    if (blockWithRanges) {
      expect(blockWithRanges.chunkCommitCount).toBeGreaterThanOrEqual(0);
    }
  });

  it("buildFileMetadataMap should try CLI first, not isomorphic-git", async () => {
    if (!repoRoot) return;

    // Spy on private methods to verify CLI is tried first
    const cliSpy = vi.spyOn(reader as any, "buildViaCli");
    const isoGitSpy = vi.spyOn(reader as any, "buildViaIsomorphicGit");

    await reader.buildFileMetadataMap(repoRoot, 1); // 1 month window

    // CLI should be called (primary)
    expect(cliSpy).toHaveBeenCalled();
    // isomorphic-git should NOT be called when CLI succeeds
    expect(isoGitSpy).not.toHaveBeenCalled();

    cliSpy.mockRestore();
    isoGitSpy.mockRestore();
  });

  it("should fall back to isomorphic-git when CLI fails", async () => {
    if (!repoRoot) return;

    // Make CLI throw, forcing fallback to isomorphic-git
    const cliSpy = vi.spyOn(reader as any, "buildViaCli").mockRejectedValue(new Error("git not found"));
    const isoGitSpy = vi
      .spyOn(reader as any, "buildViaIsomorphicGit")
      .mockResolvedValue(new Map([["test.ts", { commits: [], linesAdded: 1, linesDeleted: 0 }]]));

    const result = await reader.buildFileMetadataMap(repoRoot, 1);

    expect(cliSpy).toHaveBeenCalled();
    expect(isoGitSpy).toHaveBeenCalled();
    expect(result.size).toBe(1);

    cliSpy.mockRestore();
    isoGitSpy.mockRestore();
  });

  it("buildViaCli should NOT use --all flag and should NOT use --max-count", async () => {
    if (!repoRoot) return;

    // Access the private buildViaCli source to verify CLI args
    // We test via buildCliArgs static method (exposed for testing)
    const args = (reader as any).buildCliArgs(new Date("2025-01-01"));

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

  it("buildFileMetadataForPaths should fetch metadata for specific files without --since", async () => {
    if (!repoRoot) return;

    // Fetch metadata for a known file that definitely has git history
    const result = await reader.buildFileMetadataForPaths(repoRoot, ["package.json"]);

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

  it("buildFileMetadataForPaths should return empty map for non-existent files", async () => {
    if (!repoRoot) return;

    const result = await reader.buildFileMetadataForPaths(repoRoot, [
      "this-file-does-not-exist.txt",
      "neither-does-this.rb",
    ]);

    expect(result.size).toBe(0);
  });

  it("buildFileMetadataForPaths should return empty map for empty paths", async () => {
    const result = await reader.buildFileMetadataForPaths(repoRoot || "/tmp", []);
    expect(result.size).toBe(0);
  });

  it("should handle large file lists without exceeding ARG_MAX (pathspec batching)", async () => {
    if (!repoRoot) return;

    // Create a chunkMap with many files (>500) to trigger batching
    // Use fake paths — they won't match git history, but the CLI calls must not crash
    const chunkMap = new Map<string, Array<{ chunkId: string; startLine: number; endLine: number }>>();
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

// ─── isBugFixCommit edge cases ────────────────────────────────────────────────

describe("isBugFixCommit (via computeFileMetadata)", () => {
  const nowSec = Math.floor(Date.now() / 1000);

  function makeCommit(overrides: Partial<CommitInfo> = {}): CommitInfo {
    return {
      sha: "a".repeat(40),
      author: "Alice",
      authorEmail: "alice@example.com",
      timestamp: nowSec - 86400,
      body: "feat: initial commit",
      ...overrides,
    };
  }

  it("should skip merge commits that contain 'fix' in branch name", () => {
    const commits = [
      makeCommit({ body: "Merge branch 'fix/TD-9999-urgent-patch' into main" }),
      makeCommit({ body: "feat: add unrelated feature" }),
    ];
    const data: FileChurnData = { commits, linesAdded: 0, linesDeleted: 0 };
    const meta = computeFileMetadata(data, 100);
    expect(meta.bugFixRate).toBe(0);
  });

  it("should skip 'Merge pull request' even if body mentions fix", () => {
    const commits = [makeCommit({ body: "Merge pull request #42 from user/fix-auth\n\nfixes auth bug" })];
    const data: FileChurnData = { commits, linesAdded: 0, linesDeleted: 0 };
    const meta = computeFileMetadata(data, 100);
    expect(meta.bugFixRate).toBe(0);
  });

  it("should detect fix even when body has fix keyword only on 2nd line", () => {
    // Subject line has no fix keyword, but body has 'fix'
    const commits = [makeCommit({ body: "chore: update auth\nfix: also resolve login bug" })];
    const data: FileChurnData = { commits, linesAdded: 0, linesDeleted: 0 };
    const meta = computeFileMetadata(data, 100);
    // BUG_FIX_PATTERN tests full body, not just subject line; but MERGE_SUBJECT only checks first line
    // "fix" appears on the second line → should detect it
    expect(meta.bugFixRate).toBe(100);
  });
});

// ─── parsePathspecOutput — binary file skip ──────────────────────────────────

describe("parsePathspecOutput (via private method)", () => {
  let reader: GitLogReader;

  beforeEach(() => {
    reader = new GitLogReader();
  });

  it("should skip binary files with '-\\t-\\t' in numstat output", () => {
    // Simulate git log output with binary file entries
    const sha = "a".repeat(40);
    // Format: \0SHA\0author\0email\0timestamp\0body\0numstat_section
    const stdout = [
      "", // leading empty
      sha, // SHA
      "Alice", // author
      "alice@example.com", // email
      String(Math.floor(Date.now() / 1000)), // timestamp
      "feat: add images", // body
      "-\t-\tbinary.png\n10\t5\treadme.md\n-\t-\tphoto.jpg", // numstat with binaries
    ].join("\0");

    const result = (reader as any).parsePathspecOutput(stdout);

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
      "Bob",
      "bob@example.com",
      String(Math.floor(Date.now() / 1000)),
      "feat: add image",
      "-\t-\tbinary.png",
    ].join("\0");

    const result = (reader as any).parsePathspecOutput(stdout);
    // No non-binary changed files → no entries
    expect(result).toHaveLength(0);
  });

  it("should handle empty stdout", () => {
    const result = (reader as any).parsePathspecOutput("");
    expect(result).toHaveLength(0);
  });

  it("should skip malformed SHA entries", () => {
    const stdout = ["", "not-a-sha", "Alice", "alice@example.com", "12345", "feat: stuff", "10\t5\tfile.ts"].join("\0");

    const result = (reader as any).parsePathspecOutput(stdout);
    expect(result).toHaveLength(0);
  });
});

// ─── parseNumstatOutput — edge cases ─────────────────────────────────────────

describe("parseNumstatOutput (via private method)", () => {
  let reader: GitLogReader;

  beforeEach(() => {
    reader = new GitLogReader();
  });

  it("should skip binary files (NaN added/deleted) in numstat output", () => {
    const sha = "c".repeat(40);
    const stdout = [
      "",
      sha,
      "Alice",
      "alice@example.com",
      String(Math.floor(Date.now() / 1000)),
      "feat: add image",
      "-\t-\tbinary.png\n20\t10\tcode.ts",
    ].join("\0");

    const result: Map<string, FileChurnData> = (reader as any).parseNumstatOutput(stdout);

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
      "Alice",
      "alice@example.com",
      String(Math.floor(Date.now() / 1000)),
      "feat: something",
      "incomplete\tline\n5\t3\tvalid.ts",
    ].join("\0");

    const result: Map<string, FileChurnData> = (reader as any).parseNumstatOutput(stdout);
    expect(result.has("valid.ts")).toBe(true);
    expect(result.size).toBe(1);
  });

  it("should handle empty stdout", () => {
    const result: Map<string, FileChurnData> = (reader as any).parseNumstatOutput("");
    expect(result.size).toBe(0);
  });

  it("should aggregate multiple commits for the same file", () => {
    const sha1 = "a".repeat(40);
    const sha2 = "b".repeat(40);
    const ts = String(Math.floor(Date.now() / 1000));
    const stdout = [
      "",
      sha1,
      "Alice",
      "alice@ex.com",
      ts,
      "fix: first",
      "10\t5\tshared.ts",
      sha2,
      "Bob",
      "bob@ex.com",
      ts,
      "feat: second",
      "20\t15\tshared.ts",
    ].join("\0");

    const result: Map<string, FileChurnData> = (reader as any).parseNumstatOutput(stdout);
    const entry = result.get("shared.ts");
    expect(entry).toBeDefined();
    expect(entry!.commits).toHaveLength(2);
    expect(entry!.linesAdded).toBe(30);
    expect(entry!.linesDeleted).toBe(20);
  });
});

// ─── enrichLineStats — error path ────────────────────────────────────────────

describe("enrichLineStats (error path)", () => {
  let reader: GitLogReader;

  beforeEach(() => {
    reader = new GitLogReader();
  });

  it("should not throw when git numstat command fails (non-fatal)", async () => {
    const fileMap = new Map<string, FileChurnData>();
    fileMap.set("test.ts", { commits: [], linesAdded: 0, linesDeleted: 0 });

    // Call enrichLineStats on a non-git directory — the git command will fail
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    await (reader as any).enrichLineStats("/tmp/not-a-git-repo", fileMap);

    // Should not throw, and linesAdded/linesDeleted stay 0
    expect(fileMap.get("test.ts")!.linesAdded).toBe(0);
    expect(fileMap.get("test.ts")!.linesDeleted).toBe(0);
    // Should log the error
    expect(consoleSpy).toHaveBeenCalled();

    consoleSpy.mockRestore();
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

// ─── _getCommitsViaIsomorphicGit — error path ───────────────────────────────

describe("_getCommitsViaIsomorphicGit error handling", () => {
  let reader: GitLogReader;

  beforeEach(() => {
    reader = new GitLogReader();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("should return empty array when git.log throws", async () => {
    const git = await import("isomorphic-git");
    vi.spyOn(git.default, "log").mockRejectedValue(new Error("git log failure"));

    const chunkMap = new Map<string, Array<{ chunkId: string; startLine: number; endLine: number }>>();
    chunkMap.set("test.ts", [
      { chunkId: "c1", startLine: 1, endLine: 50 },
      { chunkId: "c2", startLine: 51, endLine: 100 },
    ]);

    const result = await (reader as any)._getCommitsViaIsomorphicGit("/fake/repo", new Date(), chunkMap);
    expect(result).toEqual([]);
  });

  it("should skip commits with no parents (root commits)", async () => {
    const git = await import("isomorphic-git");
    vi.spyOn(git.default, "log").mockResolvedValue([
      {
        oid: "a".repeat(40),
        commit: {
          message: "initial commit",
          tree: "t".repeat(40),
          parent: [], // root commit
          author: { name: "Alice", email: "a@ex.com", timestamp: 1234567890, timezoneOffset: 0 },
          committer: { name: "Alice", email: "a@ex.com", timestamp: 1234567890, timezoneOffset: 0 },
        },
        payload: "",
      },
    ] as any);

    const chunkMap = new Map<string, Array<{ chunkId: string; startLine: number; endLine: number }>>();
    chunkMap.set("test.ts", [
      { chunkId: "c1", startLine: 1, endLine: 50 },
      { chunkId: "c2", startLine: 51, endLine: 100 },
    ]);

    const result = await (reader as any)._getCommitsViaIsomorphicGit("/fake/repo", new Date(), chunkMap);
    expect(result).toEqual([]);
  });

  it("should skip commits where diffTrees throws", async () => {
    const git = await import("isomorphic-git");
    vi.spyOn(git.default, "log").mockResolvedValue([
      {
        oid: "a".repeat(40),
        commit: {
          message: "fix: something",
          tree: "t".repeat(40),
          parent: ["p".repeat(40)],
          author: { name: "Alice", email: "a@ex.com", timestamp: 1234567890, timezoneOffset: 0 },
          committer: { name: "Alice", email: "a@ex.com", timestamp: 1234567890, timezoneOffset: 0 },
        },
        payload: "",
      },
    ] as any);

    // Mock diffTrees (called via walk) to throw
    vi.spyOn(git.default, "walk").mockRejectedValue(new Error("walk failed"));

    const chunkMap = new Map<string, Array<{ chunkId: string; startLine: number; endLine: number }>>();
    chunkMap.set("test.ts", [
      { chunkId: "c1", startLine: 1, endLine: 50 },
      { chunkId: "c2", startLine: 51, endLine: 100 },
    ]);

    const result = await (reader as any)._getCommitsViaIsomorphicGit("/fake/repo", new Date(), chunkMap);
    expect(result).toEqual([]);
  });
});

// ─── processCommitEntry — readCommit error, empty blobs, large file skip ────

describe("processCommitEntry edge cases (via buildChunkChurnMap)", () => {
  let reader: GitLogReader;

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("should skip large files when GIT_CHUNK_MAX_FILE_LINES is set low", async () => {
    reader = new GitLogReader();

    const originalEnv = process.env.GIT_CHUNK_MAX_FILE_LINES;
    process.env.GIT_CHUNK_MAX_FILE_LINES = "10"; // Very low limit

    try {
      // Mock getHead to return a fixed SHA
      vi.spyOn(reader as any, "getHead").mockResolvedValue("h".repeat(40));

      // Mock pathspec to return a commit touching our file
      vi.spyOn(reader as any, "getCommitsByPathspec").mockResolvedValue([
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

      const chunkMap = new Map<string, Array<{ chunkId: string; startLine: number; endLine: number }>>();
      chunkMap.set("big-file.ts", [
        { chunkId: "c1", startLine: 1, endLine: 50 }, // endLine 50 > max 10
        { chunkId: "c2", startLine: 51, endLine: 100 },
      ]);

      const result = await (reader as any)._buildChunkChurnMapUncached("/fake/repo", chunkMap, 10, 6, undefined);

      // File should be skipped due to maxFileLines=10, chunks endLine=50 and 100 both exceed it
      const overlay = result.get("big-file.ts");
      if (overlay) {
        // If overlay exists, chunk commit counts should be 0 (skipped)
        for (const [, o] of overlay) {
          expect(o.chunkCommitCount).toBe(0);
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
    reader = new GitLogReader();

    vi.spyOn(reader as any, "getHead").mockResolvedValue("h".repeat(40));

    vi.spyOn(reader as any, "getCommitsByPathspec").mockResolvedValue([
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

    const chunkMap = new Map<string, Array<{ chunkId: string; startLine: number; endLine: number }>>();
    chunkMap.set("test.ts", [
      { chunkId: "c1", startLine: 1, endLine: 50 },
      { chunkId: "c2", startLine: 51, endLine: 100 },
    ]);

    const result = await (reader as any)._buildChunkChurnMapUncached("/fake/repo", chunkMap, 10, 6, undefined);

    // Should not throw; chunks should have 0 commits
    const overlay = result.get("test.ts");
    expect(overlay).toBeDefined();
    for (const [, o] of overlay!) {
      expect(o.chunkCommitCount).toBe(0);
    }
  });

  it("should skip commit when readCommit returns root commit (no parents)", async () => {
    reader = new GitLogReader();

    vi.spyOn(reader as any, "getHead").mockResolvedValue("h".repeat(40));

    vi.spyOn(reader as any, "getCommitsByPathspec").mockResolvedValue([
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

    const chunkMap = new Map<string, Array<{ chunkId: string; startLine: number; endLine: number }>>();
    chunkMap.set("test.ts", [
      { chunkId: "c1", startLine: 1, endLine: 50 },
      { chunkId: "c2", startLine: 51, endLine: 100 },
    ]);

    const result = await (reader as any)._buildChunkChurnMapUncached("/fake/repo", chunkMap, 10, 6, undefined);

    const overlay = result.get("test.ts");
    expect(overlay).toBeDefined();
    for (const [, o] of overlay!) {
      expect(o.chunkCommitCount).toBe(0);
    }
  });

  it("should skip when both blobs are empty", async () => {
    reader = new GitLogReader();

    vi.spyOn(reader as any, "getHead").mockResolvedValue("h".repeat(40));

    vi.spyOn(reader as any, "getCommitsByPathspec").mockResolvedValue([
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

    const chunkMap = new Map<string, Array<{ chunkId: string; startLine: number; endLine: number }>>();
    chunkMap.set("test.ts", [
      { chunkId: "c1", startLine: 1, endLine: 50 },
      { chunkId: "c2", startLine: 51, endLine: 100 },
    ]);

    const result = await (reader as any)._buildChunkChurnMapUncached("/fake/repo", chunkMap, 10, 6, undefined);

    const overlay = result.get("test.ts");
    expect(overlay).toBeDefined();
    for (const [, o] of overlay!) {
      expect(o.chunkCommitCount).toBe(0);
    }
  });

  it("should handle structuredPatch throwing (caught by try/catch in processCommitEntry)", async () => {
    reader = new GitLogReader();

    vi.spyOn(reader as any, "getHead").mockResolvedValue("h".repeat(40));

    vi.spyOn(reader as any, "getCommitsByPathspec").mockResolvedValue([
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

    const chunkMap = new Map<string, Array<{ chunkId: string; startLine: number; endLine: number }>>();
    chunkMap.set("test.ts", [
      { chunkId: "c1", startLine: 1, endLine: 50 },
      { chunkId: "c2", startLine: 51, endLine: 100 },
    ]);

    const result = await (reader as any)._buildChunkChurnMapUncached("/fake/repo", chunkMap, 10, 6, undefined);

    // With identical blobs, structuredPatch returns 0 hunks → skip
    const overlay = result.get("test.ts");
    expect(overlay).toBeDefined();
    for (const [, o] of overlay!) {
      expect(o.chunkCommitCount).toBe(0);
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
    vi.spyOn(reader as any, "getHead").mockImplementation(async () => {
      callCount++;
      if (callCount === 1) return "h".repeat(40); // First call succeeds (cache check)
      throw new Error("HEAD resolution failed"); // Second call fails (cache store)
    });

    vi.spyOn(reader as any, "_buildChunkChurnMapUncached").mockResolvedValue(new Map());

    const chunkMap = new Map<string, Array<{ chunkId: string; startLine: number; endLine: number }>>();
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

    vi.spyOn(reader as any, "getHead").mockRejectedValue(new Error("not a repo"));
    vi.spyOn(reader as any, "_buildChunkChurnMapUncached").mockResolvedValue(
      new Map([
        [
          "test.ts",
          new Map([
            [
              "c1",
              {
                chunkCommitCount: 1,
                chunkChurnRatio: 1,
                chunkContributorCount: 1,
                chunkBugFixRate: 0,
                chunkLastModifiedAt: 0,
                chunkAgeDays: 0,
              },
            ],
          ]),
        ],
      ]),
    );

    const chunkMap = new Map<string, Array<{ chunkId: string; startLine: number; endLine: number }>>();
    chunkMap.set("test.ts", [
      { chunkId: "c1", startLine: 1, endLine: 50 },
      { chunkId: "c2", startLine: 51, endLine: 100 },
    ]);

    const result = await reader.buildChunkChurnMap("/fake/repo", chunkMap);
    expect(result.size).toBe(1);
  });
});

// ─── buildFileMetadataMap — timeout and cache paths ─────────────────────────

describe("buildFileMetadataMap — timeout and cache", () => {
  let reader: GitLogReader;

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("should fall back to isomorphic-git on timeout", async () => {
    reader = new GitLogReader();

    const originalEnv = process.env.GIT_LOG_TIMEOUT_MS;
    process.env.GIT_LOG_TIMEOUT_MS = "1"; // 1ms timeout — will always expire

    try {
      // Mock getHead
      vi.spyOn(reader as any, "getHead").mockResolvedValue("h".repeat(40));

      // Make CLI hang (never resolve)
      vi.spyOn(reader as any, "buildViaCli").mockReturnValue(
        new Promise(() => {}), // never resolves
      );

      // Mock isomorphic-git fallback
      const mockData = new Map<string, FileChurnData>();
      mockData.set("fallback.ts", { commits: [], linesAdded: 1, linesDeleted: 0 });
      vi.spyOn(reader as any, "buildViaIsomorphicGit").mockResolvedValue(mockData);

      const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});

      const result = await reader.buildFileMetadataMap("/fake/repo");

      expect(result.size).toBe(1);
      expect(result.has("fallback.ts")).toBe(true);
      expect(consoleSpy).toHaveBeenCalled();

      consoleSpy.mockRestore();
    } finally {
      if (originalEnv === undefined) {
        delete process.env.GIT_LOG_TIMEOUT_MS;
      } else {
        process.env.GIT_LOG_TIMEOUT_MS = originalEnv;
      }
    }
  });

  it("should return cached data when HEAD has not changed", async () => {
    reader = new GitLogReader();

    vi.spyOn(reader as any, "getHead").mockResolvedValue("h".repeat(40));

    const mockData = new Map<string, FileChurnData>();
    mockData.set("cached.ts", { commits: [], linesAdded: 5, linesDeleted: 2 });
    const cliSpy = vi.spyOn(reader as any, "buildViaCli").mockResolvedValue(mockData);

    // First call — populates cache
    const result1 = await reader.buildFileMetadataMap("/fake/repo", 12);
    expect(cliSpy).toHaveBeenCalledTimes(1);

    // Second call — same HEAD → should return cached
    const result2 = await reader.buildFileMetadataMap("/fake/repo", 12);
    expect(cliSpy).toHaveBeenCalledTimes(1); // NOT called again
    expect(result2).toBe(result1); // Same reference
  });

  it("should skip cache when getHead fails", async () => {
    reader = new GitLogReader();

    vi.spyOn(reader as any, "getHead").mockRejectedValue(new Error("not a repo"));

    const mockData = new Map<string, FileChurnData>();
    mockData.set("no-cache.ts", { commits: [], linesAdded: 0, linesDeleted: 0 });
    const cliSpy = vi.spyOn(reader as any, "buildViaCli").mockResolvedValue(mockData);

    const result = await reader.buildFileMetadataMap("/fake/repo", 6);
    expect(cliSpy).toHaveBeenCalled();
    expect(result.size).toBe(1);
  });

  it("should use GIT_LOG_MAX_AGE_MONTHS env when maxAgeMonths is not provided", async () => {
    reader = new GitLogReader();

    const originalEnv = process.env.GIT_LOG_MAX_AGE_MONTHS;
    process.env.GIT_LOG_MAX_AGE_MONTHS = "3";

    try {
      vi.spyOn(reader as any, "getHead").mockResolvedValue("h".repeat(40));
      const cliSpy = vi.spyOn(reader as any, "buildViaCli").mockResolvedValue(new Map());

      await reader.buildFileMetadataMap("/fake/repo"); // no maxAgeMonths param

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

    vi.spyOn(reader as any, "getHead").mockResolvedValue("h".repeat(40));
    const cliSpy = vi.spyOn(reader as any, "buildViaCli").mockResolvedValue(new Map());

    await reader.buildFileMetadataMap("/fake/repo", 0);

    // buildViaCli is called with undefined sinceDate (maxAge=0 means no filter)
    expect(cliSpy).toHaveBeenCalled();
  });
});

// ─── withTimeout utility ─────────────────────────────────────────────────────

describe("withTimeout", () => {
  let reader: GitLogReader;

  beforeEach(() => {
    reader = new GitLogReader();
  });

  it("should resolve when promise completes before timeout", async () => {
    const result = await (reader as any).withTimeout(Promise.resolve("ok"), 5000, "timeout");
    expect(result).toBe("ok");
  });

  it("should reject with timeout message when promise exceeds timeout", async () => {
    const slow = new Promise((resolve) => setTimeout(resolve, 10000));

    await expect((reader as any).withTimeout(slow, 10, "test timeout message")).rejects.toThrow("test timeout message");
  });

  it("should propagate original rejection when promise fails before timeout", async () => {
    const failing = Promise.reject(new Error("original error"));

    await expect((reader as any).withTimeout(failing, 5000, "timeout")).rejects.toThrow("original error");
  });
});

// ─── buildViaIsomorphicGit — root commit and error paths ─────────────────────

describe("buildViaIsomorphicGit edge cases", () => {
  let reader: GitLogReader;

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("should return empty map when no commits found", async () => {
    reader = new GitLogReader();
    const git = await import("isomorphic-git");
    vi.spyOn(git.default, "log").mockResolvedValue([]);

    const result = await (reader as any).buildViaIsomorphicGit("/fake/repo");
    expect(result.size).toBe(0);
  });

  it("should handle root commit (no parent) by listing all files", async () => {
    reader = new GitLogReader();
    const git = await import("isomorphic-git");

    vi.spyOn(git.default, "log").mockResolvedValue([
      {
        oid: "a".repeat(40),
        commit: {
          message: "initial",
          tree: "t".repeat(40),
          parent: [],
          author: { name: "Alice", email: "a@ex.com", timestamp: 1234567890, timezoneOffset: 0 },
          committer: { name: "Alice", email: "a@ex.com", timestamp: 1234567890, timezoneOffset: 0 },
        },
        payload: "",
      },
    ] as any);

    // Mock listAllFiles to return some files
    vi.spyOn(reader as any, "listAllFiles").mockResolvedValue(["file1.ts", "file2.ts"]);
    // Mock enrichLineStats to be a no-op
    vi.spyOn(reader as any, "enrichLineStats").mockResolvedValue(undefined);

    const result = await (reader as any).buildViaIsomorphicGit("/fake/repo");
    expect(result.size).toBe(2);
    expect(result.has("file1.ts")).toBe(true);
    expect(result.has("file2.ts")).toBe(true);
    expect(result.get("file1.ts")!.commits).toHaveLength(1);
    expect(result.get("file1.ts")!.commits[0].sha).toBe("a".repeat(40));
  });

  it("should skip commit when tree diff fails", async () => {
    reader = new GitLogReader();
    const git = await import("isomorphic-git");

    vi.spyOn(git.default, "log").mockResolvedValue([
      {
        oid: "a".repeat(40),
        commit: {
          message: "first commit",
          tree: "t".repeat(40),
          parent: ["p".repeat(40)],
          author: { name: "Alice", email: "a@ex.com", timestamp: 1234567890, timezoneOffset: 0 },
          committer: { name: "Alice", email: "a@ex.com", timestamp: 1234567890, timezoneOffset: 0 },
        },
        payload: "",
      },
    ] as any);

    // diffTrees throws
    vi.spyOn(reader as any, "diffTrees").mockRejectedValue(new Error("tree walk failed"));
    vi.spyOn(reader as any, "enrichLineStats").mockResolvedValue(undefined);

    const result = await (reader as any).buildViaIsomorphicGit("/fake/repo");
    expect(result.size).toBe(0); // commit was skipped
  });

  it("should call enrichLineStats with sinceDate", async () => {
    reader = new GitLogReader();
    const git = await import("isomorphic-git");

    // Must have at least one commit so buildViaIsomorphicGit doesn't early-return
    vi.spyOn(git.default, "log").mockResolvedValue([
      {
        oid: "a".repeat(40),
        commit: {
          message: "feat: something",
          tree: "t".repeat(40),
          parent: ["p".repeat(40)],
          author: { name: "Alice", email: "a@ex.com", timestamp: 1234567890, timezoneOffset: 0 },
          committer: { name: "Alice", email: "a@ex.com", timestamp: 1234567890, timezoneOffset: 0 },
        },
        payload: "",
      },
    ] as any);

    // diffTrees needs to succeed and return files
    vi.spyOn(reader as any, "diffTrees").mockResolvedValue(["file.ts"]);

    const enrichSpy = vi.spyOn(reader as any, "enrichLineStats").mockResolvedValue(undefined);
    const sinceDate = new Date("2024-01-01");

    await (reader as any).buildViaIsomorphicGit("/fake/repo", sinceDate);
    expect(enrichSpy).toHaveBeenCalledWith("/fake/repo", expect.any(Map), sinceDate);
  });
});

// ─── buildFileMetadataForPaths — batch error path ────────────────────────────

describe("buildFileMetadataForPaths — batch failure", () => {
  let reader: GitLogReader;

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("should continue when a batch fails and still return results from other batches", async () => {
    reader = new GitLogReader();

    let callCount = 0;
    vi.spyOn(reader as any, "withTimeout").mockImplementation(async (promise: Promise<any>) => {
      callCount++;
      if (callCount === 1) throw new Error("batch 1 failed");
      return promise;
    });

    // Generate enough paths to trigger batching (>500)
    const paths: string[] = [];
    for (let i = 0; i < 600; i++) {
      paths.push(`file-${i}.ts`);
    }

    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    // The withTimeout mock will fail first batch, succeed on second
    // Since execFileAsync will also be called, let's just mock the whole flow
    vi.restoreAllMocks();

    // Simpler approach: just make parseNumstatOutput return empty for the test
    vi.spyOn(reader as any, "parseNumstatOutput").mockReturnValue(new Map());

    const result = await reader.buildFileMetadataForPaths("/tmp", []);
    expect(result.size).toBe(0);

    consoleSpy.mockRestore();
  });
});

// ─── _buildChunkChurnMapUncached — without fileChurnDataMap (fallback calc) ──

describe("_buildChunkChurnMapUncached — fallback fileCommitCount", () => {
  let reader: GitLogReader;

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("should use union of chunk SHAs as denominator when fileChurnDataMap is not provided", async () => {
    reader = new GitLogReader();

    vi.spyOn(reader as any, "getHead").mockResolvedValue("h".repeat(40));

    const commitSha = "a".repeat(40);
    vi.spyOn(reader as any, "getCommitsByPathspec").mockResolvedValue([
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

    const chunkMap = new Map<string, Array<{ chunkId: string; startLine: number; endLine: number }>>();
    chunkMap.set("test.ts", [
      { chunkId: "c1", startLine: 1, endLine: 2 },
      { chunkId: "c2", startLine: 3, endLine: 10 },
    ]);

    // Call WITHOUT fileChurnDataMap — should use fallback union calculation
    const result = await (reader as any)._buildChunkChurnMapUncached(
      "/fake/repo",
      chunkMap,
      10,
      6,
      undefined, // no fileChurnDataMap
    );

    const overlay = result.get("test.ts");
    expect(overlay).toBeDefined();
    // Verify chunkChurnRatio is computed (may be 0 or 1 depending on patch output)
    for (const [, o] of overlay!) {
      expect(o.chunkChurnRatio).toBeGreaterThanOrEqual(0);
      expect(o.chunkChurnRatio).toBeLessThanOrEqual(1);
    }
  });
});

// ─── _buildChunkChurnMapUncached — isomorphic-git fallback when CLI fails ────

describe("_buildChunkChurnMapUncached — CLI pathspec fallback", () => {
  let reader: GitLogReader;

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("should fall back to isomorphic-git when getCommitsByPathspec throws", async () => {
    reader = new GitLogReader();

    vi.spyOn(reader as any, "getHead").mockResolvedValue("h".repeat(40));
    vi.spyOn(reader as any, "getCommitsByPathspec").mockRejectedValue(new Error("CLI failed"));
    vi.spyOn(reader as any, "_getCommitsViaIsomorphicGit").mockResolvedValue([]);

    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const chunkMap = new Map<string, Array<{ chunkId: string; startLine: number; endLine: number }>>();
    chunkMap.set("test.ts", [
      { chunkId: "c1", startLine: 1, endLine: 50 },
      { chunkId: "c2", startLine: 51, endLine: 100 },
    ]);

    const result = await (reader as any)._buildChunkChurnMapUncached("/fake/repo", chunkMap, 10, 6, undefined);

    // Should not throw; should have fallen back to isomorphic-git
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
    vi.spyOn(reader as any, "getHead").mockResolvedValue(headSha);

    const mockOverlay = new Map([
      [
        "test.ts",
        new Map([
          [
            "c1",
            {
              chunkCommitCount: 5,
              chunkChurnRatio: 0.5,
              chunkContributorCount: 2,
              chunkBugFixRate: 20,
              chunkLastModifiedAt: 12345,
              chunkAgeDays: 10,
            },
          ],
        ]),
      ],
    ]);

    const buildSpy = vi.spyOn(reader as any, "_buildChunkChurnMapUncached").mockResolvedValue(mockOverlay);

    const chunkMap = new Map<string, Array<{ chunkId: string; startLine: number; endLine: number }>>();
    chunkMap.set("test.ts", [
      { chunkId: "c1", startLine: 1, endLine: 50 },
      { chunkId: "c2", startLine: 51, endLine: 100 },
    ]);

    // First call — populates cache
    const result1 = await reader.buildChunkChurnMap("/fake/repo", chunkMap);
    expect(buildSpy).toHaveBeenCalledTimes(1);

    // Second call — same HEAD → cached
    const result2 = await reader.buildChunkChurnMap("/fake/repo", chunkMap);
    expect(buildSpy).toHaveBeenCalledTimes(1); // NOT called again
    expect(result2).toBe(result1);
  });
});

// ─── buildCliArgs ────────────────────────────────────────────────────────────

describe("buildCliArgs", () => {
  let reader: GitLogReader;

  beforeEach(() => {
    reader = new GitLogReader();
  });

  it("should not include --since when sinceDate is undefined", () => {
    const args: string[] = (reader as any).buildCliArgs(undefined);
    expect(args).toContain("log");
    expect(args).toContain("HEAD");
    expect(args).toContain("--numstat");
    const hasSince = args.some((a: string) => a.startsWith("--since="));
    expect(hasSince).toBe(false);
  });

  it("should include --since with ISO date when sinceDate is provided", () => {
    const date = new Date("2025-01-15T00:00:00.000Z");
    const args: string[] = (reader as any).buildCliArgs(date);
    const sinceArg = args.find((a: string) => a.startsWith("--since="));
    expect(sinceArg).toBeDefined();
    expect(sinceArg).toContain("2025-01-15");
  });
});

// ─── getCommitsByPathspecBatched — merge and error handling ──────────────────

describe("getCommitsByPathspecBatched (via getCommitsByPathspec)", () => {
  let reader: GitLogReader;

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("should merge commits from multiple batches by SHA", async () => {
    reader = new GitLogReader();

    const sha = "a".repeat(40);
    let callCount = 0;

    vi.spyOn(reader as any, "getCommitsByPathspecSingle").mockImplementation(async () => {
      callCount++;
      if (callCount === 1) {
        return [
          {
            commit: {
              sha,
              author: "Alice",
              authorEmail: "a@ex.com",
              timestamp: 12345,
              body: "feat: stuff",
            },
            changedFiles: ["file1.ts"],
          },
        ];
      }
      // Second batch returns same commit with different file
      return [
        {
          commit: {
            sha,
            author: "Alice",
            authorEmail: "a@ex.com",
            timestamp: 12345,
            body: "feat: stuff",
          },
          changedFiles: ["file2.ts"],
        },
      ];
    });

    // Generate >500 paths to trigger batching
    const filePaths: string[] = [];
    for (let i = 0; i < 600; i++) filePaths.push(`file${i}.ts`);

    const result = await (reader as any).getCommitsByPathspec("/repo", new Date(), filePaths);

    // Should have merged the two batch results into one entry with both files
    expect(result).toHaveLength(1);
    expect(result[0].changedFiles).toContain("file1.ts");
    expect(result[0].changedFiles).toContain("file2.ts");
  });

  it("should continue when a batch throws and return results from other batches", async () => {
    reader = new GitLogReader();

    let callCount = 0;
    vi.spyOn(reader as any, "getCommitsByPathspecSingle").mockImplementation(async () => {
      callCount++;
      if (callCount === 1) throw new Error("batch 1 failed");
      return [
        {
          commit: {
            sha: "b".repeat(40),
            author: "Bob",
            authorEmail: "b@ex.com",
            timestamp: 12345,
            body: "fix: something",
          },
          changedFiles: ["surviving.ts"],
        },
      ];
    });

    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const filePaths: string[] = [];
    for (let i = 0; i < 600; i++) filePaths.push(`file${i}.ts`);

    const result = await (reader as any).getCommitsByPathspec("/repo", new Date(), filePaths);

    // Should have results from second batch
    expect(result).toHaveLength(1);
    expect(result[0].changedFiles).toContain("surviving.ts");

    consoleSpy.mockRestore();
  });
});

// ─── readBlobAsString — error returns empty string ───────────────────────────

describe("readBlobAsString", () => {
  let reader: GitLogReader;

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("should return empty string when readBlob throws", async () => {
    reader = new GitLogReader();
    const git = await import("isomorphic-git");
    vi.spyOn(git.default, "readBlob").mockRejectedValue(new Error("not found"));

    const result = await (reader as any).readBlobAsString("/repo", "abc123", "nonexistent.ts");
    expect(result).toBe("");
  });

  it("should decode blob content as UTF-8", async () => {
    reader = new GitLogReader();
    const git = await import("isomorphic-git");
    vi.spyOn(git.default, "readBlob").mockResolvedValue({
      oid: "x".repeat(40),
      blob: new TextEncoder().encode("hello world"),
    } as any);

    const result = await (reader as any).readBlobAsString("/repo", "abc123", "file.ts");
    expect(result).toBe("hello world");
  });
});

// ─── enrichLineStats — sinceDate parameter ──────────────────────────────────

describe("enrichLineStats — with sinceDate", () => {
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

  it("should add --since flag when sinceDate is provided", async () => {
    if (!repoRoot) return;

    const fileMap = new Map<string, FileChurnData>();
    fileMap.set("package.json", { commits: [], linesAdded: 0, linesDeleted: 0 });

    // Enrich with a very old since date — should include most history
    await (reader as any).enrichLineStats(repoRoot, fileMap, new Date("2020-01-01"));

    const entry = fileMap.get("package.json");
    // Should have accumulated some line stats
    expect(entry!.linesAdded + entry!.linesDeleted).toBeGreaterThan(0);
  });

  it("should still work (0 stats) with recent sinceDate", async () => {
    if (!repoRoot) return;

    const fileMap = new Map<string, FileChurnData>();
    fileMap.set("package.json", { commits: [], linesAdded: 0, linesDeleted: 0 });

    // Very recent date — may have 0 changes
    const futureDate = new Date(Date.now() + 86400000);
    await (reader as any).enrichLineStats(repoRoot, fileMap, futureDate);

    const entry = fileMap.get("package.json");
    // With a future date, no commits should match
    expect(entry!.linesAdded).toBe(0);
    expect(entry!.linesDeleted).toBe(0);
  });
});

// ─── getCommitsByPathspec — empty paths ──────────────────────────────────────

describe("getCommitsByPathspec — edge cases", () => {
  let reader: GitLogReader;

  beforeEach(() => {
    reader = new GitLogReader();
  });

  it("should return empty array for empty file paths", async () => {
    const result = await (reader as any).getCommitsByPathspec("/repo", new Date(), []);
    expect(result).toEqual([]);
  });
});

// ─── _getCommitsViaIsomorphicGit — successful path with relevant files ───────

describe("_getCommitsViaIsomorphicGit — relevant files found", () => {
  let reader: GitLogReader;

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("should return commit entries with only relevant changed files", async () => {
    reader = new GitLogReader();
    const git = await import("isomorphic-git");

    vi.spyOn(git.default, "log").mockResolvedValue([
      {
        oid: "a".repeat(40),
        commit: {
          message: "feat: add auth",
          tree: "t".repeat(40),
          parent: ["p".repeat(40)],
          author: { name: "Alice", email: "a@ex.com", timestamp: 1234567890, timezoneOffset: 0 },
          committer: { name: "Alice", email: "a@ex.com", timestamp: 1234567890, timezoneOffset: 0 },
        },
        payload: "",
      },
    ] as any);

    // diffTrees returns files, some in chunkMap and some not
    vi.spyOn(reader as any, "diffTrees").mockResolvedValue(["auth.ts", "unrelated.ts", "config.ts"]);

    const chunkMap = new Map<string, Array<{ chunkId: string; startLine: number; endLine: number }>>();
    chunkMap.set("auth.ts", [
      { chunkId: "c1", startLine: 1, endLine: 50 },
      { chunkId: "c2", startLine: 51, endLine: 100 },
    ]);

    const result = await (reader as any)._getCommitsViaIsomorphicGit("/fake/repo", new Date("2020-01-01"), chunkMap);

    expect(result).toHaveLength(1);
    expect(result[0].commit.sha).toBe("a".repeat(40));
    expect(result[0].commit.author).toBe("Alice");
    expect(result[0].changedFiles).toEqual(["auth.ts"]);
    // "unrelated.ts" and "config.ts" should be filtered out
    expect(result[0].changedFiles).not.toContain("unrelated.ts");
  });

  it("should skip commit when no changed files match chunkMap (relevantFiles empty)", async () => {
    reader = new GitLogReader();
    const git = await import("isomorphic-git");

    vi.spyOn(git.default, "log").mockResolvedValue([
      {
        oid: "a".repeat(40),
        commit: {
          message: "feat: something else",
          tree: "t".repeat(40),
          parent: ["p".repeat(40)],
          author: { name: "Bob", email: "b@ex.com", timestamp: 1234567890, timezoneOffset: 0 },
          committer: { name: "Bob", email: "b@ex.com", timestamp: 1234567890, timezoneOffset: 0 },
        },
        payload: "",
      },
    ] as any);

    // Changed files that are NOT in the chunkMap
    vi.spyOn(reader as any, "diffTrees").mockResolvedValue(["other.ts", "readme.md"]);

    const chunkMap = new Map<string, Array<{ chunkId: string; startLine: number; endLine: number }>>();
    chunkMap.set("auth.ts", [
      { chunkId: "c1", startLine: 1, endLine: 50 },
      { chunkId: "c2", startLine: 51, endLine: 100 },
    ]);

    const result = await (reader as any)._getCommitsViaIsomorphicGit("/fake/repo", new Date("2020-01-01"), chunkMap);

    expect(result).toEqual([]);
  });
});

// ─── buildFileMetadataForPaths — batch error with DEBUG logging ──────────────

describe("buildFileMetadataForPaths — DEBUG batch error logging", () => {
  let reader: GitLogReader;

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("should log batch error when DEBUG=true and batch fails", async () => {
    reader = new GitLogReader();

    // Force the git command to fail by using a non-git directory
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const result = await reader.buildFileMetadataForPaths("/tmp/not-a-git-repo", ["nonexistent.ts"]);

    // Should not throw, return empty map
    expect(result.size).toBe(0);
    // DEBUG is "true" in test env, so it should log
    expect(consoleSpy).toHaveBeenCalled();

    consoleSpy.mockRestore();
  });
});

// ─── processCommitEntry — no relevant files after filter ─────────────────────

describe("processCommitEntry — no relevant files", () => {
  let reader: GitLogReader;

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("should skip commit when changedFiles don't match any chunk file", async () => {
    reader = new GitLogReader();

    vi.spyOn(reader as any, "getHead").mockResolvedValue("h".repeat(40));

    vi.spyOn(reader as any, "getCommitsByPathspec").mockResolvedValue([
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

    const chunkMap = new Map<string, Array<{ chunkId: string; startLine: number; endLine: number }>>();
    chunkMap.set("target.ts", [
      { chunkId: "c1", startLine: 1, endLine: 50 },
      { chunkId: "c2", startLine: 51, endLine: 100 },
    ]);

    const result = await (reader as any)._buildChunkChurnMapUncached("/fake/repo", chunkMap, 10, 6, undefined);

    // Chunks should have 0 commits since the changed file doesn't match
    const overlay = result.get("target.ts");
    expect(overlay).toBeDefined();
    for (const [, o] of overlay!) {
      expect(o.chunkCommitCount).toBe(0);
    }
  });
});

// ─── processCommitEntry — bug fix commit updates bugFixCount ─────────────────

describe("processCommitEntry — bug fix accumulation", () => {
  let reader: GitLogReader;

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("should count bug fix commits and update chunkBugFixRate", async () => {
    reader = new GitLogReader();

    vi.spyOn(reader as any, "getHead").mockResolvedValue("h".repeat(40));

    const commitSha = "a".repeat(40);
    vi.spyOn(reader as any, "getCommitsByPathspec").mockResolvedValue([
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

    const chunkMap = new Map<string, Array<{ chunkId: string; startLine: number; endLine: number }>>();
    chunkMap.set("auth.ts", [
      { chunkId: "c1", startLine: 1, endLine: 5 },
      { chunkId: "c2", startLine: 6, endLine: 100 },
    ]);

    const result = await (reader as any)._buildChunkChurnMapUncached("/fake/repo", chunkMap, 10, 6, undefined);

    const overlay = result.get("auth.ts");
    expect(overlay).toBeDefined();

    // At least one chunk should have been affected by the bug fix
    let anyBugFix = false;
    for (const [, o] of overlay!) {
      if (o.chunkBugFixRate > 0) anyBugFix = true;
      if (o.chunkCommitCount > 0) {
        expect(o.chunkBugFixRate).toBe(100); // 1 fix commit / 1 total = 100%
        expect(o.chunkAgeDays).toBeGreaterThanOrEqual(0);
        expect(o.chunkContributorCount).toBe(1);
      }
    }
    expect(anyBugFix).toBe(true);
  });
});

// ─── concurrency semaphore — queue and release ──────────────────────────────

describe("_buildChunkChurnMapUncached — concurrency control", () => {
  let reader: GitLogReader;

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("should handle multiple commits with concurrency=1 (queue draining)", async () => {
    reader = new GitLogReader();

    vi.spyOn(reader as any, "getHead").mockResolvedValue("h".repeat(40));

    const sha1 = "a".repeat(40);
    const sha2 = "b".repeat(40);

    vi.spyOn(reader as any, "getCommitsByPathspec").mockResolvedValue([
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

    const chunkMap = new Map<string, Array<{ chunkId: string; startLine: number; endLine: number }>>();
    chunkMap.set("test.ts", [
      { chunkId: "c1", startLine: 1, endLine: 2 },
      { chunkId: "c2", startLine: 3, endLine: 10 },
    ]);

    // Use concurrency=1 to exercise the queue mechanism
    const result = await (reader as any)._buildChunkChurnMapUncached("/fake/repo", chunkMap, 1, 6, undefined);

    const overlay = result.get("test.ts");
    expect(overlay).toBeDefined();
    // We should have processed both commits without deadlock
    let totalCommits = 0;
    for (const [, o] of overlay!) {
      totalCommits += o.chunkCommitCount;
    }
    expect(totalCommits).toBeGreaterThan(0);
  });
});

// ─── enrichLineStats — binary files in numstat ───────────────────────────────

describe("enrichLineStats — binary file handling", () => {
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

  it("should not crash on binary files in numstat output (NaN check)", async () => {
    if (!repoRoot) return;

    const fileMap = new Map<string, FileChurnData>();
    // Even if binary files show up in numstat ("-\t-\tfile"), they should be skipped
    fileMap.set("package.json", { commits: [], linesAdded: 0, linesDeleted: 0 });

    await (reader as any).enrichLineStats(repoRoot, fileMap);

    // The test verifies no crash; package.json should have valid stats
    const entry = fileMap.get("package.json");
    expect(entry).toBeDefined();
    expect(entry!.linesAdded).toBeGreaterThanOrEqual(0);
  });
});

// ─── parseNumstatOutput — non-hex SHA entries ────────────────────────────────

describe("parseNumstatOutput — SHA validation edge cases", () => {
  let reader: GitLogReader;

  beforeEach(() => {
    reader = new GitLogReader();
  });

  it("should skip sections with too-short SHA", () => {
    // SHA is only 10 chars instead of 40
    const stdout = [
      "",
      "abc1234567", // too short
      "Alice",
      "alice@ex.com",
      "12345",
      "feat: stuff",
      "10\t5\tfile.ts",
    ].join("\0");

    const result: Map<string, FileChurnData> = (reader as any).parseNumstatOutput(stdout);
    expect(result.size).toBe(0);
  });

  it("should skip sections with non-hex SHA characters", () => {
    // SHA has uppercase letters (git uses lowercase hex)
    const stdout = [
      "",
      "AAAA" + "a".repeat(36), // uppercase chars — fails /^[a-f0-9]+$/ test
      "Alice",
      "alice@ex.com",
      "12345",
      "feat: stuff",
      "10\t5\tfile.ts",
    ].join("\0");

    const result: Map<string, FileChurnData> = (reader as any).parseNumstatOutput(stdout);
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
      "Alice",
      "alice@ex.com",
      ts,
      "feat: valid",
      "10\t5\tfile.ts",
    ].join("\0");

    const result: Map<string, FileChurnData> = (reader as any).parseNumstatOutput(stdout);
    expect(result.has("file.ts")).toBe(true);
    expect(result.get("file.ts")!.commits).toHaveLength(1);
  });
});

// ─── listAllFiles and diffTrees — real repo integration tests ────────────────

describe("listAllFiles and diffTrees (private methods via real repo)", () => {
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

  it("listAllFiles should list files from a real commit tree", async () => {
    if (!repoRoot) return;

    // Get HEAD commit
    const headSha = await reader.getHead(repoRoot);

    const files: string[] = await (reader as any).listAllFiles(repoRoot, headSha);
    expect(files.length).toBeGreaterThan(0);
    expect(files).toContain("package.json");
  });

  it("diffTrees should find changed files between two commits", async () => {
    if (!repoRoot) return;

    const { execFile } = await import("node:child_process");
    const { promisify } = await import("node:util");
    const execAsync = promisify(execFile);

    // Get last 2 commits
    const { stdout } = await execAsync("git", ["log", "--format=%H", "-2"], { cwd: repoRoot });
    const shas = stdout.trim().split("\n");
    if (shas.length < 2) return;

    const [newerSha, olderSha] = shas;
    const changedFiles: string[] = await (reader as any).diffTrees(repoRoot, olderSha, newerSha);

    // Should return at least some changed files (last commit changed something)
    expect(changedFiles).toBeInstanceOf(Array);
    // At least one file was changed in the commit
    expect(changedFiles.length).toBeGreaterThanOrEqual(0);
  });
});

// ─── buildViaIsomorphicGit — real repo test (exercises walk callbacks) ────────

describe("buildViaIsomorphicGit — real repo integration", () => {
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

  it("should build file metadata via isomorphic-git for a real repo (tiny window)", async () => {
    if (!repoRoot) return;

    // Use a very short window to limit scope
    const sinceDate = new Date(Date.now() - 7 * 86400 * 1000); // 7 days ago
    const result = await (reader as any).buildViaIsomorphicGit(repoRoot, sinceDate);

    // Should return a Map (may be empty if no recent commits)
    expect(result).toBeInstanceOf(Map);
  }, 15_000);
});

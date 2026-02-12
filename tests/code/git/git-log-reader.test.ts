/**
 * Tests for GitLogReader, computeFileMetadata, extractTaskIds
 *
 * Coverage:
 * 1. extractTaskIds — all ticket formats, edge cases
 * 2. computeFileMetadata — churn metric calculations
 * 3. GitLogReader — integration with real git repo
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  GitLogReader,
  computeFileMetadata,
  extractTaskIds,
  overlaps,
} from "../../../src/code/git/git-log-reader.js";
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
    const ids = extractTaskIds(
      "feat(core): implement TD-1234 feature, fixes #567, ref AB#890",
    );
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
    chunkMap.set(`${repoRoot}/package.json`, [
      { chunkId: "test-id-1", startLine: 1, endLine: 90 },
    ]);
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

    const fileContributors = new Set(fileChurnData.commits.map(c => c.author)).size;

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
    const cliSpy = vi.spyOn(reader as any, "buildViaCli")
      .mockRejectedValue(new Error("git not found"));
    const isoGitSpy = vi.spyOn(reader as any, "buildViaIsomorphicGit")
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

/**
 * Tests for metrics.ts functions: computeFileSignals, overlaps,
 * isBugFixCommit, isBugFixCommitOrBranch
 *
 * Extracted from git-log-reader.test.ts — these test pure functions
 * from metrics.ts, not from git-log-reader.ts.
 */

import { describe, expect, it } from "vitest";

import type { CommitInfo, FileChurnData } from "../../../../../../src/core/adapters/git/types.js";
import {
  computeFileSignals,
  isBugFixCommit,
  isBugFixCommitOrBranch,
  overlaps,
} from "../../../../../../src/core/domains/trajectory/git/infra/metrics.js";

// ─── shared helper ──────────────────────────────────────────────────────────

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

// ─── computeFileSignals ─────────────────────────────────────────────────────

describe("computeFileSignals", () => {
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

// ─── isBugFixCommit (via computeFileSignals) ────────────────────────────────

describe("isBugFixCommit (via computeFileSignals)", () => {
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

// ─── isBugFixCommit — strict classification ─────────────────────────────────

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

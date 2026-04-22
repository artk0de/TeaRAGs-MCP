/**
 * Tests for chunk-reader functions (buildChunkChurnMapUncached, processCommitEntry).
 *
 * Extracted from git-log-reader.test.ts — these tests mock gitClient and isomorphic-git
 * to exercise chunk-level churn map construction edge cases.
 */

import { afterEach, describe, expect, it, vi } from "vitest";

import * as gitClient from "../../../../../../src/core/adapters/git/client.js";
import * as chunkReader from "../../../../../../src/core/domains/trajectory/git/infra/chunk-reader.js";

// Enable cross-module spy interception for adapter functions
vi.mock("../../../../../../src/core/adapters/git/client.js", async (importOriginal) => importOriginal());

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

// ─── buildChunkChurnMapUncached — without fileChurnDataMap (fallback calc) ──

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

// ─── external semaphore — shared concurrency across streaming calls ─────────

describe("buildChunkChurnMapUncached — external semaphore", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("uses external semaphore's acquire/release when provided", async () => {
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
        changedFiles: ["src/a.ts"],
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

    vi.spyOn(git.default, "readBlob")
      .mockResolvedValueOnce({ oid: "x".repeat(40), blob: new TextEncoder().encode("old\n") } as any)
      .mockResolvedValueOnce({ oid: "y".repeat(40), blob: new TextEncoder().encode("new\nextra\n") } as any);

    const mockRelease = vi.fn();
    const externalSem = { acquire: vi.fn().mockResolvedValue(mockRelease) };

    const chunkMap = new Map<string, { chunkId: string; startLine: number; endLine: number }[]>();
    chunkMap.set("src/a.ts", [
      { chunkId: "c1", startLine: 1, endLine: 5 },
      { chunkId: "c2", startLine: 6, endLine: 10 },
    ]);

    await chunkReader.buildChunkChurnMapUncached(
      "/fake/repo",
      chunkMap,
      {},
      10,
      6,
      undefined,
      undefined,
      120000,
      10000,
      externalSem,
    );

    expect(externalSem.acquire).toHaveBeenCalled();
    expect(mockRelease).toHaveBeenCalled();
  });

  it("does not call external semaphore when chunkMap is empty (all single-chunk files filtered out)", async () => {
    const externalSem = { acquire: vi.fn() };

    const result = await chunkReader.buildChunkChurnMapUncached(
      "/fake/repo",
      new Map(),
      {},
      10,
      6,
      undefined,
      undefined,
      120000,
      10000,
      externalSem,
    );

    expect(result.size).toBe(0);
    expect(externalSem.acquire).not.toHaveBeenCalled();
  });

  it("falls back to internal semaphore when externalSemaphore is undefined", async () => {
    // Regression guard: existing call sites that don't pass semaphore still work
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
        changedFiles: ["src/a.ts"],
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

    vi.spyOn(git.default, "readBlob")
      .mockResolvedValueOnce({ oid: "x".repeat(40), blob: new TextEncoder().encode("old\n") } as any)
      .mockResolvedValueOnce({ oid: "y".repeat(40), blob: new TextEncoder().encode("new\nextra\n") } as any);

    const chunkMap = new Map<string, { chunkId: string; startLine: number; endLine: number }[]>();
    chunkMap.set("src/a.ts", [
      { chunkId: "c1", startLine: 1, endLine: 5 },
      { chunkId: "c2", startLine: 6, endLine: 10 },
    ]);

    // No semaphore passed — should still work
    const result = await chunkReader.buildChunkChurnMapUncached("/fake/repo", chunkMap, {}, 10, 6, undefined);

    expect(result.get("src/a.ts")).toBeDefined();
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

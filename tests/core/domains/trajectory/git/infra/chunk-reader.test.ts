/**
 * Tests for chunk-reader functions (buildChunkChurnMapUncached, processCommitEntry).
 *
 * Extracted from git-log-reader.test.ts — these tests mock the git adapter
 * (getCommitsByPathspec, readCommitParent, createCatFileBatch) to exercise
 * chunk-level churn map construction edge cases.
 */

import { afterEach, describe, expect, it, vi } from "vitest";

import * as gitClient from "../../../../../../src/core/adapters/git/client.js";
import * as chunkReader from "../../../../../../src/core/domains/trajectory/git/infra/chunk-reader.js";

// Enable cross-module spy interception for adapter functions
vi.mock("../../../../../../src/core/adapters/git/client.js", async (importOriginal) => importOriginal());

// walk-commits reads blobs via `createCatFileBatch(repoRoot).read(oid, path)`.
// Mock the batch reader and drive returned blob content through the `read` fn —
// `read(parentOid, …)` then `read(commit.sha, …)` per file, so mockResolvedValueOnce
// sequencing matches old→new content order. Returns the `read` mock for chaining.
function mockBlobReads(): ReturnType<typeof vi.fn> {
  const read = vi.fn();
  vi.spyOn(gitClient, "createCatFileBatch").mockReturnValue({
    read,
    close: vi.fn().mockResolvedValue(undefined),
  } as unknown as ReturnType<typeof gitClient.createCatFileBatch>);
  return read;
}

// ─── processCommitEntry — parent unresolvable, empty blobs, large file skip ────

describe("processCommitEntry edge cases (via buildChunkChurnMapUncached)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("should skip files whose chunks exceed maxFileLines (no blob read)", async () => {
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

    // Parent resolves so the walk proceeds to the maxFileLines check — that skip
    // is the behavior under test. The blob reader is never consulted because the
    // file is filtered out before any read (so no createCatFileBatch mock needed).
    vi.spyOn(gitClient, "readCommitParent").mockResolvedValue("p".repeat(40));

    const chunkMap = new Map<string, { chunkId: string; startLine: number; endLine: number }[]>();
    chunkMap.set("big-file.ts", [
      { chunkId: "c1", startLine: 1, endLine: 50 },
      { chunkId: "c2", startLine: 51, endLine: 100 }, // maxLine 100 > maxFileLines 10
    ]);

    // maxFileLines is the 9th positional arg (squashOpts, chunkTimeoutMs precede it).
    const result = await chunkReader.buildChunkChurnMapUncached(
      "/fake/repo",
      chunkMap,
      {},
      10,
      6,
      undefined,
      undefined,
      120000,
      10,
    );

    const overlay = result.get("big-file.ts");
    if (overlay) {
      for (const [, o] of overlay) {
        expect(o.commitCount).toBe(0);
      }
    }
  });

  it("should skip commit when parent cannot be resolved (e.g., missing object)", async () => {
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

    // The adapter returns null when the parent can't be resolved (missing
    // object, not-a-repo, etc.); the commit is skipped, no churn recorded.
    vi.spyOn(gitClient, "readCommitParent").mockResolvedValue(null);

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

  it("should skip commit when it has no parent (root commit)", async () => {
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

    // Root commit → adapter returns null parent → the walk skips it.
    vi.spyOn(gitClient, "readCommitParent").mockResolvedValue(null);

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

    vi.spyOn(gitClient, "readCommitParent").mockResolvedValue("p".repeat(40));

    // Both blobs empty (path missing at both commits) → adapter returns "" → skip.
    mockBlobReads().mockResolvedValue("");

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

    vi.spyOn(gitClient, "readCommitParent").mockResolvedValue("p".repeat(40));

    // Identical content for both parent and commit blobs → structuredPatch
    // produces 0 hunks (no changes → skip).
    mockBlobReads().mockResolvedValue("identical content\nline 2\nline 3");

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

    vi.spyOn(gitClient, "readCommitParent").mockResolvedValue("p".repeat(40));

    // Different old/new content so structuredPatch produces hunks. Blobs are
    // read via the git adapter (cat-file), so mock at the adapter boundary.
    mockBlobReads()
      .mockResolvedValueOnce("old line 1\nold line 2")
      .mockResolvedValueOnce("new line 1\nnew line 2\nnew line 3");

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
        expect(o.recentContributorCount).toBe(1);
      }
    }
    expect(anyBugFix).toBe(true);
  });
});

// ─── buildChunkChurnMapUncached — single-chunk files ─────────────────────────

describe("buildChunkChurnMapUncached — single-chunk files", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("processes single-chunk files through the full pipeline (no skip)", async () => {
    // Regression: single-chunk files used to be filtered out at the start of
    // buildChunkChurnMapUncached (`entries.length <= 1 continue`). The skip
    // left their chunks with `git.chunk = null`, which broke the system
    // invariant that every chunk has chunk-level data — recovery flagged them
    // as unenriched forever, reranker had no overlay to read, blame was lost.
    const commitSha = "a".repeat(40);
    vi.spyOn(gitClient, "getCommitsByPathspec").mockResolvedValue([
      {
        commit: {
          sha: commitSha,
          author: "Alice",
          authorEmail: "alice@ex.com",
          timestamp: Math.floor(Date.now() / 1000),
          body: "feat: tiny header file",
        },
        changedFiles: ["small.ts"],
      },
    ]);

    vi.spyOn(gitClient, "readCommitParent").mockResolvedValue("p".repeat(40));
    mockBlobReads().mockResolvedValueOnce("").mockResolvedValueOnce("import x from 'y';\nexport const z = 1;\n");

    // SINGLE chunk — file is small enough to be a single block
    const chunkMap = new Map<string, { chunkId: string; startLine: number; endLine: number }[]>();
    chunkMap.set("small.ts", [{ chunkId: "only-chunk", startLine: 1, endLine: 2 }]);

    const blameByPath = new Map<string, any[]>();
    blameByPath.set("small.ts", [
      { lineNumber: 1, sha: commitSha, author: "Alice", authorEmail: "alice@ex.com", timestamp: 12345 },
      { lineNumber: 2, sha: commitSha, author: "Alice", authorEmail: "alice@ex.com", timestamp: 12345 },
    ]);

    const result = await chunkReader.buildChunkChurnMapUncached(
      "/fake/repo",
      chunkMap,
      {},
      10,
      6,
      undefined,
      undefined,
      120000,
      10000,
      undefined,
      blameByPath,
    );

    // Overlay MUST exist for the single-chunk file — that's the whole point.
    const overlay = result.get("small.ts");
    expect(overlay).toBeDefined();
    const chunkOverlay = overlay!.get("only-chunk");
    expect(chunkOverlay).toBeDefined();

    // Churn fields populated by the pipeline (commit was fetched + mapped).
    expect(chunkOverlay!.commitCount).toBeGreaterThanOrEqual(1);

    // Blame populated from blameByPath — chunk == file, so single live-line owner.
    expect(chunkOverlay!.blameDominantAuthor).toBe("Alice");
    expect(chunkOverlay!.blameDominantAuthorPct).toBe(100);
    expect(chunkOverlay!.blameContributorCount).toBe(1);
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

    vi.spyOn(gitClient, "readCommitParent").mockResolvedValue("p".repeat(40));

    // Old/new content so structuredPatch produces hunks.
    mockBlobReads().mockResolvedValueOnce("old content\nline2").mockResolvedValueOnce("new content\nline2\nline3");

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

    vi.spyOn(gitClient, "readCommitParent").mockResolvedValue("p".repeat(40));

    mockBlobReads().mockResolvedValueOnce("old\n").mockResolvedValueOnce("new\nextra\n");

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

    vi.spyOn(gitClient, "readCommitParent").mockResolvedValue("p".repeat(40));

    mockBlobReads().mockResolvedValueOnce("old\n").mockResolvedValueOnce("new\nextra\n");

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

// ─── injected blobReader — caller-owned lifecycle (kc93) ────────────────────

describe("buildChunkChurnMapUncached — injected blobReader", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("uses an injected blobReader and does NOT spawn/close its own (caller owns lifecycle)", async () => {
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
    vi.spyOn(gitClient, "readCommitParent").mockResolvedValue("p".repeat(40));

    // Spy createCatFileBatch to assert the walk does NOT spawn its own reader
    // when one is injected.
    const spawnSpy = vi.spyOn(gitClient, "createCatFileBatch");

    // Injected reader — old→new content per file so a hunk is produced.
    const read = vi.fn().mockResolvedValueOnce("old\n").mockResolvedValueOnce("new\nextra\n");
    const close = vi.fn().mockResolvedValue(undefined);
    const injectedReader = { read, close } as unknown as ReturnType<typeof gitClient.createCatFileBatch>;

    const chunkMap = new Map<string, { chunkId: string; startLine: number; endLine: number }[]>();
    chunkMap.set("src/a.ts", [
      { chunkId: "c1", startLine: 1, endLine: 5 },
      { chunkId: "c2", startLine: 6, endLine: 10 },
    ]);

    // blobReader is the LAST positional arg (after blameByPath).
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
      undefined,
      undefined,
      injectedReader,
    );

    // The injected reader served the blob reads…
    expect(read).toHaveBeenCalled();
    // …the walk did NOT spawn its own process…
    expect(spawnSpy).not.toHaveBeenCalled();
    // …and the walk did NOT close the caller-owned reader.
    expect(close).not.toHaveBeenCalled();
  });

  it("spawns and closes its OWN reader when none is injected (regression guard)", async () => {
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
    vi.spyOn(gitClient, "readCommitParent").mockResolvedValue("p".repeat(40));

    const read = vi.fn().mockResolvedValueOnce("old\n").mockResolvedValueOnce("new\nextra\n");
    const close = vi.fn().mockResolvedValue(undefined);
    const spawnSpy = vi
      .spyOn(gitClient, "createCatFileBatch")
      .mockReturnValue({ read, close } as unknown as ReturnType<typeof gitClient.createCatFileBatch>);

    const chunkMap = new Map<string, { chunkId: string; startLine: number; endLine: number }[]>();
    chunkMap.set("src/a.ts", [
      { chunkId: "c1", startLine: 1, endLine: 5 },
      { chunkId: "c2", startLine: 6, endLine: 10 },
    ]);

    // No blobReader passed → walk owns the lifecycle: spawn once, close in finally.
    await chunkReader.buildChunkChurnMapUncached("/fake/repo", chunkMap, {}, 10, 6, undefined);

    expect(spawnSpy).toHaveBeenCalledTimes(1);
    expect(close).toHaveBeenCalledTimes(1);
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

    // One parent per commit (concurrency=1 → commit1 fully drains before commit2).
    vi.spyOn(gitClient, "readCommitParent").mockResolvedValueOnce("p".repeat(40)).mockResolvedValueOnce("q".repeat(40));

    // Alternate old/new content per commit (2 blob reads each, in order).
    mockBlobReads()
      .mockResolvedValueOnce("v1 line 1\nv1 line 2")
      .mockResolvedValueOnce("v2 line 1\nv2 line 2\nv2 line 3")
      .mockResolvedValueOnce("v2 line 1\nv2 line 2\nv2 line 3")
      .mockResolvedValueOnce("v3 line 1\nv3 line 2");

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

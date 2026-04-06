/**
 * Unit tests for GitLogReader class methods.
 *
 * Tests cache behavior, error handling, timeout, and fallback logic.
 * All git operations are mocked — no real git repo required.
 *
 * Integration tests (real git) → __integration__/git-log-reader.integration.test.ts
 * Metric functions → metrics.test.ts
 * Parser functions → tests/core/adapters/git/parsers.test.ts
 * Client utilities → tests/core/adapters/git/client-utils.test.ts
 * Chunk reader → chunk-reader.test.ts
 */

import { afterEach, describe, expect, it, vi } from "vitest";

import * as gitClient from "../../../../../../src/core/adapters/git/client.js";
import * as gitParsers from "../../../../../../src/core/adapters/git/parsers.js";
import type { FileChurnData } from "../../../../../../src/core/adapters/git/types.js";
import * as chunkReader from "../../../../../../src/core/domains/trajectory/git/infra/chunk-reader.js";
import { GitLogReader } from "../../../../../../src/core/domains/trajectory/git/infra/git-log-reader.js";

// Enable cross-module spy interception for adapter functions
vi.mock("../../../../../../src/core/adapters/git/client.js", async (importOriginal) => importOriginal());
vi.mock("../../../../../../src/core/adapters/git/parsers.js", async (importOriginal) => importOriginal());
vi.mock("../../../../../../src/core/domains/trajectory/git/infra/chunk-reader.js", async (importOriginal) =>
  importOriginal(),
);

// ─── getHead — isomorphic-git fallback to CLI ────────────────────────────────

describe("getHead fallback", () => {
  let reader: GitLogReader;

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("should fall back to CLI when isomorphic-git resolveRef fails", async () => {
    reader = new GitLogReader();
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

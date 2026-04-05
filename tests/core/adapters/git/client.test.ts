import { execFile } from "node:child_process";

import { beforeEach, describe, expect, it, vi } from "vitest";

import { getCommitsByPathspec, getCommitsByPathspecBatched } from "../../../../src/core/adapters/git/client.js";
import { parsePathspecOutput } from "../../../../src/core/adapters/git/parsers.js";
import type { CommitInfo } from "../../../../src/core/adapters/git/types.js";

// Mock child_process before imports
vi.mock("node:child_process", () => ({
  execFile: vi.fn(),
  execFileSync: vi.fn(),
}));

// Mock isomorphic-git
vi.mock("isomorphic-git", () => ({
  default: {
    resolveRef: vi.fn(),
    readBlob: vi.fn(),
  },
}));

// Mock parsers — we control their return values to test the batched merge logic
vi.mock("../../../../src/core/adapters/git/parsers.js", () => ({
  parseNumstatOutput: vi.fn(),
  parsePathspecOutput: vi.fn(),
}));

// Mock runtime
vi.mock("../../../../src/core/domains/ingest/pipeline/infra/runtime.js", () => ({
  isDebug: vi.fn(() => true),
}));

// Helper to create a mock execFile that resolves with stdout
function mockExecFileResolving(stdout: string) {
  (execFile as unknown as ReturnType<typeof vi.fn>).mockImplementation(
    (_cmd: string, _args: string[], _opts: object, cb?: (err: Error | null, stdout: string) => void) => {
      // promisify(execFile) calls execFile and wraps in promise
      // The actual signature when promisified: execFile(cmd, args, opts) returns Promise
      // But the mock needs to handle the callback form since promisify wraps it
      if (cb) {
        cb(null, stdout);
      }
      return { stdout };
    },
  );
}

function mockExecFileRejecting(error: Error) {
  (execFile as unknown as ReturnType<typeof vi.fn>).mockImplementation(
    (_cmd: string, _args: string[], _opts: object, cb?: (err: Error | null, stdout: string) => void) => {
      if (cb) {
        cb(error, "");
      }
      return {};
    },
  );
}

const mockParsePathspecOutput = parsePathspecOutput as ReturnType<typeof vi.fn>;

function makeCommit(sha: string, author = "Test Author"): CommitInfo {
  return {
    sha,
    author,
    authorEmail: `${author.toLowerCase().replace(" ", ".")}@test.com`,
    timestamp: Math.floor(Date.now() / 1000),
    body: `commit ${sha.slice(0, 7)}`,
    parents: [],
  };
}

describe("getCommitsByPathspecBatched", () => {
  const repoRoot = "/fake/repo";
  const sinceDate = new Date("2025-01-01");

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("should merge commits from multiple batches by SHA", async () => {
    const commit1 = makeCommit("a".repeat(40));
    const commit2 = makeCommit("b".repeat(40));

    // First batch returns commit1 with file1 and commit2 with file2
    // Second batch returns commit1 again with file3 (same SHA, different files)
    let callCount = 0;
    mockExecFileResolving("fake-stdout");
    mockParsePathspecOutput.mockImplementation(() => {
      callCount++;
      if (callCount === 1) {
        return [
          { commit: commit1, changedFiles: ["src/file1.ts"] },
          { commit: commit2, changedFiles: ["src/file2.ts"] },
        ];
      }
      // Second batch: commit1 appears again with different file
      return [{ commit: commit1, changedFiles: ["src/file3.ts"] }];
    });

    // Generate >500 files to trigger batching
    const filePaths = Array.from({ length: 600 }, (_, i) => `src/file${i}.ts`);
    const result = await getCommitsByPathspecBatched(repoRoot, sinceDate, filePaths);

    // commit1 should have merged changedFiles from both batches
    const commit1Result = result.find((r) => r.commit.sha === "a".repeat(40));
    expect(commit1Result).toBeDefined();
    expect(commit1Result!.changedFiles).toContain("src/file1.ts");
    expect(commit1Result!.changedFiles).toContain("src/file3.ts");
    expect(commit1Result!.changedFiles).toHaveLength(2);

    // commit2 should have only file2
    const commit2Result = result.find((r) => r.commit.sha === "b".repeat(40));
    expect(commit2Result).toBeDefined();
    expect(commit2Result!.changedFiles).toEqual(["src/file2.ts"]);

    expect(result).toHaveLength(2);
  });

  it("should silently handle batch failures in debug mode", async () => {
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const commit1 = makeCommit("c".repeat(40));

    let callCount = 0;
    // First batch succeeds, second batch throws
    (execFile as unknown as ReturnType<typeof vi.fn>).mockImplementation(
      (_cmd: string, _args: string[], _opts: object, cb?: (err: Error | null, stdout: string) => void) => {
        callCount++;
        if (callCount === 1) {
          if (cb) cb(null, "fake-stdout");
          return { stdout: "fake-stdout" };
        }
        // Second call: simulate failure
        if (cb) cb(new Error("git process killed"), "");
        return {};
      },
    );

    // First batch parses OK
    mockParsePathspecOutput
      .mockResolvedValueOnce([{ commit: commit1, changedFiles: ["src/file1.ts"] }])
      .mockImplementationOnce(() => {
        throw new Error("git process killed");
      });

    // Actually, execFileForPathspec uses promisify(execFile), so the error propagates
    // through the promise. Let's set up the mock properly for the batched function.
    // The catch block in getCommitsByPathspecBatched catches errors from getCommitsByPathspecSingle.

    const filePaths = Array.from({ length: 600 }, (_, i) => `src/file${i}.ts`);
    const result = await getCommitsByPathspecBatched(repoRoot, sinceDate, filePaths);

    // First batch succeeded, second batch failed silently
    expect(result).toHaveLength(1);
    expect(result[0].commit.sha).toBe("c".repeat(40));

    // Debug error should have been logged
    expect(consoleSpy).toHaveBeenCalledWith(
      expect.stringContaining("[ChunkChurn] Pathspec batch failed"),
      expect.any(String),
    );

    consoleSpy.mockRestore();
  });

  it("should handle all batches failing gracefully", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});

    mockExecFileRejecting(new Error("git timeout"));
    mockParsePathspecOutput.mockImplementation(() => {
      throw new Error("git timeout");
    });

    const filePaths = Array.from({ length: 600 }, (_, i) => `src/file${i}.ts`);
    const result = await getCommitsByPathspecBatched(repoRoot, sinceDate, filePaths);

    // All batches failed, should return empty
    expect(result).toEqual([]);

    vi.restoreAllMocks();
  });
});

describe("getCommitsByPathspec", () => {
  const repoRoot = "/fake/repo";
  const sinceDate = new Date("2025-01-01");

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("should return empty array for empty filePaths", async () => {
    const result = await getCommitsByPathspec(repoRoot, sinceDate, []);
    expect(result).toEqual([]);
  });

  it("should delegate to single for small file lists", async () => {
    const commit = makeCommit("d".repeat(40));
    mockExecFileResolving("fake-stdout");
    mockParsePathspecOutput.mockReset();
    mockParsePathspecOutput.mockReturnValue([{ commit, changedFiles: ["src/a.ts"] }]);

    const filePaths = Array.from({ length: 100 }, (_, i) => `src/file${i}.ts`);
    const result = await getCommitsByPathspec(repoRoot, sinceDate, filePaths);

    expect(result).toHaveLength(1);
    // Only one execFile call (single, not batched)
    expect(execFile).toHaveBeenCalledTimes(1);
  });

  it("should delegate to batched for large file lists (>500)", async () => {
    mockExecFileResolving("fake-stdout");
    const commit = makeCommit("e".repeat(40));
    mockParsePathspecOutput.mockReturnValue([{ commit, changedFiles: ["src/a.ts"] }]);

    const filePaths = Array.from({ length: 501 }, (_, i) => `src/file${i}.ts`);
    const result = await getCommitsByPathspec(repoRoot, sinceDate, filePaths);

    expect(result.length).toBeGreaterThanOrEqual(1);
    // Should have 2 execFile calls (2 batches: 500 + 1)
    expect(execFile).toHaveBeenCalledTimes(2);
  });
});

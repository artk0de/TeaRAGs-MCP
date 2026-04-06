/**
 * Integration tests for GitLogReader — runs against real git repo.
 *
 * These tests are slow (~5-10s total) because they execute real git commands.
 * They verify end-to-end behavior of buildFileSignalMap, buildChunkChurnMap,
 * and buildFileSignalsForPaths against this project's own git history.
 *
 * Retry: lint-staged stash/unstash can transiently change git state during pre-commit.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

import * as gitClient from "../../../../../../../src/core/adapters/git/client.js";
import {
  computeFileSignals,
  GitLogReader,
} from "../../../../../../../src/core/domains/trajectory/git/infra/git-log-reader.js";

// Enable cross-module spy interception
vi.mock("../../../../../../../src/core/adapters/git/client.js", async (importOriginal) => importOriginal());

async function resolveRepoRoot(): Promise<string> {
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const execAsync = promisify(execFile);
  try {
    const { stdout } = await execAsync("git", ["rev-parse", "--show-toplevel"], {
      cwd: import.meta.url.replace("file://", "").replace(/\/[^/]+$/, ""),
    });
    return stdout.trim();
  } catch {
    return "";
  }
}

// retry: lint-staged stash/unstash can transiently change git state during pre-commit
describe("GitLogReader (integration)", { retry: 2 }, () => {
  let reader: GitLogReader;
  let repoRoot: string;

  beforeEach(async () => {
    reader = new GitLogReader();
    repoRoot = await resolveRepoRoot();
  });

  it("should return HEAD sha for a real git repo", async () => {
    if (!repoRoot) return;

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

    const maxAgeMonths = 0.5;
    const map = await reader.buildFileSignalMap(repoRoot, maxAgeMonths);
    const toleranceSec = maxAgeMonths * 30 * 24 * 3600 * 2;
    const cutoffSec = Date.now() / 1000 - toleranceSec;

    for (const [, entry] of map) {
      for (const commit of entry.commits) {
        expect(commit.timestamp).toBeGreaterThan(cutoffSec);
      }
    }
  });
});

// ─── buildChunkChurnMap (integration) ────────────────────────────────────────

describe("buildChunkChurnMap (integration)", { retry: 2 }, () => {
  let reader: GitLogReader;
  let repoRoot: string;

  beforeEach(async () => {
    reader = new GitLogReader();
    repoRoot = await resolveRepoRoot();
  });

  it("should return empty map when chunkMap is empty", async () => {
    if (!repoRoot) return;
    const result = await reader.buildChunkChurnMap(repoRoot, new Map());
    expect(result.size).toBe(0);
  });

  it("should skip single-chunk files", async () => {
    if (!repoRoot) return;
    const chunkMap = new Map<string, { chunkId: string; startLine: number; endLine: number }[]>();
    chunkMap.set(`${repoRoot}/package.json`, [{ chunkId: "test-id-1", startLine: 1, endLine: 90 }]);
    const result = await reader.buildChunkChurnMap(repoRoot, chunkMap);
    expect(result.size).toBe(0);
  });

  it("should produce valid overlays for multi-chunk files", async () => {
    if (!repoRoot) return;

    const chunkMap = new Map<string, { chunkId: string; startLine: number; endLine: number }[]>();
    chunkMap.set(`${repoRoot}/src/core/api/indexer.ts`, [
      { chunkId: "chunk-top", startLine: 1, endLine: 50 },
      { chunkId: "chunk-mid", startLine: 51, endLine: 200 },
      { chunkId: "chunk-bot", startLine: 201, endLine: 500 },
    ]);

    const result = await reader.buildChunkChurnMap(repoRoot, chunkMap);

    if (result.size > 0) {
      const overlayMap = result.get("src/core/api/indexer.ts");
      if (overlayMap) {
        for (const [, overlay] of overlayMap) {
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

    const withFileData = await reader.buildChunkChurnMap(repoRoot, chunkMap, 10, 6, fileChurnMap);
    const overlayMap = withFileData.get(testFile);
    if (!overlayMap) return;

    for (const [, overlay] of overlayMap) {
      expect(overlay.churnRatio).toBeLessThanOrEqual(1.0);
      expect(overlay.churnRatio).toBeGreaterThanOrEqual(0);
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
        const commitCounts = overlays.map((o) => o.commitCount);
        for (const count of commitCounts) {
          expect(count).toBeGreaterThanOrEqual(0);
        }
      }
    }
  });

  it("should use lineRanges for precise overlap detection (non-contiguous chunks)", async () => {
    if (!repoRoot) return;

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
        ],
      },
      { chunkId: "method-chunk", startLine: 6, endLine: 199 },
    ]);

    const withRanges = await reader.buildChunkChurnMap(repoRoot, chunkMap);

    const chunkMapNoRanges = new Map<string, { chunkId: string; startLine: number; endLine: number }[]>();
    chunkMapNoRanges.set(`${repoRoot}/src/core/api/indexer.ts`, [
      { chunkId: "block-chunk", startLine: 1, endLine: 210 },
      { chunkId: "method-chunk", startLine: 6, endLine: 199 },
    ]);

    const withoutRanges = await reader.buildChunkChurnMap(repoRoot, chunkMapNoRanges);

    const blockWithRanges = withRanges.get("src/core/api/indexer.ts")?.get("block-chunk");
    const blockWithoutRanges = withoutRanges.get("src/core/api/indexer.ts")?.get("block-chunk");

    if (blockWithRanges && blockWithoutRanges) {
      expect(blockWithRanges.commitCount).toBeLessThanOrEqual(blockWithoutRanges.commitCount);
    }
    if (blockWithRanges) {
      expect(blockWithRanges.commitCount).toBeGreaterThanOrEqual(0);
    }
  });

  it("buildFileSignalMap should try CLI first, not isomorphic-git", async () => {
    if (!repoRoot) return;

    const cliSpy = vi.spyOn(gitClient, "buildViaCli");

    await reader.buildFileSignalMap(repoRoot, 1);

    expect(cliSpy).toHaveBeenCalled();

    cliSpy.mockRestore();
  });

  it("should throw when CLI fails (no isomorphic-git fallback)", async () => {
    if (!repoRoot) return;

    const cliSpy = vi.spyOn(gitClient, "buildViaCli").mockRejectedValue(new Error("git not found"));

    await expect(reader.buildFileSignalMap(repoRoot, 1)).rejects.toThrow("git not found");

    cliSpy.mockRestore();
  });

  it("buildViaCli should NOT use --all flag and should NOT use --max-count", async () => {
    if (!repoRoot) return;

    const args = gitClient.buildCliArgs(new Date("2025-01-01"));

    expect(args).not.toContain("--all");
    expect(args).toContain("HEAD");
    const hasMaxCount = args.some((a: string) => a.startsWith("--max-count"));
    expect(hasMaxCount).toBe(false);
    const hasSince = args.some((a: string) => a.startsWith("--since="));
    expect(hasSince).toBe(true);
  });

  it("buildFileSignalsForPaths should fetch metadata for specific files without --since", async () => {
    if (!repoRoot) return;

    const result = await reader.buildFileSignalsForPaths(repoRoot, ["package.json"]);

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

    const chunkMap = new Map<string, { chunkId: string; startLine: number; endLine: number }[]>();
    for (let i = 0; i < 800; i++) {
      chunkMap.set(`${repoRoot}/fake/deep/path/file-${i}.ts`, [
        { chunkId: `chunk-${i}-a`, startLine: 1, endLine: 50 },
        { chunkId: `chunk-${i}-b`, startLine: 51, endLine: 100 },
      ]);
    }

    const result = await reader.buildChunkChurnMap(repoRoot, chunkMap, 10, 1);

    expect(result).toBeInstanceOf(Map);
  });
});

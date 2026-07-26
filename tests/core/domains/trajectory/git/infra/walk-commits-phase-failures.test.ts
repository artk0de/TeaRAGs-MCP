/**
 * walkCommits (bd tea-rags-mcp-6vfrj / G2 phase-slice) — Phase 0 (discovery)
 * and Phase 1 (blob reads + structuredPatch) failure/defensive branches that
 * the happy-path discovery/memo/parents suites in this directory don't drive:
 *
 *   - Phase 0: the injected `WalkCommitDiscovery` throwing recovers to an
 *     empty commit list instead of aborting the whole walk (mirrors the
 *     legacy per-batch pathspec failure semantics one level up).
 *   - Phase 1: `structuredPatch` throwing on malformed diff input memoizes an
 *     empty hunk list (deterministic — identical content never re-throws on a
 *     later walk) instead of propagating.
 *   - Phase 2: a chunk whose accumulator is missing (already dropped by the
 *     caller between chunking and the churn walk) is skipped rather than
 *     crashing the batch — the other chunk in the same file still churns.
 */

import type * as DiffModule from "diff";
import { structuredPatch } from "diff";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { VcsGitAdapter } from "../../../../../../src/core/adapters/vcs/git/adapter.js";
import type { ChunkAccumulator } from "../../../../../../src/core/domains/trajectory/git/infra/metrics.js";
import {
  walkCommits,
  type WalkCommitDiffMemo,
  type WalkCommitDiscovery,
} from "../../../../../../src/core/domains/trajectory/git/infra/walk-commits.js";
import type { ChunkLookupEntry } from "../../../../../../src/core/types.js";

vi.mock("diff", async (importOriginal) => {
  const actual = await importOriginal<typeof DiffModule>();
  return { ...actual, structuredPatch: vi.fn(actual.structuredPatch) };
});

const COMMIT_SHA = "a".repeat(40);
const PARENT_SHA = "p".repeat(40);

function makeAccumulator(): ChunkAccumulator {
  return {
    commitShas: new Set(),
    authors: new Set(),
    bugFixCount: 0,
    lastModifiedAt: 0,
    linesAdded: 0,
    linesDeleted: 0,
    commitTimestamps: [],
    commitAuthors: [],
    taskIds: new Set(),
  };
}

function makeBlobReader(readImpl: (oid: string, filePath: string) => Promise<string>): {
  read: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
} {
  return {
    read: vi.fn().mockImplementation(readImpl),
    close: vi.fn().mockResolvedValue(undefined),
  };
}

describe("walkCommits — Phase 0 discovery failure", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("recovers to an empty commit list when the injected discovery matrix throws, instead of aborting the walk", async () => {
    const commitDiscovery: WalkCommitDiscovery = {
      commitsForFiles: vi.fn().mockRejectedValue(new Error("discovery matrix corrupted")),
      getBugFixShas: vi.fn().mockRejectedValue(new Error("bug-fix index unavailable")),
    };
    const blobReader = makeBlobReader(async () => "unused");
    const relativeChunkMap = new Map<string, ChunkLookupEntry[]>([
      ["src/a.ts", [{ chunkId: "c1", startLine: 1, endLine: 10 }]],
    ]);
    const accumulators = new Map<string, ChunkAccumulator>([["c1", makeAccumulator()]]);

    const result = await walkCommits({
      adapter: {} as unknown as VcsGitAdapter,
      relativeChunkMap,
      accumulators,
      isoGitCache: {},
      concurrency: 4,
      // <= 0 also drives the "default to 120 months" fallback in walkCommits.
      maxAgeMonths: 0,
      chunkTimeoutMs: 5000,
      maxFileLines: 10000,
      blobReader: blobReader as never,
      commitDiscovery,
    });

    expect(result.commitCount).toBe(0);
    expect(blobReader.read).not.toHaveBeenCalled();
    // Caller-injected reader: the walk must never close a reader it did not spawn.
    expect(blobReader.close).not.toHaveBeenCalled();
  });
});

describe("walkCommits — Phase 1 structuredPatch failure", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("memoizes an empty hunk list and completes cleanly when structuredPatch throws on malformed diff input", async () => {
    vi.mocked(structuredPatch).mockImplementationOnce(() => {
      throw new Error("malformed diff input");
    });
    const commitDiscovery: WalkCommitDiscovery = {
      commitsForFiles: vi.fn().mockResolvedValue([
        {
          commit: {
            sha: COMMIT_SHA,
            author: "Alice",
            authorEmail: "alice@ex.com",
            timestamp: Math.floor(Date.now() / 1000),
            body: "feat: change",
            parents: [PARENT_SHA],
          },
          changedFiles: ["src/a.ts"],
        },
      ]),
      getBugFixShas: vi.fn().mockResolvedValue(new Set<string>()),
    };
    const diffMemoSet = vi.fn();
    const diffMemo: WalkCommitDiffMemo = { get: vi.fn().mockReturnValue(undefined), set: diffMemoSet };
    const blobReader = makeBlobReader(async () => "some content\n");
    const relativeChunkMap = new Map<string, ChunkLookupEntry[]>([
      ["src/a.ts", [{ chunkId: "c1", startLine: 1, endLine: 10 }]],
    ]);
    const accumulators = new Map<string, ChunkAccumulator>([["c1", makeAccumulator()]]);

    const result = await walkCommits({
      adapter: {} as unknown as VcsGitAdapter,
      relativeChunkMap,
      accumulators,
      isoGitCache: {},
      concurrency: 4,
      maxAgeMonths: 6,
      chunkTimeoutMs: 5000,
      maxFileLines: 10000,
      blobReader: blobReader as never,
      diffMemo,
      commitDiscovery,
    });

    expect(result.commitCount).toBe(1);
    // The failure is memoized as an empty hunk list — deterministic for
    // identical content — instead of propagating out of the walk.
    expect(diffMemoSet).toHaveBeenCalledWith(COMMIT_SHA, "src/a.ts", []);
    expect(accumulators.get("c1")?.commitShas.size).toBe(0);
  });
});

describe("walkCommits — Phase 2 missing accumulator", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("skips a chunk whose accumulator is missing without crashing the batch, while a sibling chunk in the same file still churns", async () => {
    const oldContent = `${Array.from({ length: 10 }, (_, i) => `old line ${i + 1}`).join("\n")}\n`;
    const newContent = `${Array.from({ length: 10 }, (_, i) => `new line ${i + 1}`).join("\n")}\n`;
    const commitDiscovery: WalkCommitDiscovery = {
      commitsForFiles: vi.fn().mockResolvedValue([
        {
          commit: {
            sha: COMMIT_SHA,
            author: "Alice",
            authorEmail: "alice@ex.com",
            timestamp: Math.floor(Date.now() / 1000),
            body: "feat: change",
            parents: [PARENT_SHA],
          },
          changedFiles: ["src/a.ts"],
        },
      ]),
      getBugFixShas: vi.fn().mockResolvedValue(new Set<string>()),
    };
    const blobReader = makeBlobReader(async (oid) => (oid === PARENT_SHA ? oldContent : newContent));
    // Two chunks span the whole file; the accumulator for "cMissing" was
    // already dropped by the caller (e.g. a prior incremental cycle) before
    // this churn walk ran.
    const relativeChunkMap = new Map<string, ChunkLookupEntry[]>([
      [
        "src/a.ts",
        [
          { chunkId: "cKept", startLine: 1, endLine: 5 },
          { chunkId: "cMissing", startLine: 6, endLine: 10 },
        ],
      ],
    ]);
    const accumulators = new Map<string, ChunkAccumulator>([["cKept", makeAccumulator()]]);

    const result = await walkCommits({
      adapter: {} as unknown as VcsGitAdapter,
      relativeChunkMap,
      accumulators,
      isoGitCache: {},
      concurrency: 4,
      maxAgeMonths: 6,
      chunkTimeoutMs: 5000,
      maxFileLines: 10000,
      blobReader: blobReader as never,
      commitDiscovery,
    });

    expect(result.commitCount).toBe(1);
    // The touched-but-unaccounted chunk was silently skipped...
    expect(accumulators.has("cMissing")).toBe(false);
    // ...while its sibling in the very same file still recorded the commit.
    expect(accumulators.get("cKept")?.commitShas.has(COMMIT_SHA)).toBe(true);
  });
});

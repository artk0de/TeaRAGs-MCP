/**
 * bd tea-rags-mcp-iqpuu — per-walk instrumentation. buildChunkChurnMapUncached
 * reports ONE stats snapshot per walk through the trailing `onWalkStats`
 * callback: batch size (files), discovery slice size (commits), semaphore
 * holds + wait, blob reads, structuredPatch calls, memo hits, and wall time.
 * ChunkPhase turns this into the `[ChunkChurn]` pipeline-log line.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import type { CommitInfo } from "../../../../../../src/core/adapters/git/types.js";
import { buildChunkChurnMapUncached } from "../../../../../../src/core/domains/trajectory/git/infra/chunk-reader.js";
import type {
  ChunkChurnWalkStats,
  WalkCommitDiscovery,
} from "../../../../../../src/core/domains/trajectory/git/infra/walk-commits.js";
import { CommitDiffMemo } from "../../../../../../src/core/infra/commit-diff-memo.js";

const COMMIT_SHA = "a".repeat(40);
const PARENT_SHA = "p".repeat(40);

function commitTouching(changedFiles: string[]): { commit: CommitInfo; changedFiles: string[] } {
  return {
    commit: {
      sha: COMMIT_SHA,
      author: "Alice",
      authorEmail: "alice@ex.com",
      timestamp: Math.floor(Date.now() / 1000),
      body: "feat: change",
      parents: [PARENT_SHA],
    },
    changedFiles,
  };
}

function fakeBlobReader(): { read: ReturnType<typeof vi.fn>; close: ReturnType<typeof vi.fn> } {
  return {
    read: vi.fn().mockImplementation(async (oid: string) => (oid === PARENT_SHA ? "old line\n" : "new line\n")),
    close: vi.fn().mockResolvedValue(undefined),
  };
}

function fakeDiscovery(entries: { commit: CommitInfo; changedFiles: string[] }[]): WalkCommitDiscovery {
  return {
    commitsForFiles: vi.fn().mockResolvedValue(entries),
    getBugFixShas: vi.fn().mockResolvedValue(new Set<string>()),
  } as never;
}

const chunkMapFor = (file: string) =>
  new Map<string, { chunkId: string; startLine: number; endLine: number }[]>([
    [file, [{ chunkId: "c1", startLine: 1, endLine: 10 }]],
  ]);

async function walkOnce(
  file: string,
  blobReader: ReturnType<typeof fakeBlobReader>,
  discovery: WalkCommitDiscovery,
  onWalkStats: (stats: ChunkChurnWalkStats) => void,
  memo?: CommitDiffMemo,
): Promise<void> {
  await buildChunkChurnMapUncached(
    "/fake/repo",
    chunkMapFor(file),
    {},
    10,
    6,
    undefined,
    undefined,
    120000,
    10000,
    undefined,
    undefined,
    blobReader as never,
    memo,
    discovery,
    onWalkStats,
  );
}

describe("chunk-churn walk stats (bd tea-rags-mcp-iqpuu)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("reports one stats snapshot per walk with exact counters", async () => {
    const discovery = fakeDiscovery([commitTouching(["test.ts"])]);
    const onWalkStats = vi.fn();

    await walkOnce("test.ts", fakeBlobReader(), discovery, onWalkStats);

    expect(onWalkStats).toHaveBeenCalledTimes(1);
    const stats = onWalkStats.mock.calls[0][0] as ChunkChurnWalkStats;
    expect(stats.files).toBe(1);
    expect(stats.commits).toBe(1);
    expect(stats.holdCount).toBe(1);
    expect(stats.blobReads).toBe(2);
    expect(stats.patches).toBe(1);
    expect(stats.memoHits).toBe(0);
    expect(stats.semWaitMs).toBeGreaterThanOrEqual(0);
    expect(stats.wallMs).toBeGreaterThanOrEqual(0);
  });

  it("counts memo hits instead of blob reads on a fully-memoized second walk", async () => {
    const discovery = fakeDiscovery([commitTouching(["test.ts"])]);
    const memo = new CommitDiffMemo();
    const first = vi.fn();
    const second = vi.fn();
    const blobReader = fakeBlobReader();

    await walkOnce("test.ts", blobReader, discovery, first, memo);
    await walkOnce("test.ts", blobReader, discovery, second, memo);

    const stats = second.mock.calls[0][0] as ChunkChurnWalkStats;
    expect(stats.memoHits).toBe(1);
    expect(stats.blobReads).toBe(0);
    expect(stats.patches).toBe(0);
  });

  it("stays silent when no callback is passed (opt-in instrumentation)", async () => {
    const discovery = fakeDiscovery([commitTouching(["test.ts"])]);
    const blobReader = fakeBlobReader();

    // Signature without the trailing callback must keep working unchanged.
    const result = (await buildChunkChurnMapUncached(
      "/fake/repo",
      chunkMapFor("test.ts"),
      {},
      10,
      6,
      undefined,
      undefined,
      120000,
      10000,
      undefined,
      undefined,
      blobReader as never,
      undefined,
      discovery,
    )) as never as Map<string, Map<string, { commitCount: number }>>;

    expect(result.get("test.ts")?.get("c1")?.commitCount).toBe(1);
  });
});

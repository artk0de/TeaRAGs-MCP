/**
 * bd tea-rags-mcp-7gnre — run-scoped (commitSha, filePath) → hunks memo.
 *
 * The same sweep commits are re-diffed by every per-batch chunk-churn walk of a
 * run (double-walk amplifier). A caller-owned memo threaded into walkCommits
 * must make the second walk over the same (commit, file) skip the blob reads,
 * the structuredPatch call, AND the parent rev lookup — while producing the
 * same overlays.
 */

import { structuredPatch } from "diff";
import { afterEach, describe, expect, it, vi } from "vitest";

import * as gitClient from "../../../../../../src/core/adapters/git/client.js";
import { CommitDiffMemo } from "../../../../../../src/core/infra/commit-diff-memo.js";
import { buildChunkChurnMapUncached } from "../../../../../../src/core/domains/trajectory/git/infra/chunk-reader.js";

// Wrap the real structuredPatch in a spy so recompute counts are observable.
vi.mock("diff", async (importOriginal) => {
  const actual = await importOriginal<{ structuredPatch: (...args: never[]) => unknown }>();
  return { ...actual, structuredPatch: vi.fn(actual.structuredPatch) };
});
// Enable cross-module spy interception for adapter functions.
vi.mock("../../../../../../src/core/adapters/git/client.js", async (importOriginal) => importOriginal());

const COMMIT_SHA = "a".repeat(40);
const PARENT_SHA = "p".repeat(40);

function mockOneCommitTouching(file: string): void {
  vi.spyOn(gitClient, "getCommitsByPathspec").mockResolvedValue([
    {
      commit: {
        sha: COMMIT_SHA,
        author: "Alice",
        authorEmail: "alice@ex.com",
        timestamp: Math.floor(Date.now() / 1000),
        body: "feat: change",
      },
      changedFiles: [file],
    },
  ]);
}

function fakeBlobReader(): { read: ReturnType<typeof vi.fn>; close: ReturnType<typeof vi.fn> } {
  return {
    // Parent blob differs from commit blob → structuredPatch yields 1 hunk.
    read: vi.fn().mockImplementation(async (oid: string) => (oid === PARENT_SHA ? "old line\n" : "new line\n")),
    close: vi.fn().mockResolvedValue(undefined),
  };
}

const chunkMapFor = (file: string) =>
  new Map<string, { chunkId: string; startLine: number; endLine: number }[]>([
    [file, [{ chunkId: "c1", startLine: 1, endLine: 10 }]],
  ]);

async function walkOnce(
  file: string,
  blobReader: ReturnType<typeof fakeBlobReader>,
  memo: CommitDiffMemo,
): Promise<Map<string, Map<string, { commitCount: number }>>> {
  return (await buildChunkChurnMapUncached(
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
  )) as never;
}

describe("walkCommits run-scoped diff memo (bd tea-rags-mcp-7gnre)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.mocked(structuredPatch).mockClear();
  });

  it("second walk over the same (commit, file) does not recompute the diff and does not re-read blobs", async () => {
    mockOneCommitTouching("test.ts");
    vi.spyOn(gitClient, "readCommitParent").mockResolvedValue(PARENT_SHA);
    const blobReader = fakeBlobReader();
    const memo = new CommitDiffMemo();

    const first = await walkOnce("test.ts", blobReader, memo);
    const patchesAfterFirst = vi.mocked(structuredPatch).mock.calls.length;
    const readsAfterFirst = blobReader.read.mock.calls.length;
    expect(patchesAfterFirst).toBeGreaterThan(0);
    expect(readsAfterFirst).toBe(2); // parent + commit blob

    const second = await walkOnce("test.ts", blobReader, memo);
    // Memo hit → no re-diff, no blob re-reads.
    expect(vi.mocked(structuredPatch).mock.calls.length).toBe(patchesAfterFirst);
    expect(blobReader.read.mock.calls.length).toBe(readsAfterFirst);

    // Correctness: the memoized walk produces the same overlay.
    expect(second.get("test.ts")?.get("c1")?.commitCount).toBe(first.get("test.ts")?.get("c1")?.commitCount);
    expect(second.get("test.ts")?.get("c1")?.commitCount).toBe(1);
  });

  it("skips the parent rev lookup entirely when every file of a commit hits the memo", async () => {
    mockOneCommitTouching("test.ts");
    const parentSpy = vi.spyOn(gitClient, "readCommitParent").mockResolvedValue(PARENT_SHA);
    const blobReader = fakeBlobReader();
    const memo = new CommitDiffMemo();

    await walkOnce("test.ts", blobReader, memo);
    expect(parentSpy).toHaveBeenCalledTimes(1);

    await walkOnce("test.ts", blobReader, memo);
    // Fully-memoized commit → no second rev-parse.
    expect(parentSpy).toHaveBeenCalledTimes(1);
  });

  it("memoizes the empty diff (identical blobs) so the second walk skips blob reads too", async () => {
    mockOneCommitTouching("same.ts");
    vi.spyOn(gitClient, "readCommitParent").mockResolvedValue(PARENT_SHA);
    const blobReader = fakeBlobReader();
    blobReader.read.mockResolvedValue("identical\ncontent\n");
    const memo = new CommitDiffMemo();

    const first = await walkOnce("same.ts", blobReader, memo);
    const readsAfterFirst = blobReader.read.mock.calls.length;
    expect(readsAfterFirst).toBe(2);
    // Identical blobs → zero hunks → zero commitCount on the chunk.
    expect(first.get("same.ts")?.get("c1")?.commitCount).toBe(0);

    const second = await walkOnce("same.ts", blobReader, memo);
    expect(blobReader.read.mock.calls.length).toBe(readsAfterFirst);
    expect(second.get("same.ts")?.get("c1")?.commitCount).toBe(0);
  });

  it("walks WITHOUT a memo behave exactly as before (memo is opt-in)", async () => {
    mockOneCommitTouching("test.ts");
    vi.spyOn(gitClient, "readCommitParent").mockResolvedValue(PARENT_SHA);
    const blobReader = fakeBlobReader();

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
    )) as never as Map<string, Map<string, { commitCount: number }>>;

    expect(result.get("test.ts")?.get("c1")?.commitCount).toBe(1);
    expect(vi.mocked(structuredPatch).mock.calls.length).toBeGreaterThan(0);
  });
});

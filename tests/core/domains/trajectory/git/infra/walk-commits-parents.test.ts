/**
 * bd tea-rags-mcp-iqpuu — the chunk-churn walk resolves each commit's diff
 * base from `CommitInfo.parents` (already parsed from `%P` by the git log
 * parsers and validated by the discovery store) instead of spawning a
 * `git rev-parse <sha>^` subprocess per commit (~3900 spawns/run removed).
 *
 * No `readCommitParent` mock exists here BY DESIGN: the repoRoot is a fake
 * path, so ANY subprocess fallback would fail and zero the overlays — the
 * `commitCount: 1` pins prove the parent came from the matrix, not a spawn.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import { GitCliAdapter } from "../../../../../../src/core/adapters/vcs/git/git-cli/adapter.js";
import type { CommitInfo } from "../../../../../../src/core/adapters/vcs/types.js";
import { buildChunkChurnMapUncached } from "../../../../../../src/core/domains/trajectory/git/infra/chunk-reader.js";
import type { WalkCommitDiscovery } from "../../../../../../src/core/domains/trajectory/git/infra/walk-commits.js";

const COMMIT_SHA = "a".repeat(40);
const PARENT_SHA = "p".repeat(40);
const SECOND_PARENT_SHA = "q".repeat(40);

function commitTouching(
  changedFiles: string[],
  parents: string[] | undefined,
  body = "feat: change",
): { commit: CommitInfo; changedFiles: string[] } {
  const commit = {
    sha: COMMIT_SHA,
    author: "Alice",
    authorEmail: "alice@ex.com",
    timestamp: Math.floor(Date.now() / 1000),
    body,
  } as CommitInfo;
  // `undefined` models a legacy fixture / loose-cast shape with NO parents
  // field at all — the walk must treat it as a root commit, never spawn.
  if (parents !== undefined) commit.parents = parents;
  return { commit, changedFiles };
}

function fakeBlobReader(): { read: ReturnType<typeof vi.fn>; close: ReturnType<typeof vi.fn> } {
  return {
    // Parent blob differs from commit blob → structuredPatch yields 1 hunk.
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
): Promise<Map<string, Map<string, { commitCount: number }>>> {
  return (await buildChunkChurnMapUncached(
    new GitCliAdapter("/fake/repo"),
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
    undefined,
    discovery,
  )) as never;
}

describe("walkCommits parents-from-matrix (bd tea-rags-mcp-iqpuu)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("diffs against CommitInfo.parents[0] without any rev-parse subprocess", async () => {
    const discovery = fakeDiscovery([commitTouching(["test.ts"], [PARENT_SHA])]);
    const blobReader = fakeBlobReader();

    const result = await walkOnce("test.ts", blobReader, discovery);

    // The parent oid must come straight from the matrix row: the blob reader
    // sees PARENT_SHA (old blob) + COMMIT_SHA (new blob), and the hunk lands.
    expect(blobReader.read).toHaveBeenCalledWith(PARENT_SHA, "test.ts");
    expect(blobReader.read).toHaveBeenCalledWith(COMMIT_SHA, "test.ts");
    expect(result.get("test.ts")?.get("c1")?.commitCount).toBe(1);
  });

  it("uses the FIRST parent of a merge commit (mirrors `git rev-parse <sha>^`)", async () => {
    const discovery = fakeDiscovery([commitTouching(["test.ts"], [PARENT_SHA, SECOND_PARENT_SHA])]);
    const blobReader = fakeBlobReader();

    const result = await walkOnce("test.ts", blobReader, discovery);

    expect(blobReader.read).toHaveBeenCalledWith(PARENT_SHA, "test.ts");
    expect(blobReader.read).not.toHaveBeenCalledWith(SECOND_PARENT_SHA, "test.ts");
    expect(result.get("test.ts")?.get("c1")?.commitCount).toBe(1);
  });

  it("treats parents: [] as a root commit — nothing to diff, zero blob reads", async () => {
    const discovery = fakeDiscovery([commitTouching(["test.ts"], [])]);
    const blobReader = fakeBlobReader();

    const result = await walkOnce("test.ts", blobReader, discovery);

    expect(blobReader.read).not.toHaveBeenCalled();
    expect(result.get("test.ts")?.get("c1")?.commitCount).toBe(0);
  });

  it("treats an ABSENT parents field as a root commit (legacy fixture shape)", async () => {
    const discovery = fakeDiscovery([commitTouching(["test.ts"], undefined)]);
    const blobReader = fakeBlobReader();

    const result = await walkOnce("test.ts", blobReader, discovery);

    expect(blobReader.read).not.toHaveBeenCalled();
    expect(result.get("test.ts")?.get("c1")?.commitCount).toBe(0);
  });
});

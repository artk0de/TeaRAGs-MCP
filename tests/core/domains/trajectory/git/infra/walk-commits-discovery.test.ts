/**
 * bd tea-rags-mcp-82va1 — walkCommits consumes the run-scoped commit-discovery
 * matrix instead of running its own per-batch pathspec log.
 *
 * When a WalkCommitDiscovery is injected: NO getCommitsByPathspec spawn, the
 * slice comes from commitsForFiles, and the bugFixShaSet is the ONE shared set
 * from getBugFixShas. Absent ⇒ exact legacy per-batch discovery.
 */

import { afterEach, describe, expect, it, vi } from "vitest";

import * as gitClient from "../../../../../../src/core/adapters/git/client.js";
import type { CommitInfo } from "../../../../../../src/core/adapters/git/types.js";
import { buildChunkChurnMapUncached } from "../../../../../../src/core/domains/trajectory/git/infra/chunk-reader.js";
import type { WalkCommitDiscovery } from "../../../../../../src/core/domains/trajectory/git/infra/walk-commits.js";

// Enable cross-module spy interception for adapter functions.
vi.mock("../../../../../../src/core/adapters/git/client.js", async (importOriginal) => importOriginal());

const COMMIT_SHA = "a".repeat(40);
const PARENT_SHA = "p".repeat(40);

function commitTouching(changedFiles: string[], body = "feat: change"): { commit: CommitInfo; changedFiles: string[] } {
  return {
    commit: {
      sha: COMMIT_SHA,
      author: "Alice",
      authorEmail: "alice@ex.com",
      timestamp: Math.floor(Date.now() / 1000),
      body,
      parents: [PARENT_SHA],
    },
    changedFiles,
  };
}

function fakeBlobReader(): { read: ReturnType<typeof vi.fn>; close: ReturnType<typeof vi.fn> } {
  return {
    // Parent blob differs from commit blob → structuredPatch yields 1 hunk.
    read: vi.fn().mockImplementation(async (oid: string) => (oid === PARENT_SHA ? "old line\n" : "new line\n")),
    close: vi.fn().mockResolvedValue(undefined),
  };
}

function fakeDiscovery(
  entries: { commit: CommitInfo; changedFiles: string[] }[],
  bugFixShas = new Set<string>(),
): { commitsForFiles: ReturnType<typeof vi.fn>; getBugFixShas: ReturnType<typeof vi.fn> } {
  return {
    commitsForFiles: vi.fn().mockResolvedValue(entries),
    getBugFixShas: vi.fn().mockResolvedValue(bugFixShas),
  };
}

const chunkMapFor = (file: string) =>
  new Map<string, { chunkId: string; startLine: number; endLine: number }[]>([
    [file, [{ chunkId: "c1", startLine: 1, endLine: 10 }]],
  ]);

async function walkOnce(
  file: string,
  blobReader: ReturnType<typeof fakeBlobReader>,
  discovery?: WalkCommitDiscovery,
): Promise<Map<string, Map<string, { commitCount: number; bugFixRate: number }>>> {
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
    undefined,
    discovery,
  )) as never;
}

describe("walkCommits run-scoped commit discovery (bd tea-rags-mcp-82va1)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("slices the injected matrix instead of spawning a per-batch pathspec log", async () => {
    const pathspecSpy = vi.spyOn(gitClient, "getCommitsByPathspec").mockResolvedValue([]);
    const discovery = fakeDiscovery([commitTouching(["test.ts"])]);
    const blobReader = fakeBlobReader();

    const result = await walkOnce("test.ts", blobReader, discovery as never);

    expect(pathspecSpy).not.toHaveBeenCalled();
    expect(discovery.commitsForFiles).toHaveBeenCalledWith(["test.ts"]);
    expect(result.get("test.ts")?.get("c1")?.commitCount).toBe(1);
  });

  it("handles matrix rows carrying FULL changedFiles — files outside the chunkMap produce no overlays", async () => {
    vi.spyOn(gitClient, "getCommitsByPathspec").mockResolvedValue([]);
    const discovery = fakeDiscovery([commitTouching(["test.ts", "other.ts"])]);
    const blobReader = fakeBlobReader();

    const result = await walkOnce("test.ts", blobReader, discovery as never);

    expect(result.get("test.ts")?.get("c1")?.commitCount).toBe(1);
    expect(result.has("other.ts")).toBe(false);
  });

  it("consumes the ONE shared bugFixShaSet from the discovery", async () => {
    vi.spyOn(gitClient, "getCommitsByPathspec").mockResolvedValue([]);
    // Non-fix commit body — the ONLY bug-fix evidence is the shared set.
    const discovery = fakeDiscovery([commitTouching(["test.ts"], "feat: not a fix")], new Set([COMMIT_SHA]));
    const blobReader = fakeBlobReader();

    const result = await walkOnce("test.ts", blobReader, discovery as never);

    expect(result.get("test.ts")?.get("c1")?.bugFixRate).toBe(100);
  });

  it("falls back to the legacy per-batch pathspec log when no discovery is injected", async () => {
    const pathspecSpy = vi.spyOn(gitClient, "getCommitsByPathspec").mockResolvedValue([commitTouching(["test.ts"])]);
    const blobReader = fakeBlobReader();

    const result = await walkOnce("test.ts", blobReader);

    expect(pathspecSpy).toHaveBeenCalledTimes(1);
    expect(result.get("test.ts")?.get("c1")?.commitCount).toBe(1);
  });
});

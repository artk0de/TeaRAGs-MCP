/**
 * bd tea-rags-mcp-0dwsn — a rename commit must reach chunk attribution, and it
 * must credit only the lines it actually changed.
 *
 * Two failure modes bracket the correct behaviour, and both were measured on
 * the live self-index before this suite existed:
 *
 * - UNDER-count (the defect): the numstat column arrives mangled as
 *   `pre{old => new}post`, matches nothing in `relativeChunkMap`, and the walk
 *   drops the commit before any blob read. Every chunk of the file publishes
 *   `commitCount: 0` because `buildAccumulators` pre-seeded a zeroed
 *   accumulator for it.
 * - OVER-count (what un-mangling to the new path ALONE produces): the parent
 *   blob is read at the post-rename path, which does not exist at the parent,
 *   so `structuredPatch` sees `"" -> whole file` and reports one hunk spanning
 *   the file. The rename commit is then credited to EVERY chunk.
 *
 * The fix must land between them: match on the CURRENT path, read the parent
 * side at the PREVIOUS one.
 */

import { afterEach, describe, expect, it, vi } from "vitest";

import { GitCliAdapter } from "../../../../../../src/core/adapters/vcs/git/git-cli/adapter.js";
import type { CommitChangedPath, CommitWithChangedFiles } from "../../../../../../src/core/adapters/vcs/types.js";
import { buildChunkChurnMapUncached } from "../../../../../../src/core/domains/trajectory/git/infra/chunk-reader.js";
import type { WalkCommitDiscovery } from "../../../../../../src/core/domains/trajectory/git/infra/walk-commits.js";

vi.mock("../../../../../../src/core/adapters/vcs/git/git-cli/client.js", async (importOriginal) => importOriginal());

const COMMIT_SHA = "a".repeat(40);
const PARENT_SHA = "p".repeat(40);
const NEW_PATH = "tests/bootstrap/env-snapshot.test.ts";
const OLD_PATH = "tests/bootstrap/tuning-snapshot.test.ts";

/** 60 lines; the rename commit rewrites exactly lines 31-33. */
const line = (n: number): string => `line ${n}`;
const PARENT_CONTENT = `${Array.from({ length: 60 }, (_, i) => line(i + 1)).join("\n")}\n`;
const COMMIT_CONTENT = `${Array.from({ length: 60 }, (_, i) => (i >= 30 && i <= 32 ? `changed ${i + 1}` : line(i + 1))).join("\n")}\n`;

function renameCommit(changedFiles: CommitChangedPath[]): CommitWithChangedFiles {
  return {
    commit: {
      sha: COMMIT_SHA,
      author: "Alice",
      authorEmail: "alice@ex.com",
      timestamp: Math.floor(Date.now() / 1000),
      body: "refactor(config): rename the snapshot",
      parents: [PARENT_SHA],
    },
    changedFiles,
  };
}

/** Only OLD_PATH exists at the parent; only NEW_PATH exists at the commit. */
function renameAwareBlobReader(): { read: ReturnType<typeof vi.fn>; close: ReturnType<typeof vi.fn> } {
  return {
    read: vi.fn().mockImplementation(async (oid: string, path: string) => {
      if (oid === PARENT_SHA) return path === OLD_PATH ? PARENT_CONTENT : "";
      return path === NEW_PATH ? COMMIT_CONTENT : "";
    }),
    close: vi.fn().mockResolvedValue(undefined),
  };
}

function fakeDiscovery(entries: CommitWithChangedFiles[]): WalkCommitDiscovery {
  return {
    commitsForFiles: vi.fn().mockResolvedValue(entries),
    getBugFixShas: vi.fn().mockResolvedValue(new Set<string>()),
  };
}

/** Six 10-line chunks over the 60-line file; only `c4` covers lines 31-40. */
const chunkMap = (): Map<string, { chunkId: string; startLine: number; endLine: number }[]> =>
  new Map([
    [
      NEW_PATH,
      Array.from({ length: 6 }, (_, i) => ({
        chunkId: `c${i + 1}`,
        startLine: i * 10 + 1,
        endLine: i * 10 + 10,
      })),
    ],
  ]);

async function walk(
  discovery: WalkCommitDiscovery,
  blobReader: ReturnType<typeof renameAwareBlobReader>,
): Promise<Map<string, Map<string, { commitCount: number }>>> {
  return await buildChunkChurnMapUncached(
    new GitCliAdapter("/fake/repo"),
    chunkMap(),
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
  );
}

describe("walkCommits rename attribution (bd tea-rags-mcp-0dwsn)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("attributes a rename commit to the file under its CURRENT path", async () => {
    const blobReader = renameAwareBlobReader();

    const overlays = await walk(
      fakeDiscovery([renameCommit([{ path: NEW_PATH, previousPath: OLD_PATH }])]),
      blobReader,
    );

    const perChunk = overlays.get(NEW_PATH);
    expect(perChunk).toBeDefined();
    // The commit reached attribution at all — the defect dropped it entirely.
    expect([...perChunk!.values()].some((o) => o.commitCount === 1)).toBe(true);
  });

  it("reads the parent side at the PREVIOUS path and the commit side at the current one", async () => {
    const blobReader = renameAwareBlobReader();

    await walk(fakeDiscovery([renameCommit([{ path: NEW_PATH, previousPath: OLD_PATH }])]), blobReader);

    expect(blobReader.read).toHaveBeenCalledWith(PARENT_SHA, OLD_PATH);
    expect(blobReader.read).toHaveBeenCalledWith(COMMIT_SHA, NEW_PATH);
    expect(blobReader.read).not.toHaveBeenCalledWith(PARENT_SHA, NEW_PATH);
  });

  it("credits the changed lines' neighbourhood, not every chunk of the renamed file", async () => {
    const blobReader = renameAwareBlobReader();

    const overlays = await walk(
      fakeDiscovery([renameCommit([{ path: NEW_PATH, previousPath: OLD_PATH }])]),
      blobReader,
    );

    const credited = [...overlays.get(NEW_PATH)!.entries()].filter(([, o]) => o.commitCount > 0).map(([id]) => id);
    // Lines 31-33 changed. `structuredPatch` runs with its default context, so
    // the hunk reaches a few lines either side and the chunk before the change
    // is touched too — that is genuine diff geometry, not over-attribution.
    // What must NOT happen is the whole file being credited.
    expect(credited).toContain("c4");
    expect(credited.length).toBeLessThan(6);
    expect(credited).not.toContain("c1");
    expect(credited).not.toContain("c6");
  });

  it("COUNTERFACTUAL: dropping previousPath credits the rename to EVERY chunk", async () => {
    const blobReader = renameAwareBlobReader();

    // Exactly what un-mangling to the new path alone produces: the parent blob
    // is read at a path that does not exist there, so the diff is "" -> file.
    const overlays = await walk(fakeDiscovery([renameCommit([{ path: NEW_PATH }])]), blobReader);

    const credited = [...overlays.get(NEW_PATH)!.entries()].filter(([, o]) => o.commitCount > 0).map(([id]) => id);
    expect(credited).toEqual(["c1", "c2", "c3", "c4", "c5", "c6"]);
  });

  it("leaves a non-rename row reading both sides at the same path", async () => {
    // Same file present at both revisions — the ordinary, non-rename case.
    const blobReader = {
      read: vi.fn().mockImplementation(async (oid: string) => (oid === PARENT_SHA ? PARENT_CONTENT : COMMIT_CONTENT)),
      close: vi.fn().mockResolvedValue(undefined),
    };

    const overlays = await walk(fakeDiscovery([renameCommit([{ path: NEW_PATH }])]), blobReader);

    expect(blobReader.read).toHaveBeenCalledWith(PARENT_SHA, NEW_PATH);
    expect(overlays.get(NEW_PATH)?.get("c4")?.commitCount).toBe(1);
  });
});

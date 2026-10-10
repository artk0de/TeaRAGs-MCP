/**
 * bd tea-rags-mcp-89k7k.35.22 S2 — `PathspecNumstatReads`: one on-demand
 * computation's pathspec numstat reads, so the chunk walk's window can be
 * sliced out of the file walk's wider `--full-history` read instead of being
 * read again. A slice is served only from a WINDOWED read whose path set
 * covers the request and whose window contains it; it holds what a narrow read
 * of the same paths would: the commits at or after `since` with a row on a
 * requested path (either side of a rename), rows on other paths dropped.
 */
import { describe, expect, it, vi } from "vitest";

import type { CommitFileNumstat } from "../../../../../../src/core/adapters/vcs/types.js";
import { createPathspecNumstatReads } from "../../../../../../src/core/domains/trajectory/git/infra/pathspec-numstat-reads.js";

const SEC = 1_700_000_000;

function entry(
  sha: string,
  committerTimestamp: number,
  files: CommitFileNumstat["files"],
  parents: string[] = ["p".repeat(40)],
): CommitFileNumstat {
  return {
    commit: {
      sha: sha.repeat(40),
      author: "A",
      authorEmail: "a@x",
      timestamp: committerTimestamp,
      body: "m\n",
      parents,
    },
    committerTimestamp,
    files,
  };
}

const WIDE: CommitFileNumstat[] = [
  entry("a", SEC + 300, [
    { path: "src/c.ts", added: 1, deleted: 1 },
    { path: "src/d.ts", added: 2, deleted: 0 },
  ]),
  entry("b", SEC + 200, [{ path: "src/d.ts", added: 1, deleted: 0 }]),
  entry("c", SEC + 100, [{ path: "src/c.ts", previousPath: "src/old.ts", added: 0, deleted: 0 }]),
  entry("d", SEC - 100, [{ path: "src/c.ts", added: 5, deleted: 0 }]),
];

function adapterOf(read: CommitFileNumstat[] = WIDE) {
  return { readCommitFileNumstatForPaths: vi.fn(async () => read) };
}

describe("createPathspecNumstatReads", () => {
  it("reads through the adapter and memoises an identical read", async () => {
    const adapter = adapterOf();
    const reads = createPathspecNumstatReads(adapter);
    const since = new Date((SEC - 1000) * 1000);

    const first = await reads.read(["src/c.ts", "src/d.ts"], 30_000, since);
    const second = await reads.read(["src/d.ts", "src/c.ts"], 30_000, since);

    expect(first).toBe(WIDE);
    expect(second).toBe(WIDE);
    expect(adapter.readCommitFileNumstatForPaths).toHaveBeenCalledTimes(1);
    expect(adapter.readCommitFileNumstatForPaths).toHaveBeenCalledWith(["src/c.ts", "src/d.ts"], 30_000, since);
  });

  it("slices a covering, wider read to the requested paths and window", async () => {
    const reads = createPathspecNumstatReads(adapterOf());
    await reads.read(["src/c.ts", "src/d.ts", "src/old.ts"], 30_000, new Date((SEC - 1000) * 1000));

    expect(reads.sliceFor(["src/c.ts"], new Date(SEC * 1000))).toEqual([
      { ...WIDE[0], files: [{ path: "src/c.ts", added: 1, deleted: 1 }] },
      WIDE[2],
    ]);
  });

  it("keeps a rename row whose previous side is the requested path", async () => {
    const reads = createPathspecNumstatReads(adapterOf());
    await reads.read(["src/c.ts", "src/old.ts"], 30_000, new Date((SEC - 1000) * 1000));

    expect(reads.sliceFor(["src/old.ts"], new Date(SEC * 1000))).toEqual([WIDE[2]]);
  });

  it("keeps a commit exactly at the window's lower bound, as git's --since does", async () => {
    const reads = createPathspecNumstatReads(adapterOf());
    await reads.read(["src/c.ts"], 30_000, new Date((SEC - 1000) * 1000));

    expect(reads.sliceFor(["src/c.ts"], new Date((SEC + 100) * 1000 + 999))?.map((e) => e.commit.sha)).toEqual([
      "a".repeat(40),
      "c".repeat(40),
    ]);
  });

  it("keeps a merge (no rows) inside the window", async () => {
    const merge = entry("m", SEC + 50, [], ["p".repeat(40), "q".repeat(40)]);
    const reads = createPathspecNumstatReads(adapterOf([...WIDE, merge]));
    await reads.read(["src/c.ts"], 30_000, new Date((SEC - 1000) * 1000));

    expect(reads.sliceFor(["src/c.ts"], new Date(SEC * 1000))).toContainEqual(merge);
  });

  it("serves nothing when the cached window is narrower than the request", async () => {
    const reads = createPathspecNumstatReads(adapterOf());
    await reads.read(["src/c.ts", "src/d.ts"], 30_000, new Date(SEC * 1000));

    expect(reads.sliceFor(["src/c.ts"], new Date((SEC - 1) * 1000))).toBeUndefined();
  });

  it("serves nothing when the cached path set does not cover the request", async () => {
    const reads = createPathspecNumstatReads(adapterOf());
    await reads.read(["src/c.ts"], 30_000, new Date((SEC - 1000) * 1000));

    expect(reads.sliceFor(["src/c.ts", "src/old.ts"], new Date(SEC * 1000))).toBeUndefined();
  });

  it("never serves an unwindowed read (it is not a --full-history walk)", async () => {
    const reads = createPathspecNumstatReads(adapterOf());
    await reads.read(["src/c.ts", "src/d.ts"], 30_000);

    expect(reads.sliceFor(["src/c.ts"], new Date(SEC * 1000))).toBeUndefined();
  });

  it("does not remember a failed read", async () => {
    const adapter = { readCommitFileNumstatForPaths: vi.fn().mockRejectedValueOnce(new Error("boom")) };
    adapter.readCommitFileNumstatForPaths.mockResolvedValueOnce(WIDE);
    const reads = createPathspecNumstatReads(adapter);
    const since = new Date((SEC - 1000) * 1000);

    await expect(reads.read(["src/c.ts"], 30_000, since)).rejects.toThrow("boom");
    expect(reads.sliceFor(["src/c.ts"], new Date(SEC * 1000))).toBeUndefined();
    await expect(reads.read(["src/c.ts"], 30_000, since)).resolves.toBe(WIDE);
  });
});

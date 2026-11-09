/**
 * `foldFileLifetimeStamps` — whole-history age stamps per HEAD path (bd
 * tea-rags-mcp-i6tkc): newest / oldest AUTHOR date across every name the file
 * had, a path re-created after a rename keeping its own history.
 *
 * `readFileLifetimeStampsCached` (bd tea-rags-mcp-61gt2): the persistent
 * store's read modes — cold walk, same-HEAD cache hit (no git), tip..HEAD
 * incremental top-up, unknown-tip fallback to cold.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { VcsGitAdapter } from "../../../../../../src/core/adapters/vcs/index.js";
import type { CommitPathChanges } from "../../../../../../src/core/adapters/vcs/types.js";
import { GitFileLifetimeStore } from "../../../../../../src/core/domains/trajectory/git/infra/file-lifetime-store.js";
import {
  addDormantFileChurn,
  foldFileLifetimeStamps,
  foldIntoFileLifetimeStamps,
  readFileLifetimeStampsCached,
} from "../../../../../../src/core/domains/trajectory/git/infra/file-lifetime.js";

// Newest → oldest log order; author dates need not follow it (a rebase).
const LOG: CommitPathChanges[] = [
  { sha: "s5", timestamp: 500, changedFiles: [{ path: "old.ts" }] }, // re-created after the rename
  { sha: "s4", timestamp: 300, changedFiles: [{ path: "new.ts", previousPath: "old.ts" }] },
  { sha: "s3", timestamp: 350, changedFiles: [{ path: "old.ts" }] }, // rebased: newer author date than the rename
  { sha: "s2", timestamp: 200, changedFiles: [{ path: "old.ts" }, { path: "other.ts" }] },
  { sha: "s1", timestamp: 100, changedFiles: [{ path: "old.ts" }] },
];

describe("foldFileLifetimeStamps", () => {
  it("follows a rename back to the first name, and keeps a re-created path apart", () => {
    const stamps = foldFileLifetimeStamps(LOG);

    expect(stamps.get("new.ts")).toEqual({ lastModifiedAt: 350, firstCreatedAt: 100, lastCommitHash: "s3" });
    expect(stamps.get("old.ts")).toEqual({ lastModifiedAt: 500, firstCreatedAt: 500, lastCommitHash: "s5" });
    expect(stamps.get("other.ts")).toEqual({ lastModifiedAt: 200, firstCreatedAt: 200, lastCommitHash: "s2" });
  });

  it("adds a zero-observation entry only for paths the window misses and the history has", () => {
    const windowed = new Map([["other.ts", { commits: [], linesAdded: 4, linesDeleted: 1 }]]);

    const filled = addDormantFileChurn(windowed, ["new.ts", "other.ts", "never.ts"], foldFileLifetimeStamps(LOG));

    expect([...filled.keys()].sort()).toEqual(["new.ts", "other.ts"]);
    expect(filled.get("other.ts")).toEqual({ commits: [], linesAdded: 4, linesDeleted: 1 });
    expect(filled.get("new.ts")).toEqual({
      commits: [],
      linesAdded: 0,
      linesDeleted: 0,
      lifetime: { lastModifiedAt: 350, firstCreatedAt: 100, lastCommitHash: "s3" },
    });
  });
});

describe("readFileLifetimeStampsCached (bd tea-rags-mcp-61gt2)", () => {
  let baseDir: string;
  const root = "/repos/alpha";

  beforeEach(() => {
    baseDir = mkdtempSync(join(tmpdir(), "file-lifetime-cache-"));
  });
  afterEach(() => {
    rmSync(baseDir, { recursive: true, force: true });
  });

  /** Adapter whose reads are keyed "HEAD" / "<from>..<to>"; a missing key rejects
   *  the way git rejects an unknown revision in a range. */
  function fakeAdapter(
    head: string,
    reads: Record<string, CommitPathChanges[]>,
  ): {
    adapter: VcsGitAdapter;
    calls: string[];
  } {
    const calls: string[] = [];
    const adapter = {
      getHead: async (): Promise<string> => head,
      readCommitPathChanges: async (
        _timeoutMs?: number,
        range?: { fromSha: string; toSha: string },
      ): Promise<CommitPathChanges[]> => {
        const key = range ? `${range.fromSha}..${range.toSha}` : "HEAD";
        calls.push(key);
        const rows = reads[key];
        if (rows === undefined) throw new Error(`unknown revision: ${key}`);
        return rows;
      },
    } as unknown as VcsGitAdapter;
    return { adapter, calls };
  }

  it("cold: walks HEAD, folds, persists with the head tip", async () => {
    const { adapter, calls } = fakeAdapter("t1", { HEAD: LOG });
    const store = new GitFileLifetimeStore(baseDir);
    const modes: string[] = [];

    const stamps = await readFileLifetimeStampsCached(adapter, root, 1000, store, (info) => modes.push(info.mode));

    expect(calls).toEqual(["HEAD"]);
    expect(modes).toEqual(["cold"]);
    expect(stamps.get("new.ts")).toEqual({ lastModifiedAt: 350, firstCreatedAt: 100, lastCommitHash: "s3" });
    expect(store.load(root)?.tip).toBe("t1");
  });

  it("cached: same HEAD reads no git and returns the persisted stamps", async () => {
    const { adapter, calls } = fakeAdapter("t1", {});
    const store = new GitFileLifetimeStore(baseDir);
    store.save(root, "t1", foldFileLifetimeStamps(LOG));
    const modes: string[] = [];

    const stamps = await readFileLifetimeStampsCached(adapter, root, 1000, store, (info) => modes.push(info.mode));

    expect(calls).toEqual([]);
    expect(modes).toEqual(["cached"]);
    expect(stamps.get("new.ts")?.firstCreatedAt).toBe(100);
  });

  it("incremental: tops the cached stamps up with tip..HEAD and persists the new tip", async () => {
    // tip t1 already folded s1..s5; commits t1..t2 add a newer touch of other.ts.
    const range: CommitPathChanges[] = [{ sha: "s6", timestamp: 600, changedFiles: [{ path: "other.ts" }] }];
    const { adapter, calls } = fakeAdapter("t2", { "t1..t2": range });
    const store = new GitFileLifetimeStore(baseDir);
    store.save(root, "t1", foldFileLifetimeStamps(LOG));
    const modes: string[] = [];

    const stamps = await readFileLifetimeStampsCached(adapter, root, 1000, store, (info) => modes.push(info.mode));

    expect(calls).toEqual(["t1..t2"]);
    expect(modes).toEqual(["incremental"]);
    // lastModifiedAt moved to the new commit; firstCreatedAt kept the fold's.
    expect(stamps.get("other.ts")).toEqual({ lastModifiedAt: 600, firstCreatedAt: 200, lastCommitHash: "s6" });
    expect(stamps.get("new.ts")).toEqual({ lastModifiedAt: 350, firstCreatedAt: 100, lastCommitHash: "s3" });
    expect(store.load(root)?.tip).toBe("t2");
  });

  it("unknown tip (rewritten history) rejects the range and falls back to the cold walk", async () => {
    const { adapter, calls } = fakeAdapter("t2", { HEAD: LOG });
    const store = new GitFileLifetimeStore(baseDir);
    store.save(root, "gone-tip", foldFileLifetimeStamps(LOG));
    const modes: string[] = [];

    const stamps = await readFileLifetimeStampsCached(adapter, root, 1000, store, (info) => modes.push(info.mode));

    expect(calls).toEqual(["gone-tip..t2", "HEAD"]);
    expect(modes).toEqual(["cold"]);
    expect(stamps.size).toBe(3);
    expect(store.load(root)?.tip).toBe("t2");
  });

  it("foldIntoFileLifetimeStamps equals one fold of both ranges concatenated (no cross-call renames)", async () => {
    const base: CommitPathChanges[] = [
      { sha: "s1", timestamp: 100, changedFiles: [{ path: "a.ts" }] },
      { sha: "s2", timestamp: 200, changedFiles: [{ path: "a.ts" }, { path: "b.ts" }] },
    ];
    const fresh: CommitPathChanges[] = [{ sha: "s3", timestamp: 300, changedFiles: [{ path: "b.ts" }] }];

    const folded = foldIntoFileLifetimeStamps(foldFileLifetimeStamps(base), fresh);

    expect(folded.get("a.ts")).toEqual({ lastModifiedAt: 200, firstCreatedAt: 100, lastCommitHash: "s2" });
    expect(folded.get("b.ts")).toEqual({ lastModifiedAt: 300, firstCreatedAt: 200, lastCommitHash: "s3" });
  });
});

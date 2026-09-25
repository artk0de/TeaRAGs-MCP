/**
 * bd tea-rags-mcp-z8w16 — the chunk walk FOLLOWS renames.
 *
 * `relativeChunkMap` is keyed on HEAD paths, so a commit that touched a file
 * before it was renamed names it by a path the map does not know. 0dwsn made
 * the rename commit itself reach attribution; this suite pins the commits
 * BEFORE it. The walk keeps a reverse-chronological alias map (path as named at
 * that point of history → HEAD path), updated at every rename row it passes:
 *
 * - a simple rename credits pre-rename commits to the HEAD file;
 * - chains compose (A→B→C credits A-era and B-era commits to C);
 * - an old path RE-CREATED after the rename is a different file: commits after
 *   the re-creation stay with the re-created file, commits before the rename
 *   stay with the renamed HEAD file;
 * - the walk asks discovery for the old paths, since a slice keyed on HEAD paths
 *   never contains a commit that only touched the old one.
 */

import { afterEach, describe, expect, it, vi } from "vitest";

import { GitCliAdapter } from "../../../../../../src/core/adapters/vcs/git/git-cli/adapter.js";
import type { CommitChangedPath, CommitWithChangedFiles } from "../../../../../../src/core/adapters/vcs/types.js";
import { buildChunkChurnMapUncached } from "../../../../../../src/core/domains/trajectory/git/infra/chunk-reader.js";
import type { WalkCommitDiscovery } from "../../../../../../src/core/domains/trajectory/git/infra/walk-commits.js";

vi.mock("../../../../../../src/core/adapters/vcs/git/git-cli/client.js", async (importOriginal) => importOriginal());

/** 60-line file; version `v` rewrites lines 31-33, so every commit lands on c4. */
const content = (v: number): string =>
  `${Array.from({ length: 60 }, (_, i) => (i >= 30 && i <= 32 ? `v${v} line ${i + 1}` : `line ${i + 1}`)).join("\n")}\n`;

const sha = (c: string): string => c.repeat(40);

interface LogCommit {
  sha: string;
  parent: string;
  rows: CommitChangedPath[];
}

/**
 * A fake repo: a log (newest → oldest, as git emits it) plus the blob content
 * each (revision, path) holds. Every path not listed is absent ("").
 */
function fakeRepo(log: LogCommit[], blobs: Record<string, string>) {
  const now = Math.floor(Date.now() / 1000);
  const entries: CommitWithChangedFiles[] = log.map((c, i) => ({
    commit: {
      sha: c.sha,
      author: "Alice",
      authorEmail: "alice@ex.com",
      timestamp: now - i * 3600,
      body: "chore: change",
      parents: [c.parent],
    },
    changedFiles: c.rows,
  }));
  // Behaves like GitCommitDiscovery#commitsForFiles: full rows of every commit
  // whose CURRENT path is asked for, in log order.
  const discovery: WalkCommitDiscovery & { commitsForFiles: ReturnType<typeof vi.fn> } = {
    commitsForFiles: vi.fn(async (paths: string[]) =>
      entries.filter((e) => e.changedFiles.some((r) => paths.includes(r.path))),
    ),
    getBugFixShas: vi.fn().mockResolvedValue(new Set<string>()),
  };
  const blobReader = {
    read: vi.fn(async (oid: string, path: string) => blobs[`${oid}:${path}`] ?? ""),
    close: vi.fn().mockResolvedValue(undefined),
  };
  return { discovery, blobReader };
}

const sixChunks = (prefix: string) =>
  Array.from({ length: 6 }, (_, i) => ({ chunkId: `${prefix}${i + 1}`, startLine: i * 10 + 1, endLine: i * 10 + 10 }));

async function walk(
  chunkMap: Map<string, { chunkId: string; startLine: number; endLine: number }[]>,
  repo: ReturnType<typeof fakeRepo>,
): Promise<Map<string, Map<string, { commitCount: number }>>> {
  return await buildChunkChurnMapUncached(
    new GitCliAdapter("/fake/repo"),
    chunkMap,
    {},
    10,
    6,
    undefined,
    undefined,
    120000,
    10000,
    undefined,
    undefined,
    repo.blobReader,
    undefined,
    repo.discovery,
  );
}

describe("walkCommits rename following (bd tea-rags-mcp-z8w16)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("credits a commit made before a rename to the file's HEAD path", async () => {
    // newest → oldest: R renames old.ts → new.ts; M edited old.ts before that.
    const R = sha("r");
    const M = sha("m");
    const P = sha("p");
    const repo = fakeRepo(
      [
        { sha: R, parent: M, rows: [{ path: "new.ts", previousPath: "old.ts" }] },
        { sha: M, parent: P, rows: [{ path: "old.ts" }] },
      ],
      {
        [`${P}:old.ts`]: content(0),
        [`${M}:old.ts`]: content(1),
        [`${R}:new.ts`]: content(2),
      },
    );

    const overlays = await walk(new Map([["new.ts", sixChunks("n")]]), repo);

    expect(overlays.get("new.ts")?.get("n4")?.commitCount).toBe(2);
    // The pre-rename commit is diffed where it lived: both sides at old.ts.
    expect(repo.blobReader.read).toHaveBeenCalledWith(P, "old.ts");
    expect(repo.blobReader.read).toHaveBeenCalledWith(M, "old.ts");
    // A HEAD-keyed slice cannot contain M — the walk must ask for old.ts.
    expect(repo.discovery.commitsForFiles).toHaveBeenCalledWith(expect.arrayContaining(["new.ts", "old.ts"]));
  });

  it("composes a chain of renames: A → B → C credits every era to C", async () => {
    // newest → oldest: R2 renames b → c, MB edits b, R1 renames a → b, MA edits a.
    const R2 = sha("2");
    const MB = sha("b");
    const R1 = sha("1");
    const MA = sha("a");
    const P = sha("p");
    const repo = fakeRepo(
      [
        { sha: R2, parent: MB, rows: [{ path: "c.ts", previousPath: "b.ts" }] },
        { sha: MB, parent: R1, rows: [{ path: "b.ts" }] },
        { sha: R1, parent: MA, rows: [{ path: "b.ts", previousPath: "a.ts" }] },
        { sha: MA, parent: P, rows: [{ path: "a.ts" }] },
      ],
      {
        [`${P}:a.ts`]: content(0),
        [`${MA}:a.ts`]: content(1),
        [`${R1}:b.ts`]: content(2),
        [`${MB}:b.ts`]: content(3),
        [`${R2}:c.ts`]: content(4),
      },
    );

    const overlays = await walk(new Map([["c.ts", sixChunks("c")]]), repo);

    expect(overlays.get("c.ts")?.get("c4")?.commitCount).toBe(4);
  });

  it("keeps a RE-CREATED old path apart from the renamed HEAD file", async () => {
    // newest → oldest: X edits a.ts re-created after R; R renamed a.ts → b.ts;
    // M edited the ORIGINAL a.ts. HEAD holds both a.ts (re-created) and b.ts.
    const X = sha("x");
    const C = sha("c");
    const R = sha("r");
    const M = sha("m");
    const P = sha("p");
    const repo = fakeRepo(
      [
        { sha: X, parent: C, rows: [{ path: "a.ts" }] },
        { sha: C, parent: R, rows: [{ path: "a.ts" }] },
        { sha: R, parent: M, rows: [{ path: "b.ts", previousPath: "a.ts" }] },
        { sha: M, parent: P, rows: [{ path: "a.ts" }] },
      ],
      {
        [`${P}:a.ts`]: content(0),
        [`${M}:a.ts`]: content(1),
        [`${R}:b.ts`]: content(2),
        [`${C}:a.ts`]: content(10),
        [`${X}:a.ts`]: content(11),
      },
    );

    const overlays = await walk(
      new Map([
        ["a.ts", sixChunks("a")],
        ["b.ts", sixChunks("b")],
      ]),
      repo,
    );

    // b.ts owns the rename and the pre-rename edit M.
    expect(overlays.get("b.ts")?.get("b4")?.commitCount).toBe(2);
    // a.ts owns only its own history: the re-creating commit C and the edit X.
    expect(overlays.get("a.ts")?.get("a4")?.commitCount).toBe(2);
  });

  it("keeps the re-created old path apart even when the walk batch holds only the renamed file", async () => {
    // Same history as above, but this batch only carries b.ts.
    const X = sha("x");
    const C = sha("c");
    const R = sha("r");
    const M = sha("m");
    const P = sha("p");
    const repo = fakeRepo(
      [
        { sha: X, parent: C, rows: [{ path: "a.ts" }] },
        { sha: C, parent: R, rows: [{ path: "a.ts" }] },
        { sha: R, parent: M, rows: [{ path: "b.ts", previousPath: "a.ts" }] },
        { sha: M, parent: P, rows: [{ path: "a.ts" }] },
      ],
      {
        [`${P}:a.ts`]: content(0),
        [`${M}:a.ts`]: content(1),
        [`${R}:b.ts`]: content(2),
        [`${C}:a.ts`]: content(10),
        [`${X}:a.ts`]: content(11),
      },
    );

    const overlays = await walk(new Map([["b.ts", sixChunks("b")]]), repo);

    expect(overlays.get("b.ts")?.get("b4")?.commitCount).toBe(2);
    expect(overlays.has("a.ts")).toBe(false);
  });

  it("does not credit a DIFFERENT file that held the new name before the rename", async () => {
    // newest → oldest: R renames a.ts → b.ts; D deleted an unrelated b.ts; E
    // edited that unrelated b.ts. Before R, the name b.ts was not this file.
    const R = sha("r");
    const D = sha("d");
    const E = sha("e");
    const P = sha("p");
    const repo = fakeRepo(
      [
        { sha: R, parent: D, rows: [{ path: "b.ts", previousPath: "a.ts" }] },
        { sha: D, parent: E, rows: [{ path: "b.ts" }] },
        { sha: E, parent: P, rows: [{ path: "b.ts" }] },
      ],
      {
        [`${D}:a.ts`]: content(0),
        [`${R}:b.ts`]: content(1),
        [`${P}:b.ts`]: content(20),
        [`${E}:b.ts`]: content(21),
      },
    );

    const overlays = await walk(new Map([["b.ts", sixChunks("b")]]), repo);

    expect(overlays.get("b.ts")?.get("b4")?.commitCount).toBe(1);
    // The unrelated file's commits never reach a blob read — they are not
    // attributed to HEAD b.ts at all, rather than landing and missing on the
    // offset geometry the deletion left behind.
    expect(repo.blobReader.read).not.toHaveBeenCalledWith(D, "b.ts");
    expect(repo.blobReader.read).not.toHaveBeenCalledWith(E, "b.ts");
  });

  it("stops asking discovery once no new predecessor path appears", async () => {
    const repo = fakeRepo([{ sha: sha("m"), parent: sha("p"), rows: [{ path: "x.ts" }] }], {
      [`${sha("p")}:x.ts`]: content(0),
      [`${sha("m")}:x.ts`]: content(1),
    });

    await walk(new Map([["x.ts", sixChunks("x")]]), repo);

    expect(repo.discovery.commitsForFiles).toHaveBeenCalledTimes(1);
  });
});

/**
 * The query clock of an index (bd tea-rags-mcp-zwu7m): a head-stamped index
 * reads at its INDEXED commit's committer time, read once per
 * (collection, indexedCommit); every other index reads the wall clock
 * (`undefined`). Real repository — one fast-import.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { importGitHistory } from "../../../__helpers__/git-history-import.js";
import { IndexHistoryAnchorResolver } from "../../../../../src/core/api/internal/infra/index-history-anchor.js";
import type { CollectionEntry } from "../../../../../src/core/contracts/types/registry.js";

const DAY = 86_400;
const ALICE = { name: "Alice", email: "alice@example.com" };
/** The indexed commit: ~2850 days before now. */
const INDEXED_SEC = Math.floor(Date.now() / 1000) - 2850 * DAY;
/** A later commit — HEAD of the checkout, NOT the indexed commit. */
const LATER_SEC = INDEXED_SEC + 400 * DAY;

let repo: string;
let shas: Record<string, string>;

beforeAll(() => {
  repo = mkdtempSync(join(tmpdir(), "index-history-anchor-"));
  shas = importGitHistory(repo, [
    { label: "indexed", message: "indexed", author: ALICE, authorDate: INDEXED_SEC * 1000, writes: { "a.ts": "a" } },
    { label: "later", message: "later", author: ALICE, authorDate: LATER_SEC * 1000, writes: { "a.ts": "b" } },
  ]);
});

afterAll(() => {
  rmSync(repo, { recursive: true, force: true });
});

function entry(env: Record<string, string> | undefined, indexedCommit?: string): CollectionEntry {
  return {
    collectionName: "col",
    path: repo,
    name: null,
    embeddingModel: "m",
    embeddingDimensions: 3,
    qdrantUrl: "http://localhost",
    ...(env ? { env } : {}),
    ...(indexedCommit ? { git: { indexedBranch: "main", indexedCommit, indexedDirty: false } } : {}),
  } as CollectionEntry;
}

function resolverFor(
  e: CollectionEntry | null,
  readCommitTime?: (repoPath: string, commit: string) => Promise<number>,
) {
  return new IndexHistoryAnchorResolver({
    collectionRegistry: { get: () => e },
    ...(readCommitTime ? { readCommitTime } : {}),
  });
}

describe("IndexHistoryAnchorResolver", () => {
  it("head-stamped index → the indexed commit's committer time, not HEAD's", async () => {
    const resolver = resolverFor(entry({ TRAJECTORY_GIT_ANCHOR: "head" }, shas.indexed));
    expect(await resolver.anchorSecOf("col")).toBe(INDEXED_SEC);
  });

  it("now-stamped and unstamped indexes read the wall clock", async () => {
    expect(await resolverFor(entry({ TRAJECTORY_GIT_ANCHOR: "now" }, shas.indexed)).anchorSecOf("col")).toBeUndefined();
    expect(await resolverFor(entry({}, shas.indexed)).anchorSecOf("col")).toBeUndefined();
    expect(await resolverFor(entry(undefined, shas.indexed)).anchorSecOf("col")).toBeUndefined();
    expect(await resolverFor(null).anchorSecOf("col")).toBeUndefined();
  });

  it("an indexed commit the repository does not hold → wall clock, never a failure", async () => {
    const gone = "0123456789abcdef0123456789abcdef01234567";
    expect(await resolverFor(entry({ TRAJECTORY_GIT_ANCHOR: "head" }, gone)).anchorSecOf("col")).toBeUndefined();
  });

  it("reads the commit time once per (collection, indexedCommit)", async () => {
    let current = entry({ TRAJECTORY_GIT_ANCHOR: "head" }, shas.indexed);
    const read = vi.fn(async (_repo: string, commit: string) => (commit === shas.indexed ? INDEXED_SEC : LATER_SEC));
    const resolver = new IndexHistoryAnchorResolver({
      collectionRegistry: { get: () => current },
      readCommitTime: read,
    });
    await resolver.anchorSecOf("col");
    await resolver.anchorSecOf("col");
    expect(read).toHaveBeenCalledTimes(1);
    // A reindex moves the indexed commit — a new key, one new read.
    current = entry({ TRAJECTORY_GIT_ANCHOR: "head" }, shas.later);
    expect(await resolver.anchorSecOf("col")).toBe(LATER_SEC);
    expect(read).toHaveBeenCalledTimes(2);
  });
});

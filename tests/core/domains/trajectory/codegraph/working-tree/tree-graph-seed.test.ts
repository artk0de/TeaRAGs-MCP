/**
 * `treeDeltaAgainstSeed` — the delta a tree build applies to a previously
 * published graph of the same tree (the SEED, tree state S1) to reach the
 * current tree state S2. Each case is one edit class between S1 and S2; every
 * path's content is a hash, existence on disk is a set.
 */
import { describe, expect, it } from "vitest";

import {
  treeDeltaAgainstSeed,
  type WorkingTreeDeltaRecord,
} from "../../../../../../src/core/domains/trajectory/codegraph/working-tree/tree-graph-seed.js";

function delta(changed: Record<string, string>, deleted: string[] = []): WorkingTreeDeltaRecord {
  return { changed, deleted };
}

async function against(
  seed: WorkingTreeDeltaRecord,
  current: WorkingTreeDeltaRecord,
  onDisk: string[],
): Promise<{ changedRelPaths: string[]; deletedRelPaths: string[] }> {
  const present = new Set(onDisk);
  return treeDeltaAgainstSeed(seed, current, async (relPath) => present.has(relPath));
}

describe("treeDeltaAgainstSeed", () => {
  it("a path whose content is the one the seed walked is not re-walked", async () => {
    expect(await against(delta({ "a.ts": "h1" }), delta({ "a.ts": "h1" }), ["a.ts"])).toEqual({
      changedRelPaths: [],
      deletedRelPaths: [],
    });
  });

  it("modify: a seed-changed path with new content is walked", async () => {
    expect(await against(delta({ "a.ts": "h1" }), delta({ "a.ts": "h2" }), ["a.ts"])).toEqual({
      changedRelPaths: ["a.ts"],
      deletedRelPaths: [],
    });
  });

  it("modify: a path the seed held at base content and the tree now changes is walked", async () => {
    expect(await against(delta({}), delta({ "b.ts": "h1" }), ["b.ts"])).toEqual({
      changedRelPaths: ["b.ts"],
      deletedRelPaths: [],
    });
  });

  it("revert: a seed-changed path no longer in the delta is back at base content and is walked", async () => {
    expect(await against(delta({ "a.ts": "h1" }), delta({}), ["a.ts"])).toEqual({
      changedRelPaths: ["a.ts"],
      deletedRelPaths: [],
    });
  });

  it("delete: a path the tree now deletes is deleted", async () => {
    expect(await against(delta({}), delta({}, ["b.ts"]), [])).toEqual({
      changedRelPaths: [],
      deletedRelPaths: ["b.ts"],
    });
  });

  it("delete: a seed-changed path the tree now deletes is deleted, not walked", async () => {
    expect(await against(delta({ "a.ts": "h1" }), delta({}, ["a.ts"]), [])).toEqual({
      changedRelPaths: [],
      deletedRelPaths: ["a.ts"],
    });
  });

  it("a path deleted in both is left alone", async () => {
    expect(await against(delta({}, ["d.ts"]), delta({}, ["d.ts"]), [])).toEqual({
      changedRelPaths: [],
      deletedRelPaths: [],
    });
  });

  it("re-add at base content: a seed-deleted path out of the delta is walked", async () => {
    expect(await against(delta({}, ["d.ts"]), delta({}), ["d.ts"])).toEqual({
      changedRelPaths: ["d.ts"],
      deletedRelPaths: [],
    });
  });

  it("re-add with new content: a seed-deleted path now changed is walked", async () => {
    expect(await against(delta({}, ["d.ts"]), delta({ "d.ts": "h9" }), ["d.ts"])).toEqual({
      changedRelPaths: ["d.ts"],
      deletedRelPaths: [],
    });
  });

  it("add: a brand-new path is walked", async () => {
    expect(await against(delta({ "a.ts": "h1" }), delta({ "a.ts": "h1", "n.ts": "h5" }), ["a.ts", "n.ts"])).toEqual({
      changedRelPaths: ["n.ts"],
      deletedRelPaths: [],
    });
  });

  it("delete a newly added path: a seed-added path gone from disk and from the delta is deleted", async () => {
    expect(await against(delta({ "n.ts": "h5" }), delta({}), [])).toEqual({
      changedRelPaths: [],
      deletedRelPaths: ["n.ts"],
    });
  });

  it("rename: the old path is deleted and the new one walked", async () => {
    expect(await against(delta({}), delta({ "r-new.ts": "h3" }, ["r-old.ts"]), ["r-new.ts"])).toEqual({
      changedRelPaths: ["r-new.ts"],
      deletedRelPaths: ["r-old.ts"],
    });
  });

  it("rename back: the seed's rename undone walks the old path and deletes the added one", async () => {
    expect(await against(delta({ "r-new.ts": "h3" }, ["r-old.ts"]), delta({}), ["r-old.ts"])).toEqual({
      changedRelPaths: ["r-old.ts"],
      deletedRelPaths: ["r-new.ts"],
    });
  });

  it("returns both lists sorted", async () => {
    expect(
      await against(delta({}), delta({ "z.ts": "1", "b.ts": "2", "m.ts": "3" }, ["y.ts", "c.ts"]), [
        "z.ts",
        "b.ts",
        "m.ts",
      ]),
    ).toEqual({ changedRelPaths: ["b.ts", "m.ts", "z.ts"], deletedRelPaths: ["c.ts", "y.ts"] });
  });
});

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CollectionRegistry } from "../../../../src/core/infra/registry/collection-registry.js";

function baseEntry(collectionName: string, path: string) {
  return {
    collectionName, path,
    embeddingModel: "jina", embeddingDimensions: 768,
    qdrantUrl: "http://127.0.0.1:6333",
    indexedAt: "2026-06-24T00:00:00Z", teaRagsVersion: "1.31.1", chunksCount: 10,
  };
}

describe("CollectionRegistry worktree provenance", () => {
  let dir: string;
  let reg: CollectionRegistry;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "reg-")); reg = new CollectionRegistry(dir); });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("lists only entries carrying worktree provenance", () => {
    reg.record(baseEntry("code_main", "/repo"));
    reg.record(baseEntry("code_wt", "/repo/.wt/x"));
    reg.setWorktreeProvenance("code_wt", "code_main", "x");

    const wts = reg.listWorktrees();
    expect(wts.map((e) => e.collectionName)).toEqual(["code_wt"]);
    expect(wts[0].worktreeOf).toBe("code_main");
    expect(wts[0].worktreeName).toBe("x");
  });

  it("setWorktreeProvenance throws on unknown collection", () => {
    expect(() => reg.setWorktreeProvenance("ghost", "code_main", "x"))
      .toThrow(/ghost not registered/);
  });

  it("findWorktree resolves by worktree name, ignoring non-worktree entries", () => {
    reg.record(baseEntry("code_main", "/repo"));
    reg.record(baseEntry("code_wt", "/repo/.wt/x"));
    reg.setWorktreeProvenance("code_wt", "code_main", "x");
    expect(reg.findWorktree("x")?.collectionName).toBe("code_wt");
    expect(reg.findWorktree("missing")).toBeNull();
  });
});

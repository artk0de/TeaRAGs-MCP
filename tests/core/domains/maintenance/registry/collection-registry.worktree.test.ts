import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { CollectionRegistry } from "../../../../../src/core/domains/maintenance/registry/collection-registry.js";

function baseEntry(collectionName: string, path: string) {
  return {
    collectionName,
    path,
    embeddingModel: "jina",
    embeddingDimensions: 768,
    qdrantUrl: "http://127.0.0.1:6333",
    indexedAt: "2026-06-24T00:00:00Z",
    teaRagsVersion: "1.31.1",
    chunksCount: 10,
  };
}

describe("CollectionRegistry worktree provenance", () => {
  let dir: string;
  let reg: CollectionRegistry;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "reg-"));
    reg = new CollectionRegistry(dir);
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

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
    expect(() => {
      reg.setWorktreeProvenance("ghost", "code_main", "x");
    }).toThrow(/ghost not registered/);
  });

  it("findWorktree resolves by worktree name, ignoring non-worktree entries", () => {
    reg.record(baseEntry("code_main", "/repo"));
    reg.record(baseEntry("code_wt", "/repo/.wt/x"));
    reg.setWorktreeProvenance("code_wt", "code_main", "x");
    expect(reg.findWorktree("x")?.collectionName).toBe("code_wt");
    expect(reg.findWorktree("missing")).toBeNull();
  });

  // The prescribed lifecycle is `worktree create` → `index-codebase --project
  // <clone>`, and every index run re-records the entry without provenance. A
  // wiped `worktreeOf` hides the clone from `worktree list` (so the teardown
  // backstop never sees it) and makes `worktree remove` refuse it
  // (bd tea-rags-mcp-ghk1f).
  it("keeps worktree provenance across a pipeline re-record of the clone", () => {
    reg.record(baseEntry("code_main", "/repo"));
    reg.record(baseEntry("code_wt", "/repo/.wt/x"));
    reg.setWorktreeProvenance("code_wt", "code_main", "x");

    reg.record({ ...baseEntry("code_wt", "/repo/.wt/x"), chunksCount: 42 });

    expect(reg.findWorktree("x")?.collectionName).toBe("code_wt");
    expect(reg.listWorktrees().map((e) => [e.collectionName, e.worktreeOf, e.chunksCount])).toEqual([
      ["code_wt", "code_main", 42],
    ]);
  });

  it("never grants provenance to an ordinary project on re-record", () => {
    reg.record(baseEntry("code_main", "/repo"));
    reg.record(baseEntry("code_main", "/repo"));
    expect(reg.listWorktrees()).toEqual([]);
  });

  it("survives a fresh process reading the re-recorded registry", () => {
    reg.record(baseEntry("code_wt", "/repo/.wt/x"));
    reg.setWorktreeProvenance("code_wt", "code_main", "x");
    const pipelineProcess = new CollectionRegistry(dir);
    pipelineProcess.record(baseEntry("code_wt", "/repo/.wt/x"));

    expect(new CollectionRegistry(dir).findWorktree("x")?.worktreeOf).toBe("code_main");
  });
});

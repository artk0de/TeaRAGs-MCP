import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { runWorktreeInfo, runWorktreeList } from "../../../src/cli/commands/worktree.js";
import { CollectionRegistry } from "../../../src/core/infra/registry/collection-registry.js";

describe("worktree list CLI", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "wt-"));
  });

  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("prints JSON of worktree entries only", () => {
    const reg = new CollectionRegistry(dir);
    reg.record({
      collectionName: "code_wt",
      path: "/w",
      embeddingModel: "j",
      embeddingDimensions: 768,
      qdrantUrl: "http://h",
      indexedAt: "t",
      teaRagsVersion: "1",
      chunksCount: 3,
    });
    reg.setWorktreeProvenance("code_wt", "code_src", "x");

    const write = vi.spyOn(process.stdout, "write").mockReturnValue(true);
    runWorktreeList({ json: true, dataDir: dir });
    expect(write.mock.calls.join("")).toContain("code_wt");
    write.mockRestore();
  });

  it("prints 'No worktree indexes.' when registry has no worktrees", () => {
    const write = vi.spyOn(process.stdout, "write").mockReturnValue(true);
    runWorktreeList({ json: false, dataDir: dir });
    expect(write.mock.calls.join("")).toContain("No worktree indexes.");
    write.mockRestore();
  });
});

describe("worktree info CLI", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "wt-info-"));
  });

  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("returns isWorktree: true for a registered worktree path", () => {
    const reg = new CollectionRegistry(dir);
    const cwd = process.cwd();
    reg.record({
      collectionName: "code_wt2",
      path: cwd,
      embeddingModel: "j",
      embeddingDimensions: 768,
      qdrantUrl: "http://h",
      indexedAt: "t",
      teaRagsVersion: "1",
      chunksCount: 5,
    });
    reg.setWorktreeProvenance("code_wt2", "code_base", "myfeature");

    const write = vi.spyOn(process.stdout, "write").mockReturnValue(true);
    runWorktreeInfo({ json: true, dataDir: dir });
    const output = write.mock.calls.join("");
    expect(output).toContain('"isWorktree": true');
    expect(output).toContain("code_wt2");
    write.mockRestore();
  });

  it("returns isWorktree: false when cwd is not a worktree", () => {
    const write = vi.spyOn(process.stdout, "write").mockReturnValue(true);
    runWorktreeInfo({ json: true, dataDir: dir });
    const output = write.mock.calls.join("");
    expect(output).toContain('"isWorktree": false');
    write.mockRestore();
  });
});

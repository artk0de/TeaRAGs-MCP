/**
 * `resolveWorkingTree` — the working directory alone addresses both the tree a
 * caller stands in and the same-repository index it is read against (bd
 * tea-rags-mcp-xi2r9.1). One MCP server serves every subagent, and only the
 * agent knows its tree. Real git: a main checkout plus linked worktrees.
 */
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createGitWorkingTreeFixture, type GitWorkingTreeFixture } from "../../__helpers__/git-working-tree-fixture.js";
import { InvalidParameterError } from "../../../../src/core/api/errors.js";
import { resolveCollection, resolveWorkingTree } from "../../../../src/core/api/internal/collection-resolver.js";
import { CollectionRegistry } from "../../../../src/core/domains/maintenance/registry/index.js";

describe("resolveWorkingTree", { timeout: 60_000 }, () => {
  let fixture: GitWorkingTreeFixture;
  let registryDir: string;
  let registry: CollectionRegistry;

  beforeEach(() => {
    fixture = createGitWorkingTreeFixture();
    registryDir = mkdtempSync(join(tmpdir(), "rwt-registry-"));
    registry = new CollectionRegistry(registryDir);
  });

  afterEach(() => {
    fixture.cleanup();
    rmSync(registryDir, { recursive: true, force: true });
  });

  function register(collectionName: string, path: string, name: string): void {
    registry.record({
      collectionName,
      path,
      embeddingModel: "m",
      embeddingDimensions: 1,
      qdrantUrl: "u",
      indexedAt: "t",
      teaRagsVersion: "v",
      chunksCount: 0,
    });
    registry.setName(collectionName, name);
  }

  it("a linked worktree reads against its main checkout's index", () => {
    register("code_main", fixture.mainRoot, "main");
    const tree = fixture.addWorktree("a");

    expect(resolveWorkingTree(registry, { path: tree })).toEqual({
      root: tree,
      baseIndex: { collectionName: "code_main", root: fixture.mainRoot },
    });
  });

  it("a subdirectory addresses the worktree's toplevel", () => {
    register("code_main", fixture.mainRoot, "main");
    const tree = fixture.addWorktree("a");

    const out = resolveWorkingTree(registry, { path: join(tree, "src") });
    expect(out.root).toBe(tree);
    expect(out.baseIndex.collectionName).toBe("code_main");
  });

  it("a registered worktree reads against its own entry, not main's", () => {
    register("code_main", fixture.mainRoot, "main");
    const tree = fixture.addWorktree("a");
    register("code_wt", tree, "wt");

    expect(resolveWorkingTree(registry, { path: tree }).baseIndex).toEqual({ collectionName: "code_wt", root: tree });
  });

  it("refuses to guess between several non-main entries of the tree's repository", () => {
    register("code_a", fixture.addWorktree("a"), "alpha");
    register("code_b", fixture.addWorktree("b"), "beta");
    const tree = fixture.addWorktree("c");

    expect(() => resolveWorkingTree(registry, { path: tree })).toThrow(InvalidParameterError);
    expect(() => resolveWorkingTree(registry, { path: tree })).toThrow(/alpha.*beta/);
  });

  it("prefers the main checkout's entry among several of the tree's repository", () => {
    register("code_main", fixture.mainRoot, "main");
    register("code_a", fixture.addWorktree("a"), "alpha");
    const tree = fixture.addWorktree("b");

    expect(resolveWorkingTree(registry, { path: tree }).baseIndex).toEqual({
      collectionName: "code_main",
      root: fixture.mainRoot,
    });
  });

  it("an unrelated, unregistered repository keeps the path-hash fallback", () => {
    register("code_main", fixture.mainRoot, "main");
    const other = realpathSync(mkdtempSync(join(tmpdir(), "rwt-other-")));
    try {
      fixture.git(fixture.mainRoot, "init", "-q", other);
      const out = resolveWorkingTree(registry, { path: other });
      expect(out.root).toBe(other);
      expect(out.baseIndex.collectionName).toBe(resolveCollection(registry, { path: other }).collectionName);
    } finally {
      rmSync(other, { recursive: true, force: true });
    }
  });

  it("refuses a project whose path is a checkout of another repository", () => {
    register("code_main", fixture.mainRoot, "main");
    const other = join(fixture.mainRoot, "..", "other");
    mkdirSync(other);
    fixture.git(other, "init", "-q", "-b", "main");

    expect(() => resolveWorkingTree(registry, { project: "main", path: other })).toThrow(InvalidParameterError);
    expect(() => resolveWorkingTree(registry, { project: "main", path: other })).toThrow(/"path"/);
  });

  it("a project alone reads its own entry's tree", () => {
    register("code_main", fixture.mainRoot, "main");

    expect(resolveWorkingTree(registry, { project: "main" })).toEqual({
      root: fixture.mainRoot,
      baseIndex: { collectionName: "code_main", root: fixture.mainRoot },
    });
  });

  it("a collection with a path reads that collection from the path's toplevel", () => {
    const tree = fixture.addWorktree("a");

    const out = resolveWorkingTree(registry, { collection: "explicit", path: join(tree, "src") });
    expect(out.baseIndex.collectionName).toBe("explicit");
    expect(out.root).toBe(tree);
  });
});

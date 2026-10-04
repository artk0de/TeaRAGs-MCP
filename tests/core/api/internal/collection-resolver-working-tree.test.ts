/**
 * `resolveWorkingTree` — the working directory alone addresses both the tree a
 * caller stands in and the same-repository index it is read against (bd
 * tea-rags-mcp-xi2r9.1). One MCP server serves every subagent, and only the
 * agent knows its tree. Real git: a main checkout plus linked worktrees.
 */
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createGitWorkingTreeFixture, type GitWorkingTreeFixture } from "../../__helpers__/git-working-tree-fixture.js";
import { InvalidParameterError, SubmoduleNotIndexedError } from "../../../../src/core/api/errors.js";
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

  describe("an index registered at a subdirectory of its repository (live P2-2)", () => {
    let sub: string;

    beforeEach(() => {
      fixture.commit(fixture.mainRoot, { "sub/a.ts": "export const a = 1;\n" });
      sub = join(fixture.mainRoot, "sub");
      register("code_sub", sub, "subproj");
    });

    it("its own subdirectory reads against it, the tree rooted at the subdirectory", () => {
      expect(resolveWorkingTree(registry, { path: sub })).toEqual({
        root: sub,
        baseIndex: { collectionName: "code_sub", root: sub },
      });
    });

    it("the repository's toplevel reads against it at the subdirectory's counterpart", () => {
      expect(resolveWorkingTree(registry, { path: fixture.mainRoot }).root).toBe(sub);
    });

    it("a linked worktree's counterpart subdirectory reads against it", () => {
      const tree = fixture.addWorktree("a");

      expect(resolveWorkingTree(registry, { path: join(tree, "sub") })).toEqual({
        root: join(tree, "sub"),
        baseIndex: { collectionName: "code_sub", root: sub },
      });
    });

    it("its project with its own path is a checkout of it", () => {
      expect(resolveWorkingTree(registry, { project: "subproj", path: sub }).root).toBe(sub);
    });

    it("its project with a linked worktree's path reads the worktree's counterpart", () => {
      const tree = fixture.addWorktree("b");

      expect(resolveWorkingTree(registry, { project: "subproj", path: tree }).root).toBe(join(tree, "sub"));
    });

    it("the deepest entry containing the path wins over the toplevel's entry", () => {
      register("code_main", fixture.mainRoot, "main");

      expect(resolveWorkingTree(registry, { path: join(sub, "a.ts") }).baseIndex.collectionName).toBe("code_sub");
      expect(resolveWorkingTree(registry, { path: fixture.mainRoot }).baseIndex.collectionName).toBe("code_main");
    });
  });

  describe("a submodule of an indexed superproject (live P2-8)", () => {
    let submodule: string;

    beforeEach(() => {
      const upstream = join(fixture.mainRoot, "..", "upstream");
      mkdirSync(upstream);
      fixture.git(upstream, "init", "-q", "-b", "main");
      fixture.commit(upstream, { "lib.ts": "export const lib = 1;\n" });
      fixture.git(fixture.mainRoot, "-c", "protocol.file.allow=always", "submodule", "add", "-q", upstream, "subm");
      fixture.git(fixture.mainRoot, "commit", "-q", "-m", "add submodule");
      submodule = join(fixture.mainRoot, "subm");
      register("code_main", fixture.mainRoot, "main");
    });

    it("a path inside it is refused as an unindexed submodule, naming the remedy", () => {
      expect(() => resolveWorkingTree(registry, { path: submodule })).toThrow(SubmoduleNotIndexedError);
      expect(() => resolveWorkingTree(registry, { path: join(submodule, "lib.ts") })).toThrow(
        /submodule 'subm'.*separate repository/,
      );
    });

    it("the superproject's project with a path inside it names the submodule", () => {
      expect(() => resolveWorkingTree(registry, { project: "main", path: submodule })).toThrow(InvalidParameterError);
      expect(() => resolveWorkingTree(registry, { project: "main", path: submodule })).toThrow(/submodule 'subm'/);
    });

    it("an indexed submodule reads against its own index", () => {
      register("code_subm", submodule, "subm");

      expect(resolveWorkingTree(registry, { path: submodule }).baseIndex.collectionName).toBe("code_subm");
    });
  });

  describe("path quirks (live P2-9)", () => {
    it("refuses a path that does not exist, naming it", () => {
      register("code_main", fixture.mainRoot, "main");
      const missing = join(fixture.mainRoot, "no-such-dir");

      expect(() => resolveWorkingTree(registry, { path: missing })).toThrow(InvalidParameterError);
      expect(() => resolveWorkingTree(registry, { path: missing })).toThrow(/no-such-dir/);
      expect(() => resolveWorkingTree(registry, { project: "main", path: missing })).toThrow(/no-such-dir/);
    });

    it("resolves a relative path against the process's working directory", () => {
      register("code_main", fixture.mainRoot, "main");
      const tree = fixture.addWorktree("rel");

      expect(resolveWorkingTree(registry, { path: relative(process.cwd(), tree) }).root).toBe(tree);
    });
  });

  it("a collection with a path reads that collection from the path's toplevel", () => {
    const tree = fixture.addWorktree("a");

    const out = resolveWorkingTree(registry, { collection: "explicit", path: join(tree, "src") });
    expect(out.baseIndex.collectionName).toBe("explicit");
    expect(out.root).toBe(tree);
  });
});

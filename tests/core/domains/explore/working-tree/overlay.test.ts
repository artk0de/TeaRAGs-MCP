import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  createGitWorkingTreeFixture,
  type GitWorkingTreeFixture,
} from "../../../__helpers__/git-working-tree-fixture.js";
import type { WorkingTree } from "../../../../../src/core/contracts/types/working-tree.js";
import {
  createWorkingTreeDeltaReader,
  WorkingTreeOverlay,
  type WorkingTreeDeltaReader,
} from "../../../../../src/core/domains/explore/working-tree/index.js";
import { FileScanner } from "../../../../../src/core/domains/ingest/pipeline/scanner.js";
import { CollectionRegistry } from "../../../../../src/core/domains/maintenance/registry/index.js";

/**
 * `WorkingTreeOverlay#view` (bd tea-rags-mcp-xi2r9.1): the marker every read
 * answer carries. The index is commit A recorded for the main checkout; the
 * tree is a linked worktree; git is real.
 */
describe("WorkingTreeOverlay", { timeout: 60_000 }, () => {
  let fixture: GitWorkingTreeFixture;
  let registryDir: string;
  let registry: CollectionRegistry;
  let indexedCommit: string;
  let tree: string;

  const COLLECTION = "code_overlay";

  const record = (git: { indexedCommit: string; indexedDirty: boolean } | undefined): void => {
    registry.record({
      collectionName: COLLECTION,
      path: fixture.mainRoot,
      embeddingModel: "m",
      embeddingDimensions: 1,
      qdrantUrl: "u",
      indexedAt: "t",
      teaRagsVersion: "v",
      chunksCount: 0,
      ...(git ? { git: { indexedBranch: "main", ...git } } : {}),
    });
    registry.setName(COLLECTION, "proj");
  };

  const createFileFilter = async (root: string): Promise<(relativePath: string) => boolean> => {
    const scanner = new FileScanner({ supportedExtensions: [".ts"], ignorePatterns: [] });
    await scanner.loadIgnorePatterns(root);
    return (relativePath) => scanner.accepts(relativePath);
  };

  const overlayWith = (deltaReader: WorkingTreeDeltaReader = createWorkingTreeDeltaReader()): WorkingTreeOverlay =>
    new WorkingTreeOverlay({ registry, deltaReader, createFileFilter });

  const workingTree = (): WorkingTree => ({
    root: tree,
    baseIndex: { collectionName: COLLECTION, root: fixture.mainRoot },
  });

  beforeEach(() => {
    fixture = createGitWorkingTreeFixture();
    indexedCommit = fixture.commit(fixture.mainRoot, { "src/keep.ts": "export const keep = 1;\n" }, "A");
    tree = fixture.addWorktree("feature");
    registryDir = mkdtempSync(join(tmpdir(), "wto-registry-"));
    registry = new CollectionRegistry(registryDir);
  });

  afterEach(() => {
    fixture.cleanup();
    rmSync(registryDir, { recursive: true, force: true });
  });

  it("should mark a clean tree at the indexed commit as measured and empty", async () => {
    record({ indexedCommit, indexedDirty: false });

    const view = await overlayWith().view(workingTree(), "proj");

    expect(view.marker).toEqual({
      tree,
      indexedCommit,
      treeCommit: indexedCommit,
      indexedDirty: false,
      changedFiles: 0,
      deletedFiles: 0,
      floors: [],
    });
    expect(view.touchedPaths.size).toBe(0);
    expect(view.deletedPaths.size).toBe(0);
  });

  it("should count changed and deleted files and expose them as touched paths", async () => {
    record({ indexedCommit, indexedDirty: true });
    writeFileSync(join(tree, "src/keep.ts"), "export const keep = 2;\n");
    writeFileSync(join(tree, "src/new.ts"), "export const fresh = 1;\n");
    fixture.git(tree, "rm", "-q", "src/index.ts");

    const view = await overlayWith().view(workingTree(), "proj");

    expect(view.marker).toMatchObject({ changedFiles: 2, deletedFiles: 1, indexedDirty: true, floors: [] });
    expect(view.marker.degraded).toBeUndefined();
    expect([...view.touchedPaths].sort()).toEqual(["src/index.ts", "src/keep.ts", "src/new.ts"]);
    expect([...view.deletedPaths]).toEqual(["src/index.ts"]);
  });

  it("should degrade with the alias filled in when the index has no commit stamp", async () => {
    record(undefined);

    const view = await overlayWith().view(workingTree(), "proj");

    expect(view.marker).toMatchObject({ tree, indexedCommit: null, changedFiles: 0, deletedFiles: 0 });
    expect(view.marker.degraded).toEqual({
      reason: "index has no indexedCommit stamp",
      remedy: "tea-rags index-codebase --project proj",
    });
    expect(view.touchedPaths.size).toBe(0);
  });

  it("should fall back to the registry alias when the caller named none", async () => {
    record(undefined);

    const view = await overlayWith().view(workingTree(), undefined);

    expect(view.marker.degraded?.remedy).toBe("tea-rags index-codebase --project proj");
  });

  it("should degrade instead of throwing when the delta reader fails", async () => {
    record({ indexedCommit, indexedDirty: false });
    const failing: WorkingTreeDeltaReader = {
      read: async () => {
        throw new Error("git status --porcelain=v2 failed (exit 129): boom");
      },
    };

    const view = await overlayWith(failing).view(workingTree(), "proj");

    expect(view.marker).toMatchObject({ tree, indexedCommit, changedFiles: 0, deletedFiles: 0, floors: [] });
    expect(view.marker.degraded?.reason).toContain("boom");
    expect(view.marker.degraded?.remedy).toContain(tree);
    expect(view.touchedPaths.size).toBe(0);
  });

  it("should degrade when the request resolved no tree at all", async () => {
    record({ indexedCommit, indexedDirty: false });

    const view = await overlayWith().view(
      { root: "", baseIndex: { collectionName: COLLECTION, root: undefined } },
      "proj",
    );

    expect(view.marker.tree).toBe("");
    expect(view.marker.degraded).toBeDefined();
  });
});

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  createGitWorkingTreeFixture,
  type GitWorkingTreeFixture,
} from "../../../__helpers__/git-working-tree-fixture.js";
import type { RegistryGitState } from "../../../../../src/core/contracts/types/registry.js";
import type { WorkingTree } from "../../../../../src/core/contracts/types/working-tree.js";
import {
  createWorkingTreeChunkLayer,
  createWorkingTreeDeltaReader,
  WorkingTreeOverlay,
  workingTreeStateOf,
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

  const record = (git: Omit<RegistryGitState, "indexedBranch"> | undefined, path = fixture.mainRoot): void => {
    registry.record({
      collectionName: COLLECTION,
      path,
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
    fixture = createGitWorkingTreeFixture([
      { commit: { "src/keep.ts": "export const keep = 1;\n" }, message: "A" },
      { addWorktree: "feature" },
    ]);
    [indexedCommit] = fixture.seeded.commits;
    tree = fixture.seeded.worktrees.feature;
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
    record({ indexedCommit, indexedDirty: true, indexedDirtyPaths: [] });
    writeFileSync(join(tree, "src/keep.ts"), "export const keep = 2;\n");
    writeFileSync(join(tree, "src/new.ts"), "export const fresh = 1;\n");
    fixture.git(tree, "rm", "-q", "src/index.ts");

    const view = await overlayWith().view(workingTree(), "proj");

    expect(view.marker).toMatchObject({ changedFiles: 2, deletedFiles: 1, indexedDirty: true, floors: [] });
    expect(view.marker.degraded).toBeUndefined();
    expect([...view.touchedPaths].sort()).toEqual(["src/index.ts", "src/keep.ts", "src/new.ts"]);
    expect([...view.deletedPaths]).toEqual(["src/index.ts"]);
  });

  describe("an index built from a dirty tree (live P1-1)", () => {
    it("should touch a file that was dirty at index time though the tree matches the indexed commit again", async () => {
      record({ indexedCommit, indexedDirty: true, indexedDirtyPaths: ["src/keep.ts"] });

      const view = await overlayWith().view(workingTree(), "proj");

      expect(view.marker).toMatchObject({ changedFiles: 1, deletedFiles: 0, indexedDirty: true });
      expect(view.marker.degraded).toBeUndefined();
      expect([...view.touchedPaths]).toEqual(["src/keep.ts"]);
      expect(view.deletedPaths.size).toBe(0);
    });

    it("should read a file that was dirty at index time and is gone from the tree as deleted", async () => {
      record({ indexedCommit, indexedDirty: true, indexedDirtyPaths: ["src/scratch.ts"] });

      const view = await overlayWith().view(workingTree(), "proj");

      expect(view.marker).toMatchObject({ changedFiles: 0, deletedFiles: 1 });
      expect([...view.deletedPaths]).toEqual(["src/scratch.ts"]);
      expect([...view.touchedPaths]).toEqual(["src/scratch.ts"]);
    });

    it("should count a file both dirty at index time and changed in the tree once", async () => {
      record({ indexedCommit, indexedDirty: true, indexedDirtyPaths: ["src/keep.ts"] });
      writeFileSync(join(tree, "src/keep.ts"), "export const keep = 9;\n");

      const view = await overlayWith().view(workingTree(), "proj");

      expect(view.marker).toMatchObject({ changedFiles: 1, deletedFiles: 0 });
      expect([...view.touchedPaths]).toEqual(["src/keep.ts"]);
    });

    it("should degrade when the index was stamped dirty before its dirty files were recorded", async () => {
      record({ indexedCommit, indexedDirty: true });

      const view = await overlayWith().view(workingTree(), "proj");

      expect(view.marker.degraded).toEqual({
        reason: "index built from a dirty tree; its dirty files are unknown",
        remedy: "tea-rags index-codebase --project proj",
      });
      expect(view.touchedPaths.size).toBe(0);
    });

    // Legacy read: an entry written while ingest capped the list carries the
    // overflow flag and no list — its dirty files stay unknown.
    it("should degrade when a legacy index entry recorded its dirty files as overflowed", async () => {
      record({ indexedCommit, indexedDirty: true, indexedDirtyPathsOverflowed: true });

      const view = await overlayWith().view(workingTree(), "proj");

      expect(view.marker.degraded?.reason).toBe("index built from a dirty tree whose dirty files were not listed");
      expect(view.marker.degraded?.remedy).toBe("tea-rags index-codebase --project proj");
      expect(view.touchedPaths.size).toBe(0);
    });

    // No count cap: the index-time dirty files fold into the delta however
    // large it grows, and the view measures and touches every file.
    it("should measure a delta the index-time dirty files grow past 200 files", async () => {
      const changed = Array.from({ length: 150 }, (_, i) => `src/c${i}.ts`);
      const dirtyGone = Array.from({ length: 60 }, (_, i) => `src/gone${i}.ts`);
      record({ indexedCommit, indexedDirty: true, indexedDirtyPaths: dirtyGone });
      const reader: WorkingTreeDeltaReader = {
        read: async () => ({ kind: "measured", delta: { changed, deleted: [], fingerprint: "fp" } }),
      };

      const view = await overlayWith(reader).view(workingTree(), "proj");

      expect(view.marker).toMatchObject({ changedFiles: 150, deletedFiles: 60 });
      expect(view.marker.degraded).toBeUndefined();
      expect(view.touchedPaths.size).toBe(210);
      expect(view.deletedPaths.size).toBe(60);
    });
  });

  it("should measure a 250-file delta rather than degrading it", async () => {
    record({ indexedCommit, indexedDirty: false });
    const changed = Array.from({ length: 250 }, (_, i) => `src/bulk${String(i).padStart(3, "0")}.ts`);
    const reader: WorkingTreeDeltaReader = {
      read: async () => ({ kind: "measured", delta: { changed, deleted: [], fingerprint: "fp" } }),
    };

    const view = await overlayWith(reader).view(workingTree(), "proj");

    expect(view.marker).toMatchObject({ changedFiles: 250, deletedFiles: 0 });
    expect(view.marker.degraded).toBeUndefined();
    expect(view.touchedPaths.size).toBe(250);
  });

  it("should measure a tree whose index is registered at a subdirectory (live P2-2)", async () => {
    record({ indexedCommit, indexedDirty: false }, join(fixture.mainRoot, "src"));
    writeFileSync(join(tree, "src/keep.ts"), "export const keep = 2;\n");
    writeFileSync(join(tree, "outside.ts"), "export const outside = 1;\n");

    const view = await overlayWith().view(
      { root: join(tree, "src"), baseIndex: { collectionName: COLLECTION, root: join(fixture.mainRoot, "src") } },
      "proj",
    );

    expect(view.marker).toMatchObject({ treeCommit: indexedCommit, changedFiles: 1, deletedFiles: 0 });
    expect(view.marker.degraded).toBeUndefined();
    expect([...view.touchedPaths]).toEqual(["keep.ts"]);
  });

  // Live round-3 D2: a base row of a moved file has its tree counterpart at the
  // NEW path, so the view names the delta's moves for the readers that pair them.
  it("should name the delta's moves on the view", async () => {
    record({ indexedCommit, indexedDirty: false });
    rmSync(join(tree, "src/keep.ts"));
    writeFileSync(join(tree, "src/moved.ts"), "export const keep = 1;\n");

    const view = await overlayWith().view(workingTree(), "proj");

    expect(view.renamedFrom).toEqual(new Map([["src/moved.ts", "src/keep.ts"]]));
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

  describe("delta chunks (xi2r9.3)", () => {
    const CHUNKER_CONFIG = { chunkSize: 2500, chunkOverlap: 300, maxChunkSize: 2500 };

    /** A layer whose chunker returns one row per file and fails on BROKEN content. */
    const deltaChunks = () => {
      const chunkFile = vi.fn(async (_pool: unknown, file: { relativePath: string; code: string }) => {
        if (file.code.includes("BROKEN")) throw new Error("parse failed");
        return [{ id: `id:${file.relativePath}`, payload: { relativePath: file.relativePath } }];
      });
      const layer = createWorkingTreeChunkLayer({ createPool: () => ({ shutdown: async () => undefined }), chunkFile });
      const resolveChunkerConfig = vi.fn(async () => CHUNKER_CONFIG);
      return { layer, chunkFile, resolveChunkerConfig };
    };

    it("should read rows for the changed files only, with the tree's chunker config", async () => {
      record({ indexedCommit, indexedDirty: false });
      writeFileSync(join(tree, "src/keep.ts"), "export const keep = 2;\n");
      fixture.git(tree, "rm", "-q", "src/index.ts");
      const { layer, chunkFile, resolveChunkerConfig } = deltaChunks();
      const overlay = new WorkingTreeOverlay({
        registry,
        deltaReader: createWorkingTreeDeltaReader(),
        createFileFilter,
        deltaChunks: { layer, resolveChunkerConfig },
      });

      const view = await overlay.view(workingTree(), "proj");
      const rows = await view.readDeltaChunks?.();

      expect(rows?.map((row) => row.payload.relativePath)).toEqual(["src/keep.ts"]);
      expect(resolveChunkerConfig).toHaveBeenCalledWith(workingTree());
      expect(chunkFile).toHaveBeenCalledTimes(1);
      expect(view.marker.unparsed).toBeUndefined();
      await layer.dispose();
    });

    it("should list a file that fails to parse in marker.unparsed without degrading the answer", async () => {
      record({ indexedCommit, indexedDirty: false });
      writeFileSync(join(tree, "src/keep.ts"), "export const keep = 2;\n");
      writeFileSync(join(tree, "src/bad.ts"), "BROKEN {{{\n");
      const { layer, resolveChunkerConfig } = deltaChunks();
      const overlay = new WorkingTreeOverlay({
        registry,
        deltaReader: createWorkingTreeDeltaReader(),
        createFileFilter,
        deltaChunks: { layer, resolveChunkerConfig },
      });

      const view = await overlay.view(workingTree(), "proj");
      const rows = await view.readDeltaChunks?.();

      expect(rows?.map((row) => row.payload.relativePath)).toEqual(["src/keep.ts"]);
      expect(view.marker.unparsed).toEqual(["src/bad.ts"]);
      expect(view.marker.degraded).toBeUndefined();
      expect(view.marker.changedFiles).toBe(2);
      await layer.dispose();
    });

    it("should offer no delta chunks on a degraded view", async () => {
      record(undefined);
      const { layer, resolveChunkerConfig } = deltaChunks();
      const overlay = new WorkingTreeOverlay({
        registry,
        deltaReader: createWorkingTreeDeltaReader(),
        createFileFilter,
        deltaChunks: { layer, resolveChunkerConfig },
      });

      const view = await overlay.view(workingTree(), "proj");

      expect(view.marker.degraded).toBeDefined();
      expect(view.readDeltaChunks).toBeUndefined();
    });
  });

  /**
   * Delta admission: only a changed file the AST chunker reads is re-read; any
   * other changed file is served from the index, marked `treeState:
   * "modified"`. Deletions apply to every admitted file. The marker keeps the
   * true distance and counts the index-only files.
   */
  describe("delta admission", () => {
    const admitsTs = (relativePath: string): boolean => relativePath.endsWith(".ts");
    const acceptAll = async (): Promise<(relativePath: string) => boolean> => () => true;

    const readerOf = (
      changed: string[],
      deleted: string[],
      renamedFrom?: ReadonlyMap<string, string>,
    ): WorkingTreeDeltaReader => ({
      read: async () => ({
        kind: "measured",
        delta: { changed, deleted, fingerprint: "fp", ...(renamedFrom ? { renamedFrom } : {}) },
      }),
    });

    /** Every per-view consumer of the re-read set, each spied. */
    const consumers = () => {
      const chunkFile = vi.fn(async (_pool: unknown, file: { relativePath: string }) => [
        { id: `id:${file.relativePath}`, payload: { relativePath: file.relativePath } },
      ]);
      const layer = createWorkingTreeChunkLayer({ createPool: () => ({ shutdown: async () => undefined }), chunkFile });
      const graphFor = vi.fn(async () => ({ kind: "unavailable" as const, reason: "test" }));
      const warm = vi.fn(() => async () => ({ vectors: new Map<string, number[]>(), pending: 0 }));
      return {
        chunkFile,
        layer,
        graphFor,
        warm,
        deps: {
          deltaChunks: { layer, resolveChunkerConfig: async () => ({ chunkSize: 2500, chunkOverlap: 300 }) },
          treeGraph: { graphFor },
          denseVectors: { warm },
        },
      };
    };

    it("should re-read admitted files and serve the rest from the index, counting them", async () => {
      record({ indexedCommit, indexedDirty: false });
      const overlay = new WorkingTreeOverlay({
        registry,
        deltaReader: readerOf(["config.json", "src/a.ts"], ["old.yaml"]),
        createFileFilter: acceptAll,
        admitsToDelta: admitsTs,
      });

      const view = await overlay.view(workingTree(), "proj");

      expect(view.marker).toMatchObject({ changedFiles: 2, deletedFiles: 1, indexOnlyFiles: 1 });
      expect(view.marker.degraded).toBeUndefined();
      expect([...view.touchedPaths].sort()).toEqual(["old.yaml", "src/a.ts"]);
      expect([...view.indexServedPaths]).toEqual(["config.json"]);
      expect([...view.deletedPaths]).toEqual(["old.yaml"]);
    });

    it("should mark an index-only file's rows modified and keep a deleted non-AST file deleted", async () => {
      record({ indexedCommit, indexedDirty: false });
      const overlay = new WorkingTreeOverlay({
        registry,
        deltaReader: readerOf(["config.json", "src/a.ts"], ["old.yaml"]),
        createFileFilter: acceptAll,
        admitsToDelta: admitsTs,
      });

      const view = await overlay.view(workingTree(), "proj");

      expect(workingTreeStateOf(view, "config.json")).toBe("modified");
      expect(workingTreeStateOf(view, "old.yaml")).toBe("deleted");
      expect(workingTreeStateOf(view, "src/a.ts")).toBe("modified");
      expect(workingTreeStateOf(view, "src/untouched.ts")).toBeUndefined();
    });

    it("should leave indexOnlyFiles off the marker when every changed file is admitted", async () => {
      record({ indexedCommit, indexedDirty: false });
      const overlay = new WorkingTreeOverlay({
        registry,
        deltaReader: readerOf(["src/a.ts"], []),
        createFileFilter: acceptAll,
        admitsToDelta: admitsTs,
      });

      const view = await overlay.view(workingTree(), "proj");

      expect(view.marker).not.toHaveProperty("indexOnlyFiles");
      expect(view.indexServedPaths.size).toBe(0);
    });

    it("should admit every changed file when no admission rule is wired", async () => {
      record({ indexedCommit, indexedDirty: false });
      const overlay = new WorkingTreeOverlay({
        registry,
        deltaReader: readerOf(["config.json", "src/a.ts"], []),
        createFileFilter: acceptAll,
      });

      const view = await overlay.view(workingTree(), "proj");

      expect([...view.touchedPaths].sort()).toEqual(["config.json", "src/a.ts"]);
      expect(view.indexServedPaths.size).toBe(0);
      expect(view.marker).not.toHaveProperty("indexOnlyFiles");
    });

    it("should hide a renamed non-AST file's old path and serve its new path from the index", async () => {
      record({ indexedCommit, indexedDirty: false });
      const overlay = new WorkingTreeOverlay({
        registry,
        deltaReader: readerOf(["conf/new.json"], ["conf/old.json"], new Map([["conf/new.json", "conf/old.json"]])),
        createFileFilter: acceptAll,
        admitsToDelta: admitsTs,
      });

      const view = await overlay.view(workingTree(), "proj");

      expect([...view.deletedPaths]).toEqual(["conf/old.json"]);
      expect([...view.touchedPaths]).toEqual(["conf/old.json"]);
      expect([...view.indexServedPaths]).toEqual(["conf/new.json"]);
      expect(workingTreeStateOf(view, "conf/old.json")).toBe("deleted");
      expect(view.marker).toMatchObject({ changedFiles: 1, deletedFiles: 1, indexOnlyFiles: 1 });
    });

    it("should keep a non-AST file dirty at index time index-only", async () => {
      record({ indexedCommit, indexedDirty: true, indexedDirtyPaths: ["settings.json"] });
      writeFileSync(join(tree, "settings.json"), "{}\n");
      const overlay = new WorkingTreeOverlay({
        registry,
        deltaReader: readerOf([], []),
        createFileFilter: acceptAll,
        admitsToDelta: admitsTs,
      });

      const view = await overlay.view(workingTree(), "proj");

      expect(view.marker).toMatchObject({ changedFiles: 1, deletedFiles: 0, indexOnlyFiles: 1 });
      expect(view.touchedPaths.size).toBe(0);
      expect([...view.indexServedPaths]).toEqual(["settings.json"]);
    });

    it("should read no chunks, warm no vectors and ask no tree graph when every changed file is index-only", async () => {
      record({ indexedCommit, indexedDirty: false });
      const { chunkFile, layer, graphFor, warm, deps } = consumers();
      const overlay = new WorkingTreeOverlay({
        registry,
        deltaReader: readerOf(["config.json"], []),
        createFileFilter: acceptAll,
        admitsToDelta: admitsTs,
        ...deps,
      });

      const view = await overlay.view(workingTree(), "proj");
      const rows = (await view.readDeltaChunks?.()) ?? [];

      expect(rows).toEqual([]);
      expect(chunkFile).not.toHaveBeenCalled();
      expect(view.readTreeGraph).toBeUndefined();
      expect(graphFor).not.toHaveBeenCalled();
      expect(view.readDeltaVectors).toBeUndefined();
      expect(warm).not.toHaveBeenCalled();
      await layer.dispose();
    });

    it("should hand the chunk read, the tree graph and the dense warm-up the re-read files only", async () => {
      record({ indexedCommit, indexedDirty: false });
      writeFileSync(join(tree, "src/a.ts"), "export const a = 1;\n");
      writeFileSync(join(tree, "config.json"), "{}\n");
      const { chunkFile, layer, graphFor, warm, deps } = consumers();
      const overlay = new WorkingTreeOverlay({
        registry,
        deltaReader: readerOf(["config.json", "src/a.ts"], []),
        createFileFilter: acceptAll,
        admitsToDelta: admitsTs,
        ...deps,
      });

      const view = await overlay.view(workingTree(), "proj");
      const rows = (await view.readDeltaChunks?.()) ?? [];
      await view.readDeltaVectors?.(0);

      expect(rows.map((row) => row.payload.relativePath)).toEqual(["src/a.ts"]);
      expect(chunkFile).toHaveBeenCalledTimes(1);
      expect(graphFor).toHaveBeenCalled();
      expect(graphFor.mock.calls[0][0]).toMatchObject({ changed: ["src/a.ts"], deleted: [] });
      expect(warm).toHaveBeenCalledTimes(1);
      await layer.dispose();
    });
  });
});

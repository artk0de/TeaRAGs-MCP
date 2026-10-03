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
import type { ScrollChunk } from "../../../../../src/core/domains/explore/chunk-grouping/types.js";
import type { WorkingTreeChunkStoreKey } from "../../../../../src/core/domains/explore/working-tree/chunk-store.js";
import {
  createWorkingTreeChunkLayer,
  substituteWorkingTreeRows,
  WorkingTreeDeltaWarmer,
  WorkingTreeOverlay,
  workingTreeStateOf,
  WorkingTreeTouchedBasePoints,
  type WorkingTreeDeltaReader,
  type WorkingTreeDeltaWarmRequest,
  type WorkingTreeDeltaWarmState,
  type WorkingTreeOverlayDeps,
} from "../../../../../src/core/domains/explore/working-tree/index.js";
import { CollectionRegistry } from "../../../../../src/core/domains/maintenance/registry/index.js";

/**
 * `WorkingTreeOverlay` over the delta warmer (WTO unbounded delta, Tasks 5–6):
 * a view waits at most its warm budget, serves the warm files from the tree and
 * the rest from the index (`pendingFiles`); `prewarm` re-measures a viewed tree
 * and queues its re-read files on the background lane; a linked tree with
 * re-read files is handed to the watcher.
 */
describe("WorkingTreeOverlay with a delta warmer", { timeout: 60_000 }, () => {
  let fixture: GitWorkingTreeFixture;
  let registryDir: string;
  let registry: CollectionRegistry;
  let indexedCommit: string;
  let tree: string;

  const COLLECTION = "code_overlay_warm";
  const CHUNKER_CONFIG = { chunkSize: 2500, chunkOverlap: 300 };
  const WAIT_MS = 60;

  const record = (git: Omit<RegistryGitState, "indexedBranch">): void => {
    registry.record({
      collectionName: COLLECTION,
      path: fixture.mainRoot,
      embeddingModel: "m",
      embeddingDimensions: 1,
      qdrantUrl: "u",
      indexedAt: "t",
      teaRagsVersion: "v",
      chunksCount: 0,
      git: { indexedBranch: "main", ...git },
    });
    registry.setName(COLLECTION, "proj");
  };

  const acceptAll = async (): Promise<(relativePath: string) => boolean> => () => true;

  const readerOf = (changed: string[], deleted: string[]): WorkingTreeDeltaReader => ({
    read: async () => ({ kind: "measured", delta: { changed, deleted, fingerprint: "fp" } }),
  });

  const workingTree = (root = tree): WorkingTree => ({
    root,
    baseIndex: { collectionName: COLLECTION, root: fixture.mainRoot },
  });

  const row = (path: string): ScrollChunk => ({ id: `tree:${path}`, payload: { relativePath: path } });
  const baseRow = (path: string): ScrollChunk => ({ id: `base:${path}`, payload: { relativePath: path } });
  const storeKey = (path: string): WorkingTreeChunkStoreKey => ({
    treeRoot: tree,
    relativePath: path,
    contentSha256: `sha:${path}`,
    chunkerFingerprint: "fp",
  });

  /** A warm state where `warm` are chunked and `pending` are not. */
  const stateOf = (warm: string[], pending: string[], unparsed: string[] = []): WorkingTreeDeltaWarmState => ({
    rows: warm.filter((path) => !unparsed.includes(path)).map(row),
    warmPaths: new Set(warm),
    unparsed,
    pending,
    storeKeys: new Map(warm.filter((path) => !unparsed.includes(path)).map((path) => [path, storeKey(path)])),
  });

  const fakeWarmer = (
    answer: (
      request: WorkingTreeDeltaWarmRequest,
      budgetMs: number,
      lane: "live" | "background",
    ) => Promise<WorkingTreeDeltaWarmState>,
  ) => ({ warm: vi.fn(answer) });

  /** A chunk layer that must never be asked: with a warmer, every chunk goes through it. */
  const unusedLayer = () => {
    const chunkFile = vi.fn(async () => [] as ScrollChunk[]);
    return {
      chunkFile,
      layer: createWorkingTreeChunkLayer({ createPool: () => ({ shutdown: async () => undefined }), chunkFile }),
    };
  };

  const overlayWith = (deps: Partial<WorkingTreeOverlayDeps> & Pick<WorkingTreeOverlayDeps, "deltaReader">) => {
    const { layer, chunkFile } = unusedLayer();
    const resolveChunkerConfig = vi.fn(async () => CHUNKER_CONFIG);
    const overlay = new WorkingTreeOverlay({
      registry,
      createFileFilter: acceptAll,
      deltaChunks: { layer, resolveChunkerConfig },
      warmWaitMs: WAIT_MS,
      ...deps,
    });
    return { overlay, layer, chunkFile, resolveChunkerConfig };
  };

  beforeEach(() => {
    fixture = createGitWorkingTreeFixture();
    indexedCommit = fixture.commit(fixture.mainRoot, { "src/keep.ts": "export const keep = 1;\n" }, "A");
    tree = fixture.addWorktree("feature");
    registryDir = mkdtempSync(join(tmpdir(), "wto-warm-registry-"));
    registry = new CollectionRegistry(registryDir);
    record({ indexedCommit, indexedDirty: false });
  });

  afterEach(() => {
    fixture.cleanup();
    rmSync(registryDir, { recursive: true, force: true });
  });

  describe("view", () => {
    it("should serve a pending file's base rows marked modified and replace a warm file's", async () => {
      const warmer = fakeWarmer(async () => stateOf(["src/a.ts"], ["src/b.ts"]));
      const { overlay, chunkFile, layer } = overlayWith({
        deltaReader: readerOf(["src/a.ts", "src/b.ts"], ["src/gone.ts"]),
        warmer,
      });

      const view = await overlay.view(workingTree(), "proj");

      expect(warmer.warm).toHaveBeenCalledWith(
        { treeRoot: tree, collectionName: COLLECTION, config: CHUNKER_CONFIG, paths: ["src/a.ts", "src/b.ts"] },
        expect.any(Number),
        "live",
      );
      expect(warmer.warm.mock.calls[0][1]).toBeLessThanOrEqual(WAIT_MS);
      expect([...view.touchedPaths].sort()).toEqual(["src/a.ts", "src/gone.ts"]);
      expect([...(view.indexServedPaths ?? [])]).toEqual(["src/b.ts"]);
      expect(view.marker).toMatchObject({ changedFiles: 2, deletedFiles: 1, pendingFiles: 1 });
      expect(workingTreeStateOf(view, "src/b.ts")).toBe("modified");
      expect(workingTreeStateOf(view, "src/gone.ts")).toBe("deleted");

      const answered = substituteWorkingTreeRows(
        [baseRow("src/a.ts"), baseRow("src/b.ts"), baseRow("src/untouched.ts")],
        view,
        (await view.readDeltaChunks?.()) ?? [],
        () => true,
      );
      expect(answered.map((hit) => hit.id).sort()).toEqual(["base:src/b.ts", "base:src/untouched.ts", "tree:src/a.ts"]);
      expect(chunkFile).not.toHaveBeenCalled();
      await layer.dispose();
    });

    it("should leave pendingFiles off the marker once every re-read file is warm", async () => {
      const warmer = fakeWarmer(async () => stateOf(["src/a.ts", "src/b.ts"], []));
      const { overlay } = overlayWith({ deltaReader: readerOf(["src/a.ts", "src/b.ts"], []), warmer });

      const view = await overlay.view(workingTree(), "proj");

      expect(view.marker).not.toHaveProperty("pendingFiles");
      expect(view.indexServedPaths?.size).toBe(0);
      expect([...view.touchedPaths].sort()).toEqual(["src/a.ts", "src/b.ts"]);
    });

    it("should count index-only and pending files separately in indexServedPaths", async () => {
      const warmer = fakeWarmer(async () => stateOf([], ["src/a.ts"]));
      const { overlay } = overlayWith({
        deltaReader: readerOf(["config.json", "src/a.ts"], []),
        admitsToDelta: (path) => path.endsWith(".ts"),
        warmer,
      });

      const view = await overlay.view(workingTree(), "proj");

      expect([...(view.indexServedPaths ?? [])].sort()).toEqual(["config.json", "src/a.ts"]);
      expect(view.marker).toMatchObject({ indexOnlyFiles: 1, pendingFiles: 1 });
      expect(warmer.warm.mock.calls[0][0].paths).toEqual(["src/a.ts"]);
    });

    it("should resolve readDeltaChunks to the warm rows only and name the warm unparsed files", async () => {
      const warmer = fakeWarmer(async () => stateOf(["src/a.ts", "src/bad.ts"], ["src/b.ts"], ["src/bad.ts"]));
      const { overlay } = overlayWith({
        deltaReader: readerOf(["src/a.ts", "src/b.ts", "src/bad.ts"], []),
        warmer,
      });

      const view = await overlay.view(workingTree(), "proj");
      const rows = (await view.readDeltaChunks?.()) ?? [];

      expect(rows.map((chunk) => chunk.id)).toEqual(["tree:src/a.ts"]);
      expect(view.marker.unparsed).toEqual(["src/bad.ts"]);
      expect(view.marker.pendingFiles).toBe(1);
    });

    it("should serve every re-read file from the index when the warmer rejects", async () => {
      const warmer = fakeWarmer(async () => {
        throw new Error("queue broke");
      });
      const { overlay } = overlayWith({ deltaReader: readerOf(["src/a.ts", "src/b.ts"], ["src/gone.ts"]), warmer });

      const view = await overlay.view(workingTree(), "proj");

      expect(view.marker.degraded).toBeUndefined();
      expect(view.marker.pendingFiles).toBe(2);
      expect([...view.touchedPaths]).toEqual(["src/gone.ts"]);
      expect([...(view.indexServedPaths ?? [])].sort()).toEqual(["src/a.ts", "src/b.ts"]);
      expect(await view.readDeltaChunks?.()).toEqual([]);
    });

    it("should serve every re-read file from the index when the chunker config cannot be resolved", async () => {
      const warmer = fakeWarmer(async () => stateOf(["src/a.ts"], []));
      const { overlay } = overlayWith({
        deltaReader: readerOf(["src/a.ts"], []),
        warmer,
        deltaChunks: {
          layer: unusedLayer().layer,
          resolveChunkerConfig: async () => {
            throw new Error("no project env");
          },
        },
      });

      const view = await overlay.view(workingTree(), "proj");

      expect(warmer.warm).not.toHaveBeenCalled();
      expect(view.marker.pendingFiles).toBe(1);
      expect(view.marker.degraded).toBeUndefined();
    });

    it("should answer within the warm budget when the warmer never resolves", async () => {
      const warmer = fakeWarmer(async () => new Promise<WorkingTreeDeltaWarmState>(() => undefined));
      const { overlay } = overlayWith({ deltaReader: readerOf(["src/a.ts"], []), warmer });

      const started = performance.now();
      const view = await overlay.view(workingTree(), "proj");
      const elapsed = performance.now() - started;

      expect(view.marker.pendingFiles).toBe(1);
      // Budget + the overlay's grace + delta measurement on a real git tree.
      expect(elapsed).toBeLessThan(WAIT_MS + 1_000);
    });

    it("should answer within the warm budget over a real warmer whose chunker hangs", async () => {
      writeFileSync(join(tree, "src/a.ts"), "export const a = 1;\n");
      const chunkFile = vi.fn(async () => new Promise<ScrollChunk[]>(() => undefined));
      const layer = createWorkingTreeChunkLayer({ createPool: () => ({ shutdown: async () => undefined }), chunkFile });
      const warmer = new WorkingTreeDeltaWarmer({ layer });
      const { overlay } = overlayWith({
        deltaReader: readerOf(["src/a.ts"], []),
        warmer,
        deltaChunks: { layer, resolveChunkerConfig: async () => CHUNKER_CONFIG },
      });

      const started = performance.now();
      const view = await overlay.view(workingTree(), "proj");
      const elapsed = performance.now() - started;

      expect(chunkFile).toHaveBeenCalledTimes(1);
      expect(view.marker.pendingFiles).toBe(1);
      expect(workingTreeStateOf(view, "src/a.ts")).toBe("modified");
      expect(elapsed).toBeLessThan(WAIT_MS + 1_000);
      warmer.dispose();
    });

    it("should warm the dense vectors over the warm rows with their store keys", async () => {
      const state = stateOf(["src/a.ts"], ["src/b.ts"]);
      const warmer = fakeWarmer(async () => state);
      const warm = vi.fn(() => async () => ({ vectors: new Map<string, number[]>(), pending: 0 }));
      const { overlay } = overlayWith({
        deltaReader: readerOf(["src/a.ts", "src/b.ts"], []),
        warmer,
        denseVectors: { warm },
      });

      const view = await overlay.view(workingTree(), "proj");
      await view.readDeltaVectors?.(0);

      expect(warm).toHaveBeenCalledTimes(1);
      expect(warm).toHaveBeenCalledWith(
        expect.objectContaining({ collectionName: COLLECTION, rows: state.rows, storeKeys: state.storeKeys }),
      );
    });

    it("should ask the tree graph over every re-read file, pending ones included", async () => {
      const warmer = fakeWarmer(async () => stateOf(["src/a.ts"], ["src/b.ts"]));
      const graphFor = vi.fn(async () => ({ kind: "unavailable" as const, reason: "test" }));
      const { overlay } = overlayWith({
        deltaReader: readerOf(["src/a.ts", "src/b.ts"], ["src/gone.ts"]),
        warmer,
        treeGraph: { graphFor },
      });

      await overlay.view(workingTree(), "proj");

      expect(graphFor).toHaveBeenCalled();
      expect(graphFor.mock.calls[0][0]).toMatchObject({ changed: ["src/a.ts", "src/b.ts"], deleted: ["src/gone.ts"] });
    });

    it("should keep today's unbounded chunk read when no warmer is wired", async () => {
      writeFileSync(join(tree, "src/a.ts"), "export const a = 1;\n");
      const chunkFile = vi.fn(async (_pool: unknown, file: { relativePath: string }) => [row(file.relativePath)]);
      const layer = createWorkingTreeChunkLayer({ createPool: () => ({ shutdown: async () => undefined }), chunkFile });
      const overlay = new WorkingTreeOverlay({
        registry,
        createFileFilter: acceptAll,
        deltaReader: readerOf(["src/a.ts"], []),
        deltaChunks: { layer, resolveChunkerConfig: async () => CHUNKER_CONFIG },
      });

      const view = await overlay.view(workingTree(), "proj");

      expect((await view.readDeltaChunks?.())?.map((chunk) => chunk.id)).toEqual(["tree:src/a.ts"]);
      expect(view.marker).not.toHaveProperty("pendingFiles");
      expect([...view.touchedPaths]).toEqual(["src/a.ts"]);
      await layer.dispose();
    });
  });

  describe("watcher", () => {
    it("should watch a linked tree whose delta re-reads files", async () => {
      const watch = vi.fn();
      const { overlay } = overlayWith({
        deltaReader: readerOf(["src/a.ts"], []),
        warmer: fakeWarmer(async () => stateOf(["src/a.ts"], [])),
        watcher: { watch },
      });

      await overlay.view(workingTree(), "proj");

      expect(watch).toHaveBeenCalledWith(tree);
    });

    it("should not watch the base index's own checkout", async () => {
      const watch = vi.fn();
      const { overlay } = overlayWith({
        deltaReader: readerOf(["src/a.ts"], []),
        warmer: fakeWarmer(async () => stateOf(["src/a.ts"], [])),
        watcher: { watch },
      });

      await overlay.view(workingTree(fixture.mainRoot), "proj");

      expect(watch).not.toHaveBeenCalled();
    });

    it("should not watch a tree whose delta re-reads nothing", async () => {
      const watch = vi.fn();
      const { overlay } = overlayWith({
        deltaReader: readerOf(["config.json"], ["src/gone.ts"]),
        admitsToDelta: (path) => path.endsWith(".ts"),
        warmer: fakeWarmer(async () => stateOf([], [])),
        watcher: { watch },
      });

      await overlay.view(workingTree(), "proj");

      expect(watch).not.toHaveBeenCalled();
    });
  });

  describe("prewarm", () => {
    /** A Qdrant whose every method is recorded; a write throws. */
    const recordingQdrant = () => {
      const calls: string[] = [];
      const qdrant = new Proxy(
        {},
        {
          get:
            (_target, name) =>
            async (..._args: unknown[]) => {
              calls.push(String(name));
              if (/upsert|delete|set|create|update|overwrite|clear|batch/i.test(String(name))) {
                throw new Error(`write ${String(name)}`);
              }
              return { points: [], next_page_offset: null };
            },
        },
      );
      return { qdrant, calls };
    };

    it("should do nothing for a root no view has seen", async () => {
      const warmer = fakeWarmer(async () => stateOf([], []));
      const { overlay } = overlayWith({ deltaReader: readerOf(["src/a.ts"], []), warmer });

      await expect(overlay.prewarm(tree)).resolves.toBeUndefined();

      expect(warmer.warm).not.toHaveBeenCalled();
    });

    it("should queue the viewed tree's re-read files on the background lane without waiting", async () => {
      const graphFor = vi.fn(async () => ({ kind: "unavailable" as const, reason: "test" }));
      const { qdrant, calls } = recordingQdrant();
      let changed = ["src/a.ts"];
      const deltaReader: WorkingTreeDeltaReader = {
        read: async () => ({ kind: "measured", delta: { changed, deleted: [], fingerprint: changed.join(",") } }),
      };
      const warmer = fakeWarmer(async (_request, _budget, lane) =>
        lane === "live" ? stateOf(["src/a.ts"], []) : new Promise<WorkingTreeDeltaWarmState>(() => undefined),
      );
      const { overlay } = overlayWith({
        deltaReader,
        warmer,
        treeGraph: { graphFor },
        touchedBasePoints: new WorkingTreeTouchedBasePoints(qdrant as never),
      });
      await overlay.view(workingTree(), "proj");
      changed = ["src/a.ts", "src/b.ts"];
      graphFor.mockClear();

      await overlay.prewarm(tree);

      expect(warmer.warm).toHaveBeenCalledTimes(2);
      expect(warmer.warm.mock.calls[1]).toEqual([
        { treeRoot: tree, collectionName: COLLECTION, config: CHUNKER_CONFIG, paths: ["src/a.ts", "src/b.ts"] },
        0,
        "background",
      ]);
      expect(graphFor).toHaveBeenCalledTimes(1);
      expect(graphFor.mock.calls[0][0]).toMatchObject({ changed: ["src/a.ts", "src/b.ts"] });
      expect(graphFor.mock.calls[0][1]).toBe(0);
      expect(calls.filter((name) => /upsert|delete|set|create|update|overwrite|clear|batch/i.test(name))).toEqual([]);
    });

    // A long-lived server views many trees; what it remembers to prewarm stays
    // bounded, the least recently viewed root forgotten first.
    it("should forget the least recently viewed root past the remembered bound", async () => {
      const warmer = fakeWarmer(async () => stateOf(["src/a.ts"], []));
      const kept = 3;
      const { overlay } = overlayWith({ deltaReader: readerOf(["src/a.ts"], []), warmer, viewedTreesKept: kept });
      const roots = Array.from({ length: kept + 1 }, (_, i) => `${tree}-gone-${i}`);
      await overlay.view(workingTree(roots[0]), "proj");
      for (const root of roots.slice(2)) await overlay.view(workingTree(root), "proj");
      await overlay.view(workingTree(roots[0]), "proj");
      await overlay.view(workingTree(roots[1]), "proj");
      const background = () => warmer.warm.mock.calls.filter(([, , lane]) => lane === "background").length;

      await overlay.prewarm(roots[2]);
      const afterEvicted = background();
      await overlay.prewarm(roots[0]);
      await overlay.prewarm(roots[1]);

      expect(afterEvicted).toBe(0);
      expect(background()).toBe(2);
    });

    it("should never reject when measuring or warming fails", async () => {
      let fail = false;
      const deltaReader: WorkingTreeDeltaReader = {
        read: async () => {
          if (fail) throw new Error("git gone");
          return { kind: "measured", delta: { changed: ["src/a.ts"], deleted: [], fingerprint: "fp" } };
        },
      };
      const warmer = fakeWarmer(async (_request, _budget, lane) => {
        if (lane === "background") throw new Error("queue broke");
        return stateOf(["src/a.ts"], []);
      });
      const { overlay } = overlayWith({ deltaReader, warmer });
      await overlay.view(workingTree(), "proj");

      await expect(overlay.prewarm(tree)).resolves.toBeUndefined();
      fail = true;
      await expect(overlay.prewarm(tree)).resolves.toBeUndefined();
    });
  });
});

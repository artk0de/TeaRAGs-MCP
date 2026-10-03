/**
 * `WorkingTreeOverlay` and the tree graph (bd tea-rags-mcp-xi2r9, WTO-7): a
 * view with a measured non-empty delta starts the tree-graph build at once
 * (warm-up, `graphFor(request, 0)`) and offers `readTreeGraph`; a clean or
 * degraded view does neither. Delta rows come out of `readDeltaChunks`
 * enriched by the injected signal source, and the marker records which graph
 * their codegraph block came from.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type {
  WorkingTree,
  WorkingTreeDeltaSignalSource,
  WorkingTreeGraphSource,
  WorkingTreeGraphState,
} from "../../../../../src/core/contracts/types/working-tree.js";
import {
  createWorkingTreeChunkLayer,
  WorkingTreeOverlay,
  type WorkingTreeDeltaReader,
} from "../../../../../src/core/domains/explore/working-tree/index.js";

const COLLECTION = "code_tree_graph";
const BUILT: WorkingTreeGraphState = {
  kind: "built",
  dbPath: "/graphs/tree.duckdb",
  physicalCollectionName: "code_tree_graph_v1" as never,
};

describe("WorkingTreeOverlay tree graph (WTO-7)", () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "wto-tree-graph-"));
    mkdirSync(join(root, "src"));
    writeFileSync(join(root, "src/a.ts"), "export const a = 1;\n");
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  const workingTree = (): WorkingTree => ({ root, baseIndex: { collectionName: COLLECTION, root } });

  const registry = { get: () => ({ git: { indexedCommit: "a".repeat(40), indexedDirty: false } }) } as never;

  const deltaReader = (changed: string[], deleted: string[] = []): WorkingTreeDeltaReader => ({
    read: vi.fn(async () => ({ kind: "measured" as const, delta: { changed, deleted, fingerprint: "fp-1" } })),
  });

  const graphSource = (state: WorkingTreeGraphState = BUILT) => ({
    graphFor: vi.fn<WorkingTreeGraphSource["graphFor"]>(async () => state),
  });

  const overlayWith = (
    reader: WorkingTreeDeltaReader,
    extra: Partial<ConstructorParameters<typeof WorkingTreeOverlay>[0]> = {},
  ): WorkingTreeOverlay =>
    new WorkingTreeOverlay({ registry, deltaReader: reader, createFileFilter: async () => () => true, ...extra });

  it("should start the tree graph build once, without waiting, for a non-empty delta", async () => {
    const treeGraph = graphSource();

    await overlayWith(deltaReader(["src/a.ts"], ["src/gone.ts"]), { treeGraph }).view(workingTree(), "proj");

    expect(treeGraph.graphFor).toHaveBeenCalledTimes(1);
    const [request, waitMs] = treeGraph.graphFor.mock.calls[0];
    expect(waitMs).toBe(0);
    expect(request.tree).toEqual(workingTree());
    expect(request.changed).toEqual(["src/a.ts"]);
    expect(request.deleted).toEqual(["src/gone.ts"]);
    expect(request.fingerprint).toEqual(expect.any(String));
  });

  it("should neither warm up nor offer a tree graph for a clean tree", async () => {
    const treeGraph = graphSource();

    const view = await overlayWith(deltaReader([]), { treeGraph }).view(workingTree(), "proj");

    expect(treeGraph.graphFor).not.toHaveBeenCalled();
    expect(view.readTreeGraph).toBeUndefined();
  });

  it("should neither warm up nor offer a tree graph for a degraded view", async () => {
    const treeGraph = graphSource();
    const degraded: WorkingTreeDeltaReader = {
      read: async () => ({ kind: "degraded", reason: "no stamp", remedy: "reindex" }),
    };

    const view = await overlayWith(degraded, { treeGraph }).view(workingTree(), "proj");

    expect(treeGraph.graphFor).not.toHaveBeenCalled();
    expect(view.readTreeGraph).toBeUndefined();
  });

  it("should hand readTreeGraph's wait to the graph source with the warm-up's request", async () => {
    const treeGraph = graphSource();
    const view = await overlayWith(deltaReader(["src/a.ts"]), { treeGraph }).view(workingTree(), "proj");

    const state = await view.readTreeGraph?.(3000);

    expect(state).toEqual(BUILT);
    expect(treeGraph.graphFor).toHaveBeenLastCalledWith(treeGraph.graphFor.mock.calls[0][0], 3000);
    // Reading the graph is not using it: the marker is stamped by whoever reads from it.
    expect(view.marker.floors).toEqual([]);
  });

  it("should not ask again once the graph answered built", async () => {
    const treeGraph = graphSource();
    const view = await overlayWith(deltaReader(["src/a.ts"]), { treeGraph }).view(workingTree(), "proj");

    await view.readTreeGraph?.(3000);
    await view.readTreeGraph?.(120_000);

    expect(treeGraph.graphFor).toHaveBeenCalledTimes(2); // warm-up + first read
  });

  describe("delta row signals", () => {
    const CHUNKER_CONFIG = { chunkSize: 2500, chunkOverlap: 300, maxChunkSize: 2500 };
    const layer = () =>
      createWorkingTreeChunkLayer({
        createPool: () => ({ shutdown: async () => undefined }),
        chunkFile: async (_pool: unknown, file: { relativePath: string }) => [
          { id: `id:${file.relativePath}`, payload: { relativePath: file.relativePath } },
        ],
      });

    const signalSource = (treeGraph: WorkingTreeGraphState | undefined) => ({
      enrich: vi.fn<WorkingTreeDeltaSignalSource["enrich"]>(async (request) => ({
        rows: request.rows.map((row) => ({ ...row, payload: { ...row.payload, git: { file: { commitCount: 7 } } } })),
        ...(treeGraph ? { treeGraph } : {}),
      })),
    });

    it("should enrich the delta rows once, handing the source the view's tree graph", async () => {
      const chunkLayer = layer();
      const deltaSignals = signalSource(BUILT);
      const treeGraph = graphSource();
      const view = await overlayWith(deltaReader(["src/a.ts"]), {
        treeGraph,
        deltaSignals,
        deltaChunks: { layer: chunkLayer, resolveChunkerConfig: async () => CHUNKER_CONFIG },
      }).view(workingTree(), "proj");

      const rows = await view.readDeltaChunks?.();
      await view.readDeltaChunks?.();

      expect(rows?.[0].payload).toMatchObject({ relativePath: "src/a.ts", git: { file: { commitCount: 7 } } });
      expect(deltaSignals.enrich).toHaveBeenCalledTimes(1);
      const [request] = deltaSignals.enrich.mock.calls[0];
      expect(request.tree).toEqual(workingTree());
      expect(request.readTreeGraph).toBe(view.readTreeGraph);
      await chunkLayer.dispose();
    });

    it("should add the codegraph floor when the rows' graph data came from the tree graph", async () => {
      const chunkLayer = layer();
      const view = await overlayWith(deltaReader(["src/a.ts"]), {
        treeGraph: graphSource(),
        deltaSignals: signalSource(BUILT),
        deltaChunks: { layer: chunkLayer, resolveChunkerConfig: async () => CHUNKER_CONFIG },
      }).view(workingTree(), "proj");

      await view.readDeltaChunks?.();

      expect(view.marker.floors).toEqual(["codegraph"]);
      expect(view.marker.treeGraphUnavailable).toBeUndefined();
      await chunkLayer.dispose();
    });

    it("should name why the rows inherited the index's graph data", async () => {
      const chunkLayer = layer();
      const view = await overlayWith(deltaReader(["src/a.ts"]), {
        treeGraph: graphSource(),
        deltaSignals: signalSource({ kind: "unavailable", reason: "building" }),
        deltaChunks: { layer: chunkLayer, resolveChunkerConfig: async () => CHUNKER_CONFIG },
      }).view(workingTree(), "proj");

      await view.readDeltaChunks?.();

      expect(view.marker.floors).toEqual([]);
      expect(view.marker.treeGraphUnavailable).toBe("building");
      await chunkLayer.dispose();
    });

    // bd tea-rags-mcp-xi2r9: the touched files' base points are read ONCE per
    // request and shared — hybrid's exclusion and the delta signals both ask
    // the view, and the view asks the reader once.
    it("should read the touched files' base points once per view and hand that read to the signal source", async () => {
      const chunkLayer = layer();
      const deltaSignals = signalSource(BUILT);
      const points = new Map([["src/a.ts", [{ id: "b1", payload: { relativePath: "src/a.ts" } }]]]);
      const touchedBasePoints = { pointsOf: vi.fn(async () => points) };
      const view = await overlayWith(deltaReader(["src/a.ts"], ["src/gone.ts"]), {
        deltaSignals,
        touchedBasePoints,
        deltaChunks: { layer: chunkLayer, resolveChunkerConfig: async () => CHUNKER_CONFIG },
      }).view(workingTree(), "proj");

      await view.readDeltaChunks?.();
      const [request] = deltaSignals.enrich.mock.calls[0];
      const fromRequest = await request.readTouchedBasePoints?.();
      const fromView = await view.readTouchedBasePoints?.();

      expect(fromRequest).toBe(points);
      expect(fromView).toBe(points);
      expect(touchedBasePoints.pointsOf).toHaveBeenCalledTimes(1);
      expect(touchedBasePoints.pointsOf).toHaveBeenCalledWith(
        COLLECTION,
        new Set(["src/a.ts", "src/gone.ts"]),
        "a".repeat(40),
      );
      await chunkLayer.dispose();
    });

    it("should return the layer's rows untouched when no signal source is wired", async () => {
      const chunkLayer = layer();
      const view = await overlayWith(deltaReader(["src/a.ts"]), {
        deltaChunks: { layer: chunkLayer, resolveChunkerConfig: async () => CHUNKER_CONFIG },
      }).view(workingTree(), "proj");

      const rows = await view.readDeltaChunks?.();

      expect(rows).toEqual([{ id: "id:src/a.ts", payload: { relativePath: "src/a.ts" } }]);
      await chunkLayer.dispose();
    });
  });
});

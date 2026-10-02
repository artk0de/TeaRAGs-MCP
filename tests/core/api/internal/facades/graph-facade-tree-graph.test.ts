/**
 * The graph tools answer for the working tree (bd tea-rags-mcp-xi2r9, WTO-7):
 * a view with a non-empty delta whose tree graph is `built` is read from the
 * TREE database — same read functions, other file — and the marker's `floors`
 * gains `"codegraph"`. An `unavailable` tree graph leaves the base answer and
 * names why; a clean tree never asks.
 *
 * Real DuckDB on both sides: the base graph and the tree graph are built by
 * the production provider from a tiny TypeScript fixture
 * (`buildTreeGraphFixture` + `buildWorkingTreeGraph`).
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { DuckDbGraphClient } from "../../../../../src/core/adapters/duckdb/client.js";
import { GraphFacade } from "../../../../../src/core/api/internal/facades/graph-facade.js";
import { TracePathOps } from "../../../../../src/core/api/internal/ops/trace-path-ops.js";
import type {
  WorkingTreeGraphReader,
  WorkingTreeGraphState,
  WorkingTreeMarker,
} from "../../../../../src/core/contracts/types/working-tree.js";
import type { WorkingTreeView } from "../../../../../src/core/domains/explore/working-tree/index.js";
import { buildWorkingTreeGraph } from "../../../../../src/core/domains/trajectory/codegraph/working-tree/tree-graph-build.js";
import {
  buildTreeGraphFixture,
  cleanupTreeGraphFixtures,
  LANGUAGE_MODULE_PATH,
  MIGRATIONS_MODULE_PATH,
  PHYSICAL,
  type TreeGraphFixture,
} from "../../../domains/trajectory/codegraph/working-tree/__helpers__/tree-graph-fixture.js";

const X_BASE = `export function x(): number {
  return 1;
}

export function y(): number {
  return 2;
}
`;
const A_BASE = `import { x } from "./x";

export function run(): number {
  return x();
}
`;
// The tree re-points run() at y(): the base says y has no callers.
const A_TREE = `import { y } from "./x";

export function run(): number {
  return y();
}
`;
const P_SRC = `import { q } from "./q";

export function p(): number {
  return q();
}
`;
const Q_BASE = `export function q(): number {
  return 1;
}
`;
// The tree closes a file cycle p.ts <-> q.ts the base does not have.
const Q_TREE = `import { p } from "./p";

export function q(): number {
  return p();
}
`;

const CHANGED = ["src/a.ts", "src/q.ts"];

function marker(changedFiles: number): WorkingTreeMarker {
  return {
    tree: "/tree",
    indexedCommit: "a".repeat(40),
    treeCommit: "b".repeat(40),
    indexedDirty: false,
    changedFiles,
    deletedFiles: 0,
    floors: [],
  };
}

describe("graph tools over the tree graph (WTO-7)", { timeout: 120_000 }, () => {
  let fixture: TreeGraphFixture;
  let treeDbPath: string;

  beforeAll(async () => {
    fixture = await buildTreeGraphFixture({
      "src/x.ts": X_BASE,
      "src/a.ts": A_BASE,
      "src/p.ts": P_SRC,
      "src/q.ts": Q_BASE,
    });
    fixture.writeTree("src/a.ts", A_TREE);
    fixture.writeTree("src/q.ts", Q_TREE);
    const built = await buildWorkingTreeGraph({
      snapshotPath: fixture.snapshotPath,
      outputRoot: fixture.outputRoot,
      physicalCollectionName: PHYSICAL,
      treeRoot: fixture.treeRoot,
      changedRelPaths: CHANGED,
      deletedRelPaths: [],
      providerConfig: { languageModulePath: LANGUAGE_MODULE_PATH, migrationsModulePath: MIGRATIONS_MODULE_PATH },
    });
    treeDbPath = built.dbPath;
  }, 120_000);

  afterAll(() => {
    cleanupTreeGraphFixtures();
  });

  const openReadOnly = async (path: string) => {
    const graphDb = new DuckDbGraphClient({ path, accessMode: "READ_ONLY" });
    await graphDb.init();
    return { graphDb, symbolTable: {} as never };
  };

  /** The base graph is the fixture snapshot; any other file is opened as asked. */
  const pool = () => ({
    acquireReader: vi.fn(async () => openReadOnly(fixture.snapshotPath)),
    acquireFileReader: vi.fn(async (dbPath: string) => openReadOnly(dbPath)),
    hasDatabase: vi.fn(() => true),
  });

  const built = (): WorkingTreeGraphState => ({ kind: "built", dbPath: treeDbPath, physicalCollectionName: PHYSICAL });

  /** A view of the fixture's delta whose tree graph answers `state`; `null` → a clean tree. */
  const overlayAnswering = (state: WorkingTreeGraphState | null) => {
    const readTreeGraph = vi.fn<WorkingTreeGraphReader>(async () => state as WorkingTreeGraphState);
    const view = (): WorkingTreeView => ({
      marker: marker(state ? CHANGED.length : 0),
      touchedPaths: new Set(state ? CHANGED : []),
      deletedPaths: new Set(),
      ...(state ? { readTreeGraph } : {}),
    });
    return { overlay: { view: vi.fn(async () => view()) }, readTreeGraph };
  };

  const facadeWith = (state: WorkingTreeGraphState | null) => {
    const { overlay, readTreeGraph } = overlayAnswering(state);
    const graphPool = pool();
    const facade = new GraphFacade({
      pool: graphPool as never,
      collectionRegistry: {} as never,
      resolveActiveCollection: async () => PHYSICAL,
      workingTreeOverlay: overlay,
    });
    return { facade, readTreeGraph, graphPool };
  };

  describe("a built tree graph", () => {
    it("get_callers answers the tree's callers and marks the codegraph floor", async () => {
      const { facade, readTreeGraph } = facadeWith(built());

      const response = await facade.getCallers({ collection: "code_x", symbolId: "y" });

      expect(response.callers.map((c) => `${c.sourceRelPath}#${c.sourceSymbolId}`)).toContain("src/a.ts#run");
      expect(response.workingTree?.floors).toEqual(["codegraph"]);
      expect(response.workingTree?.treeGraphUnavailable).toBeUndefined();
      expect(readTreeGraph).toHaveBeenCalledWith(120_000);
    });

    it("get_callees answers the tree's callees", async () => {
      const { facade } = facadeWith(built());

      const response = await facade.getCallees({ collection: "code_x", symbolId: "run" });

      const targets = response.callees.map((c) => `${c.targetRelPath}#${c.targetSymbolId}`);
      expect(targets).toContain("src/x.ts#y");
      expect(targets).not.toContain("src/x.ts#x");
      expect(response.workingTree?.floors).toEqual(["codegraph"]);
    });

    it("file-scoped get_callers answers the tree's importers", async () => {
      const { facade } = facadeWith(built());

      const response = await facade.getCallers({ collection: "code_x", relativePath: "src/p.ts" });

      expect(JSON.stringify(response)).toContain("src/q.ts");
      expect(response.workingTree?.floors).toEqual(["codegraph"]);
    });

    it("find_cycles sees the cycle only the tree closes", async () => {
      const { facade } = facadeWith(built());

      const response = await facade.findCycles({ collection: "code_x", scope: "file" });

      expect(response.cycles.map((c) => [...c.members].sort())).toContainEqual(["src/p.ts", "src/q.ts"]);
      expect(response.workingTree?.floors).toEqual(["codegraph"]);
    });

    it("get_architecture_report reads the tree graph and carries the marker", async () => {
      const { facade, graphPool } = facadeWith(built());

      const response = await facade.getArchitectureReport({ collection: "code_x" });

      expect(graphPool.acquireFileReader).toHaveBeenCalledWith(treeDbPath);
      expect(graphPool.acquireReader).not.toHaveBeenCalled();
      expect(response.workingTree?.floors).toEqual(["codegraph"]);
    });

    it("trace_path walks the tree's edges", async () => {
      const { overlay } = overlayAnswering(built());
      const ops = new TracePathOps({
        pool: pool() as never,
        qdrant: { scrollBySymbolIds: vi.fn(async () => []) } as never,
        reranker: {} as never,
        collectionRegistry: {} as never,
        resolveActiveCollection: async () => PHYSICAL,
        workingTreeOverlay: overlay,
      });

      const response = await ops.tracePath({ collection: "code_x", from: "run", to: "y" });

      expect(response.paths).toHaveLength(1);
      expect(response.workingTree?.floors).toEqual(["codegraph"]);
    });

    it("resolveSymbolChunk and getSymbolVisibilities read the tree graph when handed its reader", async () => {
      const { facade, graphPool } = facadeWith(built());
      const reader: WorkingTreeGraphReader = async () => built();

      await facade.getSymbolVisibilities({ collection: "code_x" }, ["run"], reader);
      await facade.resolveSymbolChunk({ collection: "code_x" }, "run", reader);

      expect(graphPool.acquireFileReader).toHaveBeenCalledTimes(2);
      expect(graphPool.acquireReader).not.toHaveBeenCalled();
    });
  });

  describe("an unavailable tree graph", () => {
    it("answers from the base graph and names why", async () => {
      const { facade, graphPool } = facadeWith({ kind: "unavailable", reason: "building" });

      const response = await facade.getCallers({ collection: "code_x", symbolId: "y" });

      expect(response.callers.map((c) => c.sourceSymbolId)).not.toContain("run");
      expect(response.workingTree?.floors).toEqual([]);
      expect(response.workingTree?.treeGraphUnavailable).toBe("building");
      expect(graphPool.acquireFileReader).not.toHaveBeenCalled();
    });

    it("trace_path answers from the base graph and names why", async () => {
      const { overlay } = overlayAnswering({ kind: "unavailable", reason: "codegraph is disabled" });
      const ops = new TracePathOps({
        pool: pool() as never,
        qdrant: { scrollBySymbolIds: vi.fn(async () => []) } as never,
        reranker: {} as never,
        collectionRegistry: {} as never,
        resolveActiveCollection: async () => PHYSICAL,
        workingTreeOverlay: overlay,
      });

      const response = await ops.tracePath({ collection: "code_x", from: "run", to: "y" });

      expect(response.paths).toEqual([]);
      expect(response.workingTree?.treeGraphUnavailable).toBe("codegraph is disabled");
    });
  });

  describe("a clean tree", () => {
    it("answers from the base graph without asking for a tree graph", async () => {
      const { facade, readTreeGraph, graphPool } = facadeWith(null);

      const response = await facade.getCallees({ collection: "code_x", symbolId: "run" });

      expect(response.callees.map((c) => c.targetSymbolId)).toContain("x");
      expect(response.workingTree?.floors).toEqual([]);
      expect(response.workingTree?.treeGraphUnavailable).toBeUndefined();
      expect(readTreeGraph).not.toHaveBeenCalled();
      expect(graphPool.acquireFileReader).not.toHaveBeenCalled();
    });
  });
});

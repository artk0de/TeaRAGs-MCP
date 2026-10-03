/**
 * One answer deadline per view (bd tea-rags-mcp-xi2r9): every SEARCH-side wait
 * a request makes on a tree layer — the warm wait, the tree-graph lookups, the
 * dense vectors — draws from one budget, `WORKING_TREE_ANSWER_BUDGET_MS`,
 * counted from the view's creation. Live: a cold find_symbol outline on a
 * 1419-file delta waited 2.3 s warming, then 3 s for the graph twice in series
 * (7.2 s). The tree-graph build is requested before the warm wait, so it runs
 * while the delta warms. Waits are driven by a fake clock, never wall time.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  WORKING_TREE_ANSWER_BUDGET_MS,
  WORKING_TREE_SEARCH_GRAPH_WAIT_MS,
  WORKING_TREE_WARM_WAIT_MS,
  type WorkingTree,
  type WorkingTreeDeltaSignalSource,
  type WorkingTreeGraphSource,
  type WorkingTreeGraphState,
} from "../../../../../src/core/contracts/types/working-tree.js";
import type { ScrollChunk } from "../../../../../src/core/domains/explore/chunk-grouping/types.js";
import {
  createWorkingTreeChunkLayer,
  recordingTreeGraphReader,
  WorkingTreeOverlay,
  type WorkingTreeDeltaReader,
  type WorkingTreeDeltaWarmState,
  type WorkingTreeOverlayDeps,
} from "../../../../../src/core/domains/explore/working-tree/index.js";

const COLLECTION = "code_answer_deadline";
const BUILDING: WorkingTreeGraphState = { kind: "unavailable", reason: "tree graph still building" };
const BUILT: WorkingTreeGraphState = {
  kind: "built",
  dbPath: "/graphs/tree.duckdb",
  physicalCollectionName: "code_answer_deadline_v1" as never,
};

describe("WorkingTreeOverlay answer deadline", () => {
  let root: string;
  let clock: number;
  const now = (): number => clock;

  beforeEach(() => {
    clock = 1_000_000;
    root = mkdtempSync(join(tmpdir(), "wto-deadline-"));
    mkdirSync(join(root, "src"));
    writeFileSync(join(root, "src/a.ts"), "export const a = 1;\n");
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  const workingTree = (): WorkingTree => ({ root, baseIndex: { collectionName: COLLECTION, root } });
  const registry = { get: () => ({ git: { indexedCommit: "a".repeat(40), indexedDirty: false } }) } as never;
  const deltaReader: WorkingTreeDeltaReader = {
    read: async () => ({ kind: "measured", delta: { changed: ["src/a.ts"], deleted: [], fingerprint: "fp" } }),
  };
  const row: ScrollChunk = { id: "tree:a", payload: { relativePath: "src/a.ts" } };
  const warmState: WorkingTreeDeltaWarmState = {
    rows: [row],
    warmPaths: new Set(["src/a.ts"]),
    unparsed: [],
    pending: [],
    storeKeys: new Map(),
  };

  /** A graph source whose every wait spends the clock it is given, then says building. */
  const spendingGraphSource = () => ({
    graphFor: vi.fn<WorkingTreeGraphSource["graphFor"]>(async (_request, waitMs) => {
      clock += waitMs;
      return BUILDING;
    }),
  });

  const overlayWith = (deps: Partial<WorkingTreeOverlayDeps>): WorkingTreeOverlay => {
    const layer = createWorkingTreeChunkLayer({
      createPool: () => ({ shutdown: async () => undefined }),
      chunkFile: async () => [],
    });
    return new WorkingTreeOverlay({
      registry,
      deltaReader,
      createFileFilter: async () => () => true,
      deltaChunks: { layer, resolveChunkerConfig: async () => ({ chunkSize: 2500, chunkOverlap: 300 }) },
      now,
      ...deps,
    });
  };

  it("should document the answer budget as the search graph wait", () => {
    expect(WORKING_TREE_ANSWER_BUDGET_MS).toBe(3_000);
  });

  it("should count the view's remaining wait down from the answer budget, never below zero", async () => {
    const view = await overlayWith({}).view(workingTree(), "proj");

    expect(view.remainingWaitMs?.()).toBe(WORKING_TREE_ANSWER_BUDGET_MS);
    clock += 1_000;
    expect(view.remainingWaitMs?.()).toBe(WORKING_TREE_ANSWER_BUDGET_MS - 1_000);
    clock += 10_000;
    expect(view.remainingWaitMs?.()).toBe(0);
  });

  it("should request the tree-graph build before the warm wait starts", async () => {
    const treeGraph = spendingGraphSource();
    let graphRequestsAtWarm = -1;
    const warmer = {
      warm: vi.fn(async () => {
        graphRequestsAtWarm = treeGraph.graphFor.mock.calls.length;
        return warmState;
      }),
    };

    await overlayWith({ treeGraph, warmer }).view(workingTree(), "proj");

    expect(graphRequestsAtWarm).toBe(1);
    expect(treeGraph.graphFor.mock.calls[0][1]).toBe(0);
    expect(treeGraph.graphFor).toHaveBeenCalledTimes(1);
  });

  it("should clamp the warm wait to the answer budget", async () => {
    const warmer = { warm: vi.fn(async () => warmState) };

    await overlayWith({ warmer, warmWaitMs: 5_000, answerBudgetMs: 1_200 }).view(workingTree(), "proj");

    expect(warmer.warm.mock.calls[0][1]).toBeLessThanOrEqual(1_200);
  });

  it("should keep the warm wait's own cap when the budget is larger", async () => {
    const warmer = { warm: vi.fn(async () => warmState) };

    await overlayWith({ warmer }).view(workingTree(), "proj");

    expect(warmer.warm.mock.calls[0][1]).toBeLessThanOrEqual(WORKING_TREE_WARM_WAIT_MS);
  });

  it("should give a lookup after the warm wait only what is left of the budget", async () => {
    const treeGraph = spendingGraphSource();
    const warmer = {
      warm: vi.fn(async (_request: unknown, budgetMs: number) => {
        clock += budgetMs;
        return warmState;
      }),
    };
    const view = await overlayWith({ treeGraph, warmer }).view(workingTree(), "proj");

    await recordingTreeGraphReader(view)?.(WORKING_TREE_SEARCH_GRAPH_WAIT_MS);

    const warmWait = warmer.warm.mock.calls[0][1];
    const graphWait = treeGraph.graphFor.mock.calls[1][1];
    expect(warmWait).toBe(WORKING_TREE_WARM_WAIT_MS);
    expect(warmWait + graphWait).toBeLessThanOrEqual(WORKING_TREE_ANSWER_BUDGET_MS);
    expect(view.marker.treeGraphUnavailable).toBe(BUILDING.reason);
  });

  it("should give two lookups of one request no more than the budget together", async () => {
    const treeGraph = spendingGraphSource();
    const view = await overlayWith({ treeGraph }).view(workingTree(), "proj");
    const lookup = recordingTreeGraphReader(view);

    await lookup?.(120_000);
    await lookup?.(120_000);

    const waits = treeGraph.graphFor.mock.calls.slice(1).map(([, waitMs]) => waitMs);
    expect(waits).toEqual([WORKING_TREE_ANSWER_BUDGET_MS, 0]);
    expect(view.marker.treeGraphUnavailable).toBe(BUILDING.reason);
  });

  it("should answer built at a spent budget when the warm-up already found the graph built", async () => {
    const treeGraph = {
      graphFor: vi.fn<WorkingTreeGraphSource["graphFor"]>(async (_request, waitMs) =>
        waitMs === 0 && treeGraph.graphFor.mock.calls.length > 1 ? BUILDING : BUILT,
      ),
    };
    const view = await overlayWith({ treeGraph }).view(workingTree(), "proj");
    await new Promise((resolve) => setImmediate(resolve));
    clock += WORKING_TREE_ANSWER_BUDGET_MS;

    const state = await recordingTreeGraphReader(view)?.(WORKING_TREE_SEARCH_GRAPH_WAIT_MS);

    expect(state).toEqual(BUILT);
    expect(view.treeGraphLookup).toEqual(BUILT);
  });

  it("should leave the graph tools' raw reader unclamped", async () => {
    const treeGraph = spendingGraphSource();
    const view = await overlayWith({ treeGraph }).view(workingTree(), "proj");
    clock += WORKING_TREE_ANSWER_BUDGET_MS;

    await view.readTreeGraph?.(130_000);

    expect(treeGraph.graphFor).toHaveBeenLastCalledWith(expect.anything(), 130_000);
  });

  it("should clamp the dense wait to what is left of the budget", async () => {
    const waits: number[] = [];
    const denseVectors = {
      warm: vi.fn(() => async (waitMs: number) => {
        waits.push(waitMs);
        return { vectors: new Map(), pending: 0 };
      }),
    };
    const warmer = { warm: vi.fn(async () => warmState) };
    const view = await overlayWith({ denseVectors, warmer }).view(workingTree(), "proj");
    clock += 2_500;

    await view.readDeltaVectors?.(2_000);
    clock += 1_000;
    await view.readDeltaVectors?.(2_000);

    expect(waits).toEqual([WORKING_TREE_ANSWER_BUDGET_MS - 2_500, 0]);
  });

  it("should hand the delta-row signal source the view's remaining wait", async () => {
    const remaining: number[] = [];
    const deltaSignals: WorkingTreeDeltaSignalSource = {
      enrich: vi.fn(async (request) => {
        remaining.push(request.remainingWaitMs?.() ?? -1);
        return { rows: [...request.rows] };
      }),
    };
    const warmer = { warm: vi.fn(async () => warmState) };
    const treeGraph = spendingGraphSource();
    const view = await overlayWith({ deltaSignals, warmer, treeGraph }).view(workingTree(), "proj");
    clock += 1_800;

    await view.signalDeltaRows?.([row]);

    expect(remaining).toEqual([WORKING_TREE_ANSWER_BUDGET_MS - 1_800]);
  });
});

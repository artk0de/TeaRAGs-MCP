/**
 * GraphFacade#getArchitectureReport snapshot cache (bd tea-rags-mcp-00309):
 * a judged report is held in memory under a `reportId`, so a paging call that
 * passes it re-shapes the held runs — no detector run, no DuckDB read. A held
 * report the current tree no longer matches, an expired one, or an evicted one
 * answers `reportStale` instead of mixing a fresh report with old pages.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import type { GraphDbClientPool } from "../../../../../src/core/adapters/duckdb/pool.js";
import { GraphFacade } from "../../../../../src/core/api/internal/facades/graph-facade.js";
import type { FileDependencyGraph } from "../../../../../src/core/contracts/types/codegraph.js";
import type { WorkingTreeMarker } from "../../../../../src/core/contracts/types/working-tree.js";

function file(relPath: string) {
  return { relPath, language: "typescript", symbolCount: 1 };
}

/**
 * Two uphill Stable Dependencies violations (core → lib, base → lib): `core/`
 * and `base/` are imported by six files each, `lib/` imports `vendor/`.
 */
function graph(): FileDependencyGraph {
  const files = [file("core/a.ts"), file("core/b.ts"), file("base/a.ts"), file("other/o.ts"), file("vendor/v.ts")];
  const edges: FileDependencyGraph["edges"] = [];
  const add = (sourceRelPath: string, targetRelPath: string, callWeight = 1) => {
    edges.push({ sourceRelPath, targetRelPath, callWeight });
  };
  add("core/a.ts", "lib/f1.ts", 2);
  add("core/b.ts", "lib/f2.ts");
  add("base/a.ts", "lib/f4.ts", 3);
  add("other/o.ts", "lib/f3.ts");
  for (let i = 1; i <= 6; i++) {
    files.push(file(`app/c${i}.ts`), file(`users/u${i}.ts`));
    add(`app/c${i}.ts`, "core/b.ts");
    add(`users/u${i}.ts`, "base/a.ts");
  }
  for (let i = 1; i <= 5; i++) {
    files.push(file(`lib/f${i}.ts`));
    add(`lib/f${i}.ts`, "vendor/v.ts");
  }
  add("lib/f5.ts", "core/a.ts");
  return { files, edges };
}

const MARKER: WorkingTreeMarker = {
  tree: "/repo",
  indexedCommit: "c1",
  treeCommit: "c1",
  indexedDirty: false,
  changedFiles: 0,
  deletedFiles: 0,
  floors: [],
};

function makeFacade() {
  const graphDb = {
    readFileDependencyGraph: vi.fn().mockResolvedValue(graph()),
    readNonPublicMemberEdges: vi.fn().mockResolvedValue([]),
    readTemporalCochangeGraph: vi.fn().mockResolvedValue({ meta: null, edges: [] }),
    close: vi.fn().mockResolvedValue(undefined),
  };
  const acquireReader = vi.fn().mockResolvedValue({ graphDb, symbolTable: {} });
  let marker: WorkingTreeMarker = MARKER;
  const view = vi.fn(async () => ({
    marker: { ...marker, floors: [...marker.floors] },
    touchedPaths: new Set<string>(),
    deletedPaths: new Set<string>(),
  }));
  const facade = new GraphFacade({
    pool: { acquireReader, peek: vi.fn() } as unknown as GraphDbClientPool,
    collectionRegistry: {} as never,
    workingTreeOverlay: { view },
  });
  return {
    facade,
    graphDb,
    acquireReader,
    view,
    editTree: (next: Partial<WorkingTreeMarker>) => {
      marker = { ...marker, ...next };
    },
  };
}

describe("GraphFacade#getArchitectureReport snapshot cache", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("runs the detectors once across a first call and two paging calls that pass its reportId", async () => {
    const { facade, graphDb, acquireReader, view } = makeFacade();

    const first = await facade.getArchitectureReport({ collection: "code_x", limit: 1 });
    expect(first.reportId).toEqual(expect.any(String));
    const second = await facade.getArchitectureReport({
      collection: "code_x",
      limit: 1,
      offset: 1,
      reportId: first.reportId,
    });
    const third = await facade.getArchitectureReport({
      collection: "code_x",
      limit: 1,
      offset: 2,
      reportId: first.reportId,
    });

    expect(graphDb.readFileDependencyGraph).toHaveBeenCalledTimes(1);
    expect(acquireReader).toHaveBeenCalledTimes(1);
    // One tree measurement per call serves both the key and the read.
    expect(view).toHaveBeenCalledTimes(3);
    expect(second.reportId).toBe(first.reportId);
    expect(second.empty).toBeUndefined();
    expect(third.empty).toBeUndefined();
    expect(second.workingTree).toEqual(MARKER);
  });

  it("pages violations by offset into disjoint slices in the unpaged order", async () => {
    const { facade } = makeFacade();

    const whole = await facade.getArchitectureReport({ collection: "code_x" });
    const sdp = (r: { violations: Record<string, unknown[] | undefined> }) => r.violations.stableDependencies ?? [];
    expect(sdp(whole)).toHaveLength(2);

    const page0 = await facade.getArchitectureReport({ collection: "code_x", limit: 1, reportId: whole.reportId });
    const page1 = await facade.getArchitectureReport({
      collection: "code_x",
      limit: 1,
      offset: 1,
      reportId: whole.reportId,
    });
    const page2 = await facade.getArchitectureReport({
      collection: "code_x",
      limit: 1,
      offset: 2,
      reportId: whole.reportId,
    });

    expect([...sdp(page0), ...sdp(page1)]).toEqual(sdp(whole));
    expect(sdp(page0)).not.toEqual(sdp(page1));
    expect(sdp(page2)).toEqual([]);
  });

  it("pages violations by offset on a fresh call too", async () => {
    const { facade } = makeFacade();

    const whole = await facade.getArchitectureReport({ collection: "code_x" });
    const page1 = await facade.getArchitectureReport({ collection: "code_x", limit: 1, offset: 1 });

    const sdp = (r: { violations: Record<string, unknown[] | undefined> }) => r.violations.stableDependencies ?? [];
    expect(sdp(page1)).toEqual(sdp(whole).slice(1, 2));
  });

  it("answers reportStale when the working tree changed since the report was judged", async () => {
    const { facade, graphDb, editTree } = makeFacade();

    const first = await facade.getArchitectureReport({ collection: "code_x" });
    editTree({ changedFiles: 1, indexedDirty: true });
    const paged = await facade.getArchitectureReport({ collection: "code_x", offset: 1, reportId: first.reportId });

    expect(paged.empty).toEqual({ reason: "reportStale", message: expect.stringContaining("without reportId") });
    expect(paged.violations).toEqual({});
    expect(paged.reportId).toBeUndefined();
    expect(graphDb.readFileDependencyGraph).toHaveBeenCalledTimes(1);
  });

  it("answers reportStale when the reportId was judged under another scope", async () => {
    const { facade } = makeFacade();

    const first = await facade.getArchitectureReport({ collection: "code_x" });
    const paged = await facade.getArchitectureReport({
      collection: "code_x",
      pathPattern: "core/**",
      reportId: first.reportId,
    });

    expect(paged.empty?.reason).toBe("reportStale");
  });

  it("answers reportStale for an unknown reportId", async () => {
    const { facade, graphDb } = makeFacade();

    const paged = await facade.getArchitectureReport({ collection: "code_x", reportId: "nope" });

    expect(paged.empty?.reason).toBe("reportStale");
    expect(graphDb.readFileDependencyGraph).not.toHaveBeenCalled();
  });

  it("answers reportStale once the held report outlives its TTL", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const { facade } = makeFacade();

    const first = await facade.getArchitectureReport({ collection: "code_x" });
    vi.setSystemTime(Date.now() + 9 * 60_000);
    const fresh = await facade.getArchitectureReport({ collection: "code_x", reportId: first.reportId });
    vi.setSystemTime(Date.now() + 2 * 60_000);
    const expired = await facade.getArchitectureReport({ collection: "code_x", reportId: first.reportId });

    expect(fresh.empty).toBeUndefined();
    expect(expired.empty?.reason).toBe("reportStale");
  });

  it("answers reportStale once eight newer reports evicted the held one", async () => {
    const { facade } = makeFacade();

    const first = await facade.getArchitectureReport({ collection: "code_x" });
    for (let i = 0; i < 8; i++) {
      await facade.getArchitectureReport({ collection: "code_x", pathPattern: `p${i}/**` });
    }
    const evicted = await facade.getArchitectureReport({ collection: "code_x", reportId: first.reportId });

    expect(evicted.empty?.reason).toBe("reportStale");
  });

  it("keeps eight reports: the oldest of eight is still served", async () => {
    const { facade } = makeFacade();

    const first = await facade.getArchitectureReport({ collection: "code_x" });
    for (let i = 0; i < 7; i++) {
      await facade.getArchitectureReport({ collection: "code_x", pathPattern: `p${i}/**` });
    }
    const held = await facade.getArchitectureReport({ collection: "code_x", reportId: first.reportId });

    expect(held.empty).toBeUndefined();
  });
});

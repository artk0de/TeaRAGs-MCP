/**
 * `get_ontology_report` answers for the working tree (live D9, bd
 * tea-rags-mcp-xi2r9): its identifiers are read from the TREE graph when that
 * is built — the tree's declarations, not the index commit's — and from the
 * index graph otherwise, with `treeGraphUnavailable` saying why. Every return
 * path carries the `workingTree` marker, the unreadable-graph notice included.
 */

import { describe, expect, it, vi } from "vitest";

import { OntologyReportOps } from "../../../../../src/core/api/internal/ops/ontology-report-ops.js";
import type { OntologyReportRows } from "../../../../../src/core/contracts/types/codegraph.js";
import type { WorkingTreeGraphState, WorkingTreeMarker } from "../../../../../src/core/contracts/types/working-tree.js";
import type { WorkingTreeView } from "../../../../../src/core/domains/explore/working-tree/index.js";

const MARKER: WorkingTreeMarker = {
  tree: "/tree",
  indexedCommit: "a".repeat(40),
  treeCommit: "b".repeat(40),
  indexedDirty: false,
  changedFiles: 1,
  deletedFiles: 0,
  floors: [],
};

const BUILT: WorkingTreeGraphState = {
  kind: "built",
  dbPath: "/graphs/tree.duckdb",
  physicalCollectionName: "c" as never,
};

/** A graph whose every read answers `evidenceRows` — so the answer names the graph it came from. */
function graphDb(evidenceRows: number) {
  const rows: OntologyReportRows = {
    totals: { identifierRows: evidenceRows, symbolRows: 1 },
    evidenceRows,
    genericNameCount: 0,
    genericNames: [],
    synonyms: [],
    homonyms: [],
    outlierGroups: [],
    collisions: [],
  };
  return {
    readOntologyReportSummary: vi.fn(async () => rows),
    readOntologyReportSections: vi.fn(async () => rows),
    close: vi.fn(async () => undefined),
  };
}

function makeOps(view: WorkingTreeView, options: { baseFails?: boolean } = {}) {
  const pool = {
    acquireReader: options.baseFails
      ? vi.fn(async () => {
          throw new Error("lock held");
        })
      : vi.fn(async () => ({ graphDb: graphDb(1), symbolTable: {} })),
    acquireFileReader: vi.fn(async () => ({ graphDb: graphDb(2), symbolTable: {} })),
  };
  const ops = new OntologyReportOps({
    pool: pool as never,
    collectionRegistry: {} as never,
    resolveActiveCollection: async (n: string) => n as never,
    languages: [],
    workingTreeOverlay: { view: vi.fn(async () => view) },
  });
  return { ops, pool };
}

const viewAnswering = (state: WorkingTreeGraphState | null): WorkingTreeView => ({
  marker: { ...MARKER, floors: [], changedFiles: state ? 1 : 0 },
  touchedPaths: new Set(state ? ["src/a.ts"] : []),
  deletedPaths: new Set(),
  ...(state ? { readTreeGraph: vi.fn(async () => state) } : {}),
});

describe("OntologyReportOps on a working tree (D9)", () => {
  it("reads the tree graph's identifiers when it is built and claims the codegraph floor", async () => {
    const { ops, pool } = makeOps(viewAnswering(BUILT));

    const response = await ops.report({ collection: "code_x" });

    expect(response.summary.evidenceRows).toBe(2);
    expect(pool.acquireFileReader).toHaveBeenCalledWith(BUILT.dbPath);
    expect(pool.acquireReader).not.toHaveBeenCalled();
    expect(response.workingTree?.floors).toEqual(["codegraph"]);
  });

  it("reads the index graph and names why when the tree graph is unavailable", async () => {
    const { ops, pool } = makeOps(viewAnswering({ kind: "unavailable", reason: "building" }));

    const response = await ops.report({ collection: "code_x" });

    expect(response.summary.evidenceRows).toBe(1);
    expect(pool.acquireFileReader).not.toHaveBeenCalled();
    expect(response.workingTree?.floors).toEqual([]);
    expect(response.workingTree?.treeGraphUnavailable).toBe("building");
  });

  it("reads the index graph for a clean tree and carries its marker", async () => {
    const { ops } = makeOps(viewAnswering(null));

    const response = await ops.report({ collection: "code_x" });

    expect(response.summary.evidenceRows).toBe(1);
    expect(response.workingTree).toEqual({ ...MARKER, changedFiles: 0 });
  });

  it("carries the marker beside the notice when the index graph cannot be opened", async () => {
    const { ops } = makeOps(viewAnswering(null), { baseFails: true });

    const response = await ops.report({ collection: "code_x" });

    expect(response.notices).toEqual(["codegraph store unavailable: lock held"]);
    expect(response.workingTree?.tree).toBe("/tree");
  });
});

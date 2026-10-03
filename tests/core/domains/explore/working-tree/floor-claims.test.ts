/**
 * Floors are claimed by tree data that REACHED the answer (live round-3 D1, bd
 * tea-rags-mcp-xi2r9): a strategy that read the tree's rows and admitted none
 * of them into its candidates — the request filter, the exact pathPattern or
 * the scroll predicate refused every one — answered from the index alone, so
 * its marker claims no floor, and the rows' tree-graph provenance does not
 * reach it either. Live: hybrid_search `language: "ruby"` on a TypeScript
 * delta answered `[]` with `floors: ["chunks","sparse","codegraph"]` while
 * semantic_search with the same filter answered `[]` with `floors: []`.
 */

import { describe, expect, it, vi } from "vitest";

import { codeRow, fakeWorkingTreeView } from "../__fixtures__/working-tree-view.js";
import type { QdrantManager } from "../../../../../src/core/adapters/qdrant/client.js";
import type { PayloadSignalDescriptor } from "../../../../../src/core/contracts/types/trajectory.js";
import type { Reranker } from "../../../../../src/core/domains/explore/reranker.js";
import { FileOutlineStrategy } from "../../../../../src/core/domains/explore/strategies/file-outline.js";
import { HybridSearchStrategy } from "../../../../../src/core/domains/explore/strategies/hybrid.js";
import { ScrollRankStrategy } from "../../../../../src/core/domains/explore/strategies/scroll-rank.js";
import { SymbolSearchStrategy } from "../../../../../src/core/domains/explore/strategies/symbol.js";
import {
  claimWorkingTreeFloors,
  type WorkingTreeView,
} from "../../../../../src/core/domains/explore/working-tree/index.js";

const TOUCHED = "src/retry.ts";
const BUILT_GRAPH = { kind: "built", dbPath: "/g.duckdb", physicalCollectionName: "code_x_v1" } as const;

const retryRow = codeRow("t-retry", {
  relativePath: TOUCHED,
  symbolId: "retryWithBackoff",
  content: "export function retryWithBackoff(attempts: number) { return attempts; }",
});

/** A tree that changed one TypeScript file, whose enriched rows carry the built tree graph's codegraph block. */
function treeView(): WorkingTreeView {
  const view = fakeWorkingTreeView({ changed: [TOUCHED], rows: [retryRow] });
  view.deltaRowsTreeGraph = BUILT_GRAPH as never;
  return view;
}

const passthroughReranker = { rerank: vi.fn((r: unknown[]) => r) } as unknown as Reranker;

describe("claimWorkingTreeFloors claims only what reached the answer", () => {
  it("claims nothing — floors nor tree-graph provenance — when no delta row was admitted", () => {
    const view = treeView();

    claimWorkingTreeFloors(view, ["chunks", "sparse"], 0);

    expect(view.marker.floors).toEqual([]);
    expect(view.marker.treeGraphUnavailable).toBeUndefined();
  });

  it("claims the floors and the rows' graph once a delta row was admitted", () => {
    const view = treeView();

    claimWorkingTreeFloors(view, ["chunks", "sparse"], 1);

    expect(view.marker.floors).toEqual(["chunks", "sparse", "codegraph"]);
  });
});

describe("strategies claim no floor when the request admitted none of the tree's rows", () => {
  it("hybrid_search: a language filter no delta row passes", async () => {
    const qdrant = {
      getCollectionInfo: vi.fn().mockResolvedValue({ hybridEnabled: true, pointsCount: 0 }),
      hybridSearch: vi.fn().mockResolvedValue([]),
      scrollFiltered: vi.fn().mockResolvedValue([]),
    } as unknown as QdrantManager;
    const view = treeView();

    const results = await new HybridSearchStrategy(qdrant, passthroughReranker, [], []).execute({
      collectionName: "c",
      embedding: [0.1, 0.2],
      query: "retry",
      limit: 5,
      filter: { must: [{ key: "language", match: { value: "ruby" } }] },
      workingTreeView: view,
    });

    expect(results).toEqual([]);
    expect(view.marker.floors).toEqual([]);
  });

  it("hybrid_search: a query no delta row scores on any leg", async () => {
    const qdrant = {
      getCollectionInfo: vi.fn().mockResolvedValue({ hybridEnabled: true, pointsCount: 0 }),
      hybridSearch: vi.fn().mockResolvedValue([]),
      scrollFiltered: vi.fn().mockResolvedValue([]),
    } as unknown as QdrantManager;
    const view = treeView();

    const results = await new HybridSearchStrategy(qdrant, passthroughReranker, [], []).execute({
      collectionName: "c",
      embedding: [0.1, 0.2],
      query: "zzzunrelatedzzz",
      limit: 5,
      workingTreeView: view,
    });

    expect(results).toEqual([]);
    expect(view.marker.floors).toEqual([]);
  });

  it("find_symbol: a symbol the tree's rows do not hold", async () => {
    const qdrant = { scrollFiltered: vi.fn().mockResolvedValue([]) } as unknown as QdrantManager;
    const registry = { buildMergedFilter: vi.fn().mockReturnValue(undefined) } as never;
    const view = treeView();

    const results = await new SymbolSearchStrategy(qdrant, passthroughReranker, [], [], registry, {
      symbol: "absentEverywhere",
    }).execute({ collectionName: "c", limit: 50, workingTreeView: view });

    expect(results).toEqual([]);
    expect(view.marker.floors).toEqual([]);
  });

  it("find_symbol outline: a file the tree's rows do not belong to", async () => {
    const qdrant = { scrollFiltered: vi.fn().mockResolvedValue([]) } as unknown as QdrantManager;
    const view = treeView();

    const results = await new FileOutlineStrategy(qdrant, passthroughReranker, [], [], {
      relativePath: "src/other.ts",
    }).execute({ collectionName: "c", limit: 1, workingTreeView: view });

    expect(results).toEqual([]);
    expect(view.marker.floors).toEqual([]);
  });

  it("rank_chunks: a filter no delta row passes", async () => {
    const methodLines: PayloadSignalDescriptor = { key: "methodLines", type: "number", description: "lines" };
    const reranker = {
      rerank: vi.fn((r: unknown[]) => r),
      getDescriptors: vi
        .fn()
        .mockReturnValue([
          { name: "chunkSize", description: "s", sources: ["methodLines"], defaultBound: 1, extract: () => 1 },
        ]),
      getPreset: vi.fn().mockReturnValue({ chunkSize: 1 }),
      getFullPreset: vi.fn().mockReturnValue(undefined),
    } as unknown as Reranker;
    const qdrant = {
      scrollOrdered: vi.fn().mockResolvedValue([]),
      ensurePayloadIndex: vi.fn().mockResolvedValue(true),
    } as unknown as QdrantManager;
    const view = treeView();

    const results = await new ScrollRankStrategy(qdrant, reranker, [methodLines], []).execute({
      collectionName: "c",
      limit: 10,
      weights: { chunkSize: 1 },
      filter: { must: [{ key: "language", match: { value: "ruby" } }] },
      workingTreeView: view,
    });

    expect(results).toEqual([]);
    expect(view.marker.floors).toEqual([]);
  });
});

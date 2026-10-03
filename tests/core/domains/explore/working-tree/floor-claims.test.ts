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
import type { WorkingTreeGraphReader } from "../../../../../src/core/contracts/types/working-tree.js";
import type { ScrollChunk } from "../../../../../src/core/domains/explore/chunk-grouping/types.js";
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

/**
 * Search/symbol tools claim `codegraph` only when a RETURNED row carries data
 * the tree graph derived (live round-4 B1, bd tea-rags-mcp-xi2r9): a lookup
 * that read the built tree graph — find_symbol's tree definitions and chunk
 * hop, an outline's visibility — and answered nothing, or answered a row of a
 * file the tree did not change (whose graph data is the index's), claims no
 * floor. Graph tools keep claiming it on any answer the tree graph computed.
 * Live on r3t: `find_symbol noSuchSymbolXyzzy` answered `[]` with
 * `["codegraph"]`; the outline of the unchanged `src/zoo/dog.ts` claimed it
 * while `find_symbol Dog` (same file) did not; on r3d `find_symbol talk` of a
 * deleted file answered `[]` with `["codegraph"]`.
 */
describe("search/symbol answers claim codegraph only for returned tree rows", () => {
  const DOG = "src/zoo/dog.ts";
  const TALK = "src/zoo/talk.ts";

  const outlineRows = (relativePath: string) => [
    codeRow(`${relativePath}-class`, {
      relativePath,
      symbolId: "Dog",
      name: "Dog",
      chunkType: "class",
      content: "class Dog {}",
      startLine: 1,
      endLine: 20,
    }),
    codeRow(`${relativePath}-speak`, {
      relativePath,
      symbolId: "Dog#speak",
      name: "speak",
      chunkType: "function",
      content: "speak() { return 'woof'; }",
      startLine: 3,
      endLine: 5,
      parentSymbolId: "Dog",
      parentType: "class_declaration",
    }),
  ];

  /** A tree whose graph is built; every lookup handed its reader reads it. */
  const builtTreeView = (input: { changed?: string[]; deleted?: string[]; rows?: ScrollChunk[] }): WorkingTreeView => {
    const view = fakeWorkingTreeView({ rows: [retryRow], ...input });
    view.readTreeGraph = vi.fn(async () => BUILT_GRAPH as never);
    return view;
  };

  const graphReadingChunkResolver = () => ({
    resolveSymbolChunk: vi.fn(async (_c: string, _s: string, read?: WorkingTreeGraphReader) => {
      await read?.(120_000);
      return null;
    }),
    readTreeSymbolLineRanges: vi.fn(async (_c: string, _paths: readonly string[], read: WorkingTreeGraphReader) => {
      await read(120_000);
      return new Map();
    }),
  });

  const graphReadingVisibility = (relativePath: string) => ({
    resolveSymbolVisibilities: vi.fn(async (_c: string, ids: readonly string[], read?: WorkingTreeGraphReader) => {
      await read?.(120_000);
      return ids.map((symbolId) => ({ relPath: relativePath, symbolId, visibility: "public" as const }));
    }),
  });

  const registry = { buildMergedFilter: vi.fn().mockReturnValue(undefined) } as never;

  it("find_symbol: an unknown symbol whose lookups read the built tree graph claims nothing", async () => {
    const qdrant = { scrollFiltered: vi.fn().mockResolvedValue([]), getPoint: vi.fn() } as unknown as QdrantManager;
    const view = builtTreeView({ changed: [TOUCHED] });
    const resolver = graphReadingChunkResolver();

    const results = await new SymbolSearchStrategy(
      qdrant,
      passthroughReranker,
      [],
      [],
      registry,
      { symbol: "noSuchSymbolXyzzy" },
      resolver,
    ).execute({ collectionName: "c", limit: 50, workingTreeView: view });

    expect(results).toEqual([]);
    expect(resolver.readTreeSymbolLineRanges).toHaveBeenCalled();
    expect(view.marker.floors).toEqual([]);
    expect(view.marker.treeGraphUnavailable).toBeUndefined();
  });

  it("find_symbol outline: an unchanged file decorated from the built tree graph claims nothing", async () => {
    const qdrant = { scrollFiltered: vi.fn().mockResolvedValue(outlineRows(DOG)) } as unknown as QdrantManager;
    const view = builtTreeView({ changed: [TOUCHED] });
    const visibility = graphReadingVisibility(DOG);

    const results = await new FileOutlineStrategy(
      qdrant,
      passthroughReranker,
      [],
      [],
      { relativePath: DOG },
      visibility,
    ).execute({ collectionName: "c", limit: 1, workingTreeView: view });

    expect(results).toHaveLength(1);
    expect(visibility.resolveSymbolVisibilities).toHaveBeenCalled();
    expect(view.marker.floors).toEqual([]);
  });

  it("find_symbol: a symbol of a deleted file answers nothing and claims nothing", async () => {
    const talkRow = codeRow("base-talk", {
      relativePath: TALK,
      symbolId: "talk",
      content: "export function talk() {}",
    });
    const qdrant = {
      scrollFiltered: vi.fn().mockResolvedValue([talkRow]),
      getPoint: vi.fn(),
    } as unknown as QdrantManager;
    const view = builtTreeView({ changed: [TOUCHED], deleted: [TALK] });

    const results = await new SymbolSearchStrategy(
      qdrant,
      passthroughReranker,
      [],
      [],
      registry,
      { symbol: "talk" },
      graphReadingChunkResolver(),
    ).execute({ collectionName: "c", limit: 50, workingTreeView: view });

    expect(results).toEqual([]);
    expect(view.marker.floors).toEqual([]);
  });

  it("find_symbol outline: a changed file decorated from the built tree graph claims chunks and codegraph", async () => {
    const qdrant = { scrollFiltered: vi.fn().mockResolvedValue(outlineRows(DOG)) } as unknown as QdrantManager;
    const view = builtTreeView({ changed: [DOG], rows: outlineRows(DOG) });

    const results = await new FileOutlineStrategy(
      qdrant,
      passthroughReranker,
      [],
      [],
      { relativePath: DOG },
      graphReadingVisibility(DOG),
    ).execute({ collectionName: "c", limit: 1, workingTreeView: view });

    expect(results).toHaveLength(1);
    expect(view.marker.floors).toEqual(["chunks", "codegraph"]);
  });
});

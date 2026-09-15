/**
 * End-to-end over the production wiring of find_symbol's codegraph hop
 * (bd tea-rags-mcp-a43tr): ExploreFacade → SymbolSearchStrategy →
 * createSymbolChunkResolver → GraphFacade#resolveSymbolChunk → pool.
 *
 * Field report: after parallel rebuilds the codegraph daemon ran another build
 * than the MCP server (INFRA_CODEGRAPH_DAEMON_STALE_BUILD). GraphFacade rethrows
 * acquire failures when the graph database exists — right for get_callers,
 * where an empty list is an assertion about the code — and find_symbol failed
 * outright although its codegraph hop is optional.
 */

import { describe, expect, it, vi } from "vitest";

import { createSymbolChunkResolver } from "../../src/bootstrap/factory.js";
import { CodegraphDaemonStaleBuildError } from "../../src/core/adapters/duckdb/errors.js";
import { ExploreFacade } from "../../src/core/api/internal/facades/explore-facade.js";
import { GraphFacade } from "../../src/core/api/internal/facades/graph-facade.js";

function makeFacade(opts: { scroll: unknown[]; acquireReader: ReturnType<typeof vi.fn> }) {
  const pool = { acquireReader: opts.acquireReader, hasDatabase: vi.fn().mockReturnValue(true) };
  const graphFacade = new GraphFacade({
    pool: pool as never,
    collectionRegistry: {} as never,
    resolveActiveCollection: async (c: string) => c,
  });
  const getPoint = vi.fn();
  const facade = new ExploreFacade({
    qdrant: {
      scrollFiltered: vi.fn().mockResolvedValue(opts.scroll),
      collectionExists: vi.fn().mockResolvedValue(true),
      getPoint,
    } as never,
    embeddings: { embed: vi.fn().mockResolvedValue({ embedding: [] }) } as never,
    reranker: {
      rerank: vi.fn((r: unknown[]) => r),
      hasCollectionStats: false,
      setCollectionStats: vi.fn(),
      getDescriptors: vi.fn().mockReturnValue([]),
      getPreset: vi.fn(),
      getPresetNames: vi.fn().mockReturnValue([]),
      getFullPreset: vi.fn().mockReturnValue(undefined),
    } as never,
    registry: {
      buildMergedFilter: vi.fn().mockReturnValue(undefined),
      getAllFilters: vi.fn().mockReturnValue([]),
      getAllPayloadSignalDescriptors: vi.fn().mockReturnValue([]),
      getEssentialPayloadKeys: vi.fn().mockReturnValue([]),
    } as never,
    chunkResolver: createSymbolChunkResolver(graphFacade),
  });
  return { facade, pool, getPoint };
}

describe("find_symbol over an unavailable codegraph (a43tr)", () => {
  it("stale daemon build: answers empty with a codegraph warning naming the code and the remedy", async () => {
    const stale = new CodegraphDaemonStaleBuildError("/tmp/cg/daemon.sock", "CLIENT-OLD", "DAEMON-NEW", [
      "DAEMON-NEW",
      "DAEMON-NEW",
      "DAEMON-NEW",
    ]);
    const { facade, getPoint } = makeFacade({ scroll: [], acquireReader: vi.fn().mockRejectedValue(stale) });

    const response = await facade.findSymbol({ symbol: "Foo#bar", collection: "code_x" });

    expect(response.results).toEqual([]);
    expect(getPoint).not.toHaveBeenCalled();
    const warning = (response as { codegraphWarning?: string }).codegraphWarning;
    expect(warning).toContain("INFRA_CODEGRAPH_DAEMON_STALE_BUILD");
    expect(warning).toMatch(/codegraph fallback/i);
    expect(warning).toContain("/mcp reconnect");
  });

  it("a read failure that is not codegraph-unavailable still fails find_symbol", async () => {
    const { facade } = makeFacade({
      scroll: [],
      acquireReader: vi.fn().mockRejectedValue(new Error("unexpected resolver bug")),
    });

    await expect(facade.findSymbol({ symbol: "Foo#bar", collection: "code_x" })).rejects.toThrow(
      /unexpected resolver bug/,
    );
  });

  it("a symbol the Qdrant scrolls resolve never touches codegraph and carries no codegraph warning", async () => {
    const acquireReader = vi.fn();
    const { facade } = makeFacade({
      scroll: [
        {
          id: "uuid-1",
          payload: {
            symbolId: "Foo#bar",
            chunkType: "function",
            relativePath: "foo.rb",
            content: "def bar; end",
            startLine: 1,
            endLine: 2,
          },
        },
      ],
      acquireReader,
    });

    const response = await facade.findSymbol({ symbol: "Foo#bar", collection: "code_x" });

    expect(response.results).toHaveLength(1);
    expect(acquireReader).not.toHaveBeenCalled();
    expect("codegraphWarning" in response).toBe(false);
  });
});

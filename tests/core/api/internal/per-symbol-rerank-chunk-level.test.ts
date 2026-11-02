/**
 * Per-symbol / per-chunk scoring paths score at CHUNK level whatever the
 * preset's own `signalLevel` (bd tea-rags-mcp-9z8ae, owner addendum).
 *
 * `signalLevel` is the default of the LIST-ranking tools (semantic_search,
 * hybrid_search, rank_chunks, find_similar). find_symbol returns one row per
 * symbol, and search_code returns chunk rows with no `level` param: scoring
 * them at file level ties every method of a file and drops the chunk overlay
 * (pageRank / fanIn / fanOut). `proven` and `ownership` are file-level on main
 * and were already affected; `bugHunt` / `dangerous` join them with 9z8ae.
 */

import { describe, expect, it, vi } from "vitest";

import { ExploreFacade } from "../../../../src/core/api/index.js";
import type { RerankPreset } from "../../../../src/core/contracts/types/reranker.js";
import { FileOutlineStrategy } from "../../../../src/core/domains/explore/strategies/file-outline.js";
import { SymbolSearchStrategy } from "../../../../src/core/domains/explore/strategies/symbol.js";
import { BugHuntPreset } from "../../../../src/core/domains/trajectory/git/rerank/presets/bug-hunt.js";
import { ProvenPreset } from "../../../../src/core/domains/trajectory/git/rerank/presets/proven.js";
import { TrajectoryRegistry } from "../../../../src/core/domains/trajectory/index.js";
import { STATIC_FILTER_PRESETS } from "../../../../src/core/domains/trajectory/static/filter-presets/index.js";
import { StaticTrajectory } from "../../../../src/core/domains/trajectory/static/index.js";

const FILE_LEVEL_PRESETS: Record<string, RerankPreset> = {
  proven: new ProvenPreset(),
  bugHunt: new BugHuntPreset(),
};

function makeReranker(preset: RerankPreset) {
  return {
    rerank: vi.fn((results: unknown[]) => results),
    hasCollectionStats: false,
    setCollectionStats: vi.fn(),
    getCollectionStats: vi.fn().mockReturnValue(undefined),
    getDescriptors: vi.fn().mockReturnValue([]),
    getFullPreset: vi.fn((name: string) => (name === preset.name ? preset : undefined)),
    getPreset: vi.fn(),
    getPresetNames: vi.fn().mockReturnValue([preset.name]),
  } as any;
}

describe.each(Object.entries(FILE_LEVEL_PRESETS))("%s is a file-level preset", (name, preset) => {
  it("precondition: the preset itself declares signalLevel file", () => {
    expect(preset.signalLevel).toBe("file");
  });

  it("find_symbol (symbol lookup) reranks at chunk level", async () => {
    const reranker = makeReranker(preset);
    const qdrant = {
      scrollFiltered: async () => [
        {
          id: "m",
          payload: { symbolId: "Foo#bar", chunkType: "function", relativePath: "a.ts", startLine: 1, endLine: 5 },
        },
      ],
    } as any;
    const strategy = new SymbolSearchStrategy(qdrant, reranker, [], [], { buildMergedFilter: () => undefined } as any, {
      symbol: "Foo#bar",
    });

    await strategy.execute({ collectionName: "c", limit: 5, rerank: name });

    expect(reranker.rerank).toHaveBeenCalledWith(
      expect.anything(),
      name,
      "semantic_search",
      expect.objectContaining({ signalLevel: "chunk" }),
    );
  });

  it("find_symbol (file outline) reranks at chunk level", async () => {
    const reranker = makeReranker(preset);
    const qdrant = {
      scrollFiltered: async () => [
        {
          id: "a",
          payload: {
            symbolId: "fn1",
            chunkType: "function",
            relativePath: "src/utils.ts",
            content: "fn1",
            startLine: 1,
            endLine: 5,
            language: "typescript",
            name: "fn1",
          },
        },
      ],
    } as any;
    const strategy = new FileOutlineStrategy(qdrant, reranker, [], [], { relativePath: "src/utils.ts" });

    await strategy.execute({ collectionName: "c", limit: 1, rerank: name });

    expect(reranker.rerank).toHaveBeenCalledWith(
      expect.anything(),
      name,
      "semantic_search",
      expect.objectContaining({ signalLevel: "chunk" }),
    );
  });

  it("search_code returns chunks (no file grouping) scored at chunk level", async () => {
    const reranker = makeReranker(preset);
    const qdrant = {
      collectionExists: vi.fn().mockResolvedValue(true),
      search: vi.fn().mockResolvedValue([]),
      queryGroups: vi.fn().mockResolvedValue([]),
      getCollectionInfo: vi.fn().mockResolvedValue({ hybridEnabled: false }),
      ensurePayloadIndex: vi.fn(),
    } as any;
    const registry = new TrajectoryRegistry();
    registry.register(new StaticTrajectory());
    registry.setFilterPresets(STATIC_FILTER_PRESETS);
    const facade = new ExploreFacade({
      qdrant,
      embeddings: { embed: vi.fn().mockResolvedValue({ embedding: [0.1, 0.2] }) } as any,
      reranker,
      registry,
    } as any);

    await facade.searchCode({ collection: "col", query: "q", rerank: name });

    expect(qdrant.queryGroups).not.toHaveBeenCalled();
    expect(reranker.rerank).toHaveBeenCalledWith(
      expect.anything(),
      name,
      "semantic_search",
      expect.objectContaining({ signalLevel: "chunk" }),
    );
  });
});

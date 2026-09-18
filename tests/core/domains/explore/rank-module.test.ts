import { describe, expect, it, vi } from "vitest";

import type { DerivedSignalDescriptor } from "../../../../src/core/contracts/types/reranker.js";
import type { PayloadSignalDescriptor } from "../../../../src/core/contracts/types/trajectory.js";
import { RankModule } from "../../../../src/core/domains/explore/rank-module.js";
import type { Reranker } from "../../../../src/core/domains/explore/reranker.js";

// Minimal descriptors for testing
const chunkSizeDesc: DerivedSignalDescriptor = {
  name: "chunkSize",
  description: "size",
  sources: ["methodLines"],
  defaultBound: 500,
  extract: (raw) => {
    const v = (raw.methodLines as number) || 0;
    return Math.min(1, v / 500);
  },
};

const churnDesc: DerivedSignalDescriptor = {
  name: "churn",
  description: "churn",
  sources: ["file.commitCount", "chunk.commitCount"],
  defaultBound: 50,
  extract: (raw) => {
    const git = raw.git as Record<string, Record<string, number>> | undefined;
    return Math.min(1, (git?.file?.commitCount ?? 0) / 50);
  },
};

const recencyDesc: DerivedSignalDescriptor = {
  name: "recency",
  description: "recency",
  sources: ["file.ageDays", "chunk.ageDays"],
  defaultBound: 365,
  inverted: true,
  extract: (raw) => {
    const git = raw.git as Record<string, Record<string, number>> | undefined;
    return 1 - Math.min(1, (git?.file?.ageDays ?? 0) / 365);
  },
};

/**
 * The payload fields the descriptors above read. RankModule orders only by a
 * field a payload descriptor declares, so every source a test orders by is
 * declared here (bd tea-rags-mcp-q34ic).
 */
const PAYLOAD_SIGNALS: PayloadSignalDescriptor[] = [
  { key: "methodLines", type: "number", description: "method lines" },
  { key: "git.file.commitCount", type: "number", description: "file commits" },
  { key: "git.chunk.commitCount", type: "number", description: "chunk commits" },
  { key: "git.file.ageDays", type: "number", description: "file age" },
  { key: "git.chunk.ageDays", type: "number", description: "chunk age" },
];

function createMockScrollFn(data: Map<string, { id: string | number; payload: Record<string, unknown> }[]>) {
  return vi.fn().mockImplementation(async (_col: string, orderBy: { key: string }) => {
    return Promise.resolve(data.get(orderBy.key) ?? []);
  });
}

function createMockReranker(): Reranker {
  return {
    rerank: vi.fn().mockImplementation((results: { score: number }[]) => {
      return results.map((r) => ({ ...r, rankingOverlay: { preset: "test" } }));
    }),
    getPreset: vi.fn(),
    getAvailablePresets: vi.fn().mockReturnValue(["decomposition"]),
  } as unknown as Reranker;
}

describe("RankModule", () => {
  describe("resolveOrderByFields", () => {
    it("resolves chunk-level fields from sources and inverted flag", () => {
      const module = new RankModule(createMockReranker(), [chunkSizeDesc, churnDesc, recencyDesc], PAYLOAD_SIGNALS);

      const fields = module.resolveOrderByFields({ chunkSize: 0.5, churn: 0.3, recency: 0.2 }, "chunk");

      expect(fields).toEqual([
        { key: "methodLines", direction: "desc" },
        { key: "git.chunk.commitCount", direction: "desc" },
        { key: "git.chunk.ageDays", direction: "asc" },
      ]);
    });

    it("resolves file-level fields when level=file", () => {
      const module = new RankModule(createMockReranker(), [churnDesc], PAYLOAD_SIGNALS);

      const fields = module.resolveOrderByFields({ churn: 1.0 }, "file");

      expect(fields).toEqual([{ key: "git.file.commitCount", direction: "desc" }]);
    });

    it("skips similarity weight", () => {
      const module = new RankModule(createMockReranker(), [chunkSizeDesc], PAYLOAD_SIGNALS);

      const fields = module.resolveOrderByFields({ similarity: 0.5, chunkSize: 0.5 }, "chunk");

      expect(fields).toHaveLength(1);
      expect(fields[0].key).toBe("methodLines");
    });

    it("returns empty for unknown descriptors", () => {
      const module = new RankModule(createMockReranker(), [], PAYLOAD_SIGNALS);

      const fields = module.resolveOrderByFields({ unknown: 1.0 }, "chunk");

      expect(fields).toEqual([]);
    });
  });

  describe("rankChunks", () => {
    it("performs scatter-gather and returns merged results", async () => {
      const scrollData = new Map([
        [
          "methodLines",
          [
            { id: "a", payload: { methodLines: 200, relativePath: "big.ts" } },
            { id: "b", payload: { methodLines: 100, relativePath: "medium.ts" } },
          ],
        ],
      ]);

      const mockScroll = createMockScrollFn(scrollData);
      const mockReranker = createMockReranker();
      const module = new RankModule(mockReranker, [chunkSizeDesc], PAYLOAD_SIGNALS);

      const results = await module.rankChunks("test-col", {
        weights: { chunkSize: 1.0 },
        level: "chunk",
        limit: 10,
        scrollFn: mockScroll,
      });

      expect(mockScroll).toHaveBeenCalledTimes(1);
      expect(mockReranker.rerank).toHaveBeenCalledTimes(1);
      expect(results).toHaveLength(2);
    });

    it("deduplicates points from multiple scrolls", async () => {
      const scrollData = new Map([
        [
          "methodLines",
          [
            { id: "a", payload: { methodLines: 200 } },
            { id: "b", payload: { methodLines: 100 } },
          ],
        ],
        [
          "git.chunk.commitCount",
          [
            { id: "b", payload: { methodLines: 100 } },
            { id: "c", payload: { methodLines: 50 } },
          ],
        ],
      ]);

      const mockScroll = createMockScrollFn(scrollData);
      const mockReranker = createMockReranker();
      const module = new RankModule(mockReranker, [chunkSizeDesc, churnDesc], PAYLOAD_SIGNALS);

      await module.rankChunks("test-col", {
        weights: { chunkSize: 0.5, churn: 0.5 },
        level: "chunk",
        limit: 10,
        scrollFn: mockScroll,
      });

      const rerankedInput = (mockReranker.rerank as ReturnType<typeof vi.fn>).mock.calls[0][0];
      expect(rerankedInput).toHaveLength(3); // a, b, c — b deduplicated
    });

    it("removes similarity from weights and re-normalizes", async () => {
      const scrollData = new Map([["methodLines", [{ id: "a", payload: { methodLines: 200 } }]]]);

      const mockScroll = createMockScrollFn(scrollData);
      const mockReranker = createMockReranker();
      const module = new RankModule(mockReranker, [chunkSizeDesc], PAYLOAD_SIGNALS);

      await module.rankChunks("test-col", {
        weights: { similarity: 0.5, chunkSize: 0.5 },
        level: "chunk",
        limit: 10,
        scrollFn: mockScroll,
      });

      const rerankerCall = (mockReranker.rerank as ReturnType<typeof vi.fn>).mock.calls[0];
      const mode = rerankerCall[1];
      expect(mode.custom.similarity).toBeUndefined();
      expect(mode.custom.chunkSize).toBeCloseTo(1.0);
    });

    it("returns empty when all weights are similarity", async () => {
      const mockScroll = vi.fn();
      const module = new RankModule(createMockReranker(), [chunkSizeDesc], PAYLOAD_SIGNALS);

      const results = await module.rankChunks("test-col", {
        weights: { similarity: 1.0 },
        level: "chunk",
        limit: 10,
        scrollFn: mockScroll,
      });

      expect(results).toEqual([]);
      expect(mockScroll).not.toHaveBeenCalled();
    });

    it("uses overfetch factor of 3x", async () => {
      const scrollData = new Map([["methodLines", [{ id: "a", payload: { methodLines: 200 } }]]]);
      const mockScroll = createMockScrollFn(scrollData);
      const module = new RankModule(createMockReranker(), [chunkSizeDesc], PAYLOAD_SIGNALS);

      await module.rankChunks("test-col", {
        weights: { chunkSize: 1.0 },
        level: "chunk",
        limit: 10,
        scrollFn: mockScroll,
      });

      // Should request 30 (10 * 3)
      expect(mockScroll).toHaveBeenCalledWith("test-col", expect.anything(), 30, undefined);
    });

    it("passes filter to scroll function", async () => {
      const scrollData = new Map([["methodLines", [{ id: "a", payload: { methodLines: 200 } }]]]);
      const mockScroll = createMockScrollFn(scrollData);
      const module = new RankModule(createMockReranker(), [chunkSizeDesc], PAYLOAD_SIGNALS);
      const filter = { must: [{ key: "language", match: { value: "typescript" } }] };

      await module.rankChunks("test-col", {
        weights: { chunkSize: 1.0 },
        level: "chunk",
        limit: 10,
        scrollFn: mockScroll,
        filter,
      });

      expect(mockScroll).toHaveBeenCalledWith("test-col", expect.anything(), 30, filter);
    });

    it("returns empty when scatter-gather yields zero merged points", async () => {
      // All scroll calls return empty arrays — merged dedup also empty.
      // rankChunks must bail out with [] before calling rerank, not crash on
      // an empty rerank input.
      const mockScroll = vi.fn().mockResolvedValue([]);
      const mockReranker = createMockReranker();
      const module = new RankModule(mockReranker, [chunkSizeDesc], PAYLOAD_SIGNALS);

      const results = await module.rankChunks("test-col", {
        weights: { chunkSize: 1.0 },
        level: "chunk",
        limit: 10,
        scrollFn: mockScroll,
      });

      expect(results).toEqual([]);
      expect(mockReranker.rerank).not.toHaveBeenCalled();
    });

    it("orders by the first source when none matches the requested level or is unprefixed", async () => {
      // Descriptor whose sources are all level-prefixed but for a DIFFERENT level
      // (file.X when asking for chunk) — neither the level candidate nor the
      // unprefixed one exists, so resolvePayloadField takes the first source.
      const fileOnlyDesc: DerivedSignalDescriptor = {
        name: "fileOnly",
        description: "file-only signal",
        sources: ["file.commitCount"], // no chunk-prefixed source, no unprefixed source
        defaultBound: 50,
        extract: (raw) => {
          const git = raw.git as Record<string, Record<string, number>> | undefined;
          return Math.min(1, (git?.file?.commitCount ?? 0) / 50);
        },
      };
      const scrollData = new Map([["git.file.commitCount", [{ id: "x", payload: {} }]]]);
      const mockScroll = createMockScrollFn(scrollData);
      const module = new RankModule(createMockReranker(), [fileOnlyDesc], PAYLOAD_SIGNALS);

      const fields = module.resolveOrderByFields({ fileOnly: 1.0 }, "chunk");

      // sources[0] = "file.commitCount", declared as git.file.commitCount
      expect(fields).toEqual([{ key: "git.file.commitCount", direction: "desc" }]);
      // Behaviorally: scroll is called against that fallback field.
      await module.rankChunks("test-col", {
        weights: { fileOnly: 1.0 },
        level: "chunk",
        limit: 5,
        scrollFn: mockScroll,
      });
      expect(mockScroll).toHaveBeenCalledWith(
        "test-col",
        { key: "git.file.commitCount", direction: "desc" },
        15,
        undefined,
      );
    });

    // bd tea-rags-mcp-q34ic — a `git.` guess for an undeclared source is how
    // `git.file.fanIn` & co. were minted as payload indexes: the scroll ordered
    // by the guessed key and rank_chunks indexed it first. A source no payload
    // descriptor declares orders nothing, like an unknown weight key; the
    // signal still scores the pooled candidates in the rerank.
    it("orders by nothing for sources no payload descriptor declares", () => {
      const undeclared = (name: string, sources: string[]): DerivedSignalDescriptor => ({
        name,
        description: name,
        sources,
        defaultBound: 1,
        extract: () => 0,
      });
      const module = new RankModule(
        createMockReranker(),
        [undeclared("fanIn", ["file.fanIn"]), undeclared("pageRank", ["chunk.pageRank"]), undeclared("mass", ["mass"])],
        PAYLOAD_SIGNALS,
      );

      for (const level of ["chunk", "file"] as const) {
        expect(module.resolveOrderByFields({ fanIn: 1, pageRank: 1, mass: 1 }, level)).toEqual([]);
      }
    });

    it("skips descriptors whose sources list is empty (resolvePayloadField returns undefined)", async () => {
      // Edge case: a descriptor with no sources at all — all three resolve
      // branches return undefined. resolveOrderByFields filters that entry.
      const sourcelessDesc: DerivedSignalDescriptor = {
        name: "sourceless",
        description: "no sources",
        sources: [],
        defaultBound: 1,
        extract: () => 0,
      };
      const module = new RankModule(createMockReranker(), [sourcelessDesc], PAYLOAD_SIGNALS);

      const fields = module.resolveOrderByFields({ sourceless: 1.0 }, "chunk");
      expect(fields).toEqual([]);
    });
  });

  // Codegraph signals are declared under the LOGICAL key `codegraph.{level}.X` and
  // stored at `codegraph.symbols.{level}.X`; the order_by key has to be the stored
  // path. A hard-coded `git.` prefix sorted by a field no point carries, so the
  // scroll came back empty.
  describe("order_by keys resolved through the payload signal descriptors", () => {
    const payloadSignals: PayloadSignalDescriptor[] = [
      { key: "git.file.commitCount", type: "number", description: "file commits" },
      { key: "git.chunk.commitCount", type: "number", description: "chunk commits" },
      { key: "codegraph.file.fanIn", type: "number", description: "file fanIn" },
      { key: "codegraph.file.isHub", type: "boolean", description: "hub flag" },
      { key: "codegraph.chunk.pageRank", type: "number", description: "method pageRank" },
    ];
    const signal = (name: string, sources: string[]): DerivedSignalDescriptor => ({
      name,
      description: name,
      sources,
      defaultBound: 1,
      extract: () => 0,
    });
    const pageRankDesc = signal("pageRank", ["chunk.pageRank"]);
    const fanInDesc = signal("fanIn", ["file.fanIn"]);
    const isHubDesc = signal("isHub", ["file.isHub"]);

    it("orders a codegraph chunk signal by its stored nested payload path", () => {
      const module = new RankModule(createMockReranker(), [pageRankDesc], payloadSignals);

      expect(module.resolveOrderByFields({ pageRank: 1 }, "chunk")).toEqual([
        { key: "codegraph.symbols.chunk.pageRank", direction: "desc" },
      ]);
    });

    it("orders a codegraph file signal by its stored path at either level", () => {
      const module = new RankModule(createMockReranker(), [fanInDesc], payloadSignals);

      expect(module.resolveOrderByFields({ fanIn: 1 }, "file")).toEqual([
        { key: "codegraph.symbols.file.fanIn", direction: "desc" },
      ]);
      expect(module.resolveOrderByFields({ fanIn: 1 }, "chunk")).toEqual([
        { key: "codegraph.symbols.file.fanIn", direction: "desc" },
      ]);
    });

    it("keeps git signals on their git payload path", () => {
      const module = new RankModule(createMockReranker(), [churnDesc], payloadSignals);

      expect(module.resolveOrderByFields({ churn: 1 }, "chunk")).toEqual([
        { key: "git.chunk.commitCount", direction: "desc" },
      ]);
    });

    it("never orders by a boolean signal — order_by needs a numeric range index", () => {
      const module = new RankModule(createMockReranker(), [isHubDesc, fanInDesc], payloadSignals);

      expect(module.resolveOrderByFields({ isHub: 0.5, fanIn: 0.5 }, "file")).toEqual([
        { key: "codegraph.symbols.file.fanIn", direction: "desc" },
      ]);
    });

    it("ranks the points the stored codegraph field orders", async () => {
      const scrollData = new Map([
        [
          "codegraph.symbols.chunk.pageRank",
          [
            { id: "a", payload: { codegraph: { symbols: { chunk: { pageRank: 0.9 } } } } },
            { id: "b", payload: { codegraph: { symbols: { chunk: { pageRank: 0.4 } } } } },
          ],
        ],
      ]);
      const module = new RankModule(createMockReranker(), [pageRankDesc], payloadSignals);

      const results = await module.rankChunks("test-col", {
        weights: { pageRank: 1 },
        level: "chunk",
        limit: 10,
        scrollFn: createMockScrollFn(scrollData),
      });

      expect(results.map((r) => r.id)).toEqual(["a", "b"]);
    });
  });
});

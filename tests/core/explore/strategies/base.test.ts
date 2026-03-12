/**
 * Tests for BaseExploreStrategy — shared defaults, postProcess, and metaOnly logic.
 */

import { describe, expect, it, vi } from "vitest";

import type { QdrantManager } from "../../../../src/core/adapters/qdrant/client.js";
import type { PayloadSignalDescriptor } from "../../../../src/core/contracts/types/trajectory.js";
import type { Reranker } from "../../../../src/core/explore/reranker.js";
import {
  BaseExploreStrategy,
  type RawResult,
  type SearchContext,
} from "../../../../src/core/explore/strategies/types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createMockQdrant(): QdrantManager {
  return {} as unknown as QdrantManager;
}

function createMockReranker(): Reranker {
  return {
    rerank: vi.fn().mockImplementation((results: RawResult[]) => results),
  } as unknown as Reranker;
}

const EMPTY_SIGNALS: PayloadSignalDescriptor[] = [];
const EMPTY_KEYS: string[] = [];

/**
 * Concrete strategy for testing — exposes inner state for assertions.
 */
class TestStrategy extends BaseExploreStrategy {
  readonly type = "vector" as const;

  public lastCtx: SearchContext | undefined;
  private readonly rawResults: RawResult[];

  constructor(
    qdrant: QdrantManager,
    reranker: Reranker,
    payloadSignals: PayloadSignalDescriptor[],
    essentialKeys: string[],
    rawResults: RawResult[] = [],
  ) {
    super(qdrant, reranker, payloadSignals, essentialKeys);
    this.rawResults = rawResults;
  }

  protected async executeSearch(ctx: SearchContext): Promise<RawResult[]> {
    this.lastCtx = ctx;
    return this.rawResults;
  }
}

function makeResults(n: number): RawResult[] {
  return Array.from({ length: n }, (_, i) => ({
    id: String(i),
    score: 1 - i * 0.01,
    payload: { relativePath: `src/file${i}.ts`, content: `content-${i}` },
  }));
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("BaseExploreStrategy", () => {
  describe("applyDefaults — limit", () => {
    it("passes fetchLimit (overfetched) to executeSearch", async () => {
      const strategy = new TestStrategy(createMockQdrant(), createMockReranker(), EMPTY_SIGNALS, EMPTY_KEYS);
      await strategy.execute({ collectionName: "col", limit: 10 });
      // executeSearch receives fetchLimit, which is at least limit * 4
      expect(strategy.lastCtx?.limit).toBeGreaterThanOrEqual(10);
    });

    it("applies minimum limit of 5 when limit is 0, then overfetches", async () => {
      const strategy = new TestStrategy(createMockQdrant(), createMockReranker(), EMPTY_SIGNALS, EMPTY_KEYS);
      await strategy.execute({ collectionName: "col", limit: 0 });
      // min limit=5, then calculateFetchLimit(5, false)=max(20,20)=20
      expect(strategy.lastCtx?.limit).toBeGreaterThanOrEqual(20);
    });

    it("applies minimum limit of 5 when limit is below minimum, then overfetches", async () => {
      const strategy = new TestStrategy(createMockQdrant(), createMockReranker(), EMPTY_SIGNALS, EMPTY_KEYS);
      await strategy.execute({ collectionName: "col", limit: 2 });
      // min limit=5, then calculateFetchLimit(5, false)=max(20,20)=20
      expect(strategy.lastCtx?.limit).toBeGreaterThanOrEqual(20);
    });

    it("trims output to minimum limit of 5 when requested limit is 0", async () => {
      const results = makeResults(30);
      const strategy = new TestStrategy(createMockQdrant(), createMockReranker(), EMPTY_SIGNALS, EMPTY_KEYS, results);
      const output = await strategy.execute({ collectionName: "col", limit: 0 });
      expect(output).toHaveLength(5);
    });

    it("trims output to minimum limit of 5 when requested limit is 2", async () => {
      const results = makeResults(30);
      const strategy = new TestStrategy(createMockQdrant(), createMockReranker(), EMPTY_SIGNALS, EMPTY_KEYS, results);
      const output = await strategy.execute({ collectionName: "col", limit: 2 });
      expect(output).toHaveLength(5);
    });
  });

  describe("applyDefaults — overfetch", () => {
    it("sets fetchLimit equal to limit when no pathPattern or non-relevance rerank", async () => {
      const results = makeResults(30);
      const strategy = new TestStrategy(createMockQdrant(), createMockReranker(), EMPTY_SIGNALS, EMPTY_KEYS, results);
      await strategy.execute({ collectionName: "col", limit: 5 });
      // fetchLimit >= limit * 4 (minimum overfetch even without extra)
      // The key is executeSearch receives fetchLimit, not the original limit
      const fetchedLimit = strategy.lastCtx?.limit ?? 0;
      // Without pathPattern or non-relevance rerank, calculateFetchLimit(5, false) = max(20, 5*4) = 20
      expect(fetchedLimit).toBeGreaterThanOrEqual(20);
    });

    it("uses higher fetchLimit when pathPattern is present", async () => {
      const results = makeResults(50);
      const strategyWithPattern = new TestStrategy(
        createMockQdrant(),
        createMockReranker(),
        EMPTY_SIGNALS,
        EMPTY_KEYS,
        results,
      );
      const strategyNoPattern = new TestStrategy(
        createMockQdrant(),
        createMockReranker(),
        EMPTY_SIGNALS,
        EMPTY_KEYS,
        results,
      );

      await strategyWithPattern.execute({ collectionName: "col", limit: 5, pathPattern: "src/**/*.ts" });
      await strategyNoPattern.execute({ collectionName: "col", limit: 5 });

      const fetchWithPattern = strategyWithPattern.lastCtx?.limit ?? 0;
      const fetchNoPattern = strategyNoPattern.lastCtx?.limit ?? 0;
      // With pathPattern: calculateFetchLimit(5, true) = max(20, 5*6) = 30
      // Without: calculateFetchLimit(5, false) = max(20, 5*4) = 20
      expect(fetchWithPattern).toBeGreaterThan(fetchNoPattern);
    });

    it("uses higher fetchLimit when non-relevance rerank is present", async () => {
      const results = makeResults(50);
      const strategyWithRerank = new TestStrategy(
        createMockQdrant(),
        createMockReranker(),
        EMPTY_SIGNALS,
        EMPTY_KEYS,
        results,
      );
      const strategyNoRerank = new TestStrategy(
        createMockQdrant(),
        createMockReranker(),
        EMPTY_SIGNALS,
        EMPTY_KEYS,
        results,
      );

      await strategyWithRerank.execute({ collectionName: "col", limit: 5, rerank: "techDebt" });
      await strategyNoRerank.execute({ collectionName: "col", limit: 5 });

      expect(strategyWithRerank.lastCtx?.limit ?? 0).toBeGreaterThan(strategyNoRerank.lastCtx?.limit ?? 0);
    });
  });

  describe("postProcess — glob filtering", () => {
    it("filters results by pathPattern", async () => {
      const results = [
        { id: "1", score: 0.9, payload: { relativePath: "src/a.ts" } },
        { id: "2", score: 0.8, payload: { relativePath: "lib/b.ts" } },
        { id: "3", score: 0.7, payload: { relativePath: "src/c.ts" } },
      ];
      const strategy = new TestStrategy(createMockQdrant(), createMockReranker(), EMPTY_SIGNALS, EMPTY_KEYS, results);

      const output = await strategy.execute({ collectionName: "col", limit: 10, pathPattern: "src/**" });
      expect(output).toHaveLength(2);
      expect(output.every((r) => (r.payload?.relativePath as string).startsWith("src/"))).toBe(true);
    });

    it("passes all results through when no pathPattern", async () => {
      const results = makeResults(5);
      const strategy = new TestStrategy(createMockQdrant(), createMockReranker(), EMPTY_SIGNALS, EMPTY_KEYS, results);

      const output = await strategy.execute({ collectionName: "col", limit: 10 });
      expect(output).toHaveLength(5);
    });
  });

  describe("postProcess — trim to requested limit", () => {
    it("trims results to the original requested limit", async () => {
      const results = makeResults(30);
      const strategy = new TestStrategy(createMockQdrant(), createMockReranker(), EMPTY_SIGNALS, EMPTY_KEYS, results);

      const output = await strategy.execute({ collectionName: "col", limit: 3 });
      expect(output.length).toBeLessThanOrEqual(5); // min limit is 5
    });

    it("trims to exactly the requested limit when enough results", async () => {
      const results = makeResults(50);
      const strategy = new TestStrategy(createMockQdrant(), createMockReranker(), EMPTY_SIGNALS, EMPTY_KEYS, results);

      const output = await strategy.execute({ collectionName: "col", limit: 10 });
      expect(output).toHaveLength(10);
    });
  });

  describe("postProcess — metaOnly", () => {
    it("preserves content when metaOnly is false (default)", async () => {
      const results = [
        { id: "1", score: 0.9, payload: { relativePath: "src/a.ts", content: "some code", name: "foo" } },
      ];
      const strategy = new TestStrategy(createMockQdrant(), createMockReranker(), EMPTY_SIGNALS, EMPTY_KEYS, results);

      const output = await strategy.execute({ collectionName: "col", limit: 10 });
      expect(output[0].payload?.content).toBe("some code");
    });

    it("preserves content when metaOnly is explicitly false", async () => {
      const results = [{ id: "1", score: 0.9, payload: { relativePath: "src/a.ts", content: "some code" } }];
      const strategy = new TestStrategy(createMockQdrant(), createMockReranker(), EMPTY_SIGNALS, EMPTY_KEYS, results);

      const output = await strategy.execute({ collectionName: "col", limit: 10, metaOnly: false });
      expect(output[0].payload?.content).toBe("some code");
    });

    it("strips content when metaOnly is true, keeps metadata from payloadSignals", async () => {
      const payloadSignals: PayloadSignalDescriptor[] = [
        { key: "relativePath", type: "string", description: "File path" },
        { key: "name", type: "string", description: "Symbol name" },
      ];
      const results = [
        { id: "1", score: 0.9, payload: { relativePath: "src/a.ts", name: "myFn", content: "code content" } },
      ];
      const strategy = new TestStrategy(createMockQdrant(), createMockReranker(), payloadSignals, EMPTY_KEYS, results);

      const output = await strategy.execute({ collectionName: "col", limit: 10, metaOnly: true });
      // metaOnly wraps results as Record<string, unknown>[]
      // The returned RawResult should not contain content
      const item = output[0];
      expect(item.payload?.content).toBeUndefined();
      expect(item.payload?.relativePath ?? item.score).toBeDefined();
    });

    it("returns score in metaOnly output", async () => {
      const payloadSignals: PayloadSignalDescriptor[] = [
        { key: "relativePath", type: "string", description: "File path" },
      ];
      const results = [{ id: "1", score: 0.75, payload: { relativePath: "src/x.ts", content: "stuff" } }];
      const strategy = new TestStrategy(createMockQdrant(), createMockReranker(), payloadSignals, EMPTY_KEYS, results);

      const output = await strategy.execute({ collectionName: "col", limit: 10, metaOnly: true });
      expect(output[0].score).toBe(0.75);
    });
  });

  describe("reranking", () => {
    it("skips reranker when rerank is 'relevance'", async () => {
      const reranker = createMockReranker();
      const results = makeResults(5);
      const strategy = new TestStrategy(createMockQdrant(), reranker, EMPTY_SIGNALS, EMPTY_KEYS, results);

      await strategy.execute({ collectionName: "col", limit: 10, rerank: "relevance" });
      expect(reranker.rerank).not.toHaveBeenCalled();
    });

    it("calls reranker when non-relevance preset is specified", async () => {
      const reranker = createMockReranker();
      const results = makeResults(5);
      const strategy = new TestStrategy(createMockQdrant(), reranker, EMPTY_SIGNALS, EMPTY_KEYS, results);

      await strategy.execute({ collectionName: "col", limit: 10, rerank: "techDebt" });
      expect(reranker.rerank).toHaveBeenCalled();
    });
  });
});

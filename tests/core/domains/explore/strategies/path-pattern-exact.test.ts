/**
 * bd tea-rags-mcp-xf01b — `pathPattern` is enforced EXACTLY (picomatch) on every
 * result, not only through the Qdrant text pre-filter.
 *
 * The pre-filter lowers `**\/pipeline/enrichment/completion-runner.ts` to the
 * token query `pipeline/enrichment/`, so Qdrant legitimately hands back a
 * SUPERSET: every file of that directory. Each mock below plays that superset
 * back and asserts that only the file the glob names survives, that the page
 * still fills when the superset is thin, and that a request without a
 * pathPattern is sent exactly as before.
 */

import { describe, expect, it, vi } from "vitest";

import type { EmbeddingProvider } from "../../../../../src/core/adapters/embeddings/base.js";
import type { CollectionInfo, QdrantManager } from "../../../../../src/core/adapters/qdrant/client.js";
import type { DerivedSignalDescriptor, RerankableResult } from "../../../../../src/core/contracts/types/reranker.js";
import type { Reranker } from "../../../../../src/core/domains/explore/reranker.js";
import { HybridSearchStrategy } from "../../../../../src/core/domains/explore/strategies/hybrid.js";
import { ScrollRankStrategy } from "../../../../../src/core/domains/explore/strategies/scroll-rank.js";
import { SimilarSearchStrategy } from "../../../../../src/core/domains/explore/strategies/similar.js";
import { SymbolSearchStrategy } from "../../../../../src/core/domains/explore/strategies/symbol.js";
import { VectorSearchStrategy } from "../../../../../src/core/domains/explore/strategies/vector.js";

const RUNNER = "src/core/domains/ingest/pipeline/enrichment/completion-runner.ts";
const COORDINATOR = "src/core/domains/ingest/pipeline/enrichment/coordinator.ts";
const RUNNER_GLOB = "**/pipeline/enrichment/completion-runner.ts";

interface Hit {
  id: string;
  score: number;
  payload: Record<string, unknown>;
}

function hit(id: string, relativePath: string, score = 0.5): Hit {
  return { id, score, payload: { relativePath, startLine: 1, endLine: 2 } };
}

/** Qdrant ranked source over a fixed ordered pool: returns the first `limit` hits. */
function rankedPool(pool: Hit[]) {
  return vi.fn(async (...args: unknown[]) => {
    const limit = args.find((a, i) => i > 1 && typeof a === "number") as number;
    return Promise.resolve(pool.slice(0, limit));
  });
}

const supersetHits: Hit[] = [
  hit("r1", RUNNER, 0.9),
  hit("c1", COORDINATOR, 0.85),
  hit("r2", RUNNER, 0.8),
  hit("c2", COORDINATOR, 0.75),
];

const identityReranker = { rerank: vi.fn((r: unknown[]) => r) } as unknown as Reranker;

function paths(results: { payload?: Record<string, unknown> }[]): unknown[] {
  return results.map((r) => r.payload?.relativePath);
}

// ---------------------------------------------------------------------------
// semantic_search / search_code — VectorSearchStrategy
// ---------------------------------------------------------------------------

describe("VectorSearchStrategy — exact pathPattern", () => {
  const embedding = [0.1, 0.2];

  function vectorWith(search: ReturnType<typeof vi.fn>, queryGroups?: ReturnType<typeof vi.fn>) {
    const qdrant = { search, queryGroups } as unknown as QdrantManager;
    return { qdrant, strategy: new VectorSearchStrategy(qdrant, identityReranker, [], []) };
  }

  it("drops directory siblings the text pre-filter lets through", async () => {
    const { strategy } = vectorWith(vi.fn().mockResolvedValue(supersetHits));

    const results = await strategy.execute({
      collectionName: "col",
      embedding,
      limit: 10,
      pathPattern: RUNNER_GLOB,
    });

    expect(paths(results)).toEqual([RUNNER, RUNNER]);
  });

  it("fills the page by fetching again when the superset is thin", async () => {
    const pool = [
      ...Array.from({ length: 20 }, (_, i) => hit(`c${i}`, COORDINATOR, 0.99 - i * 0.01)),
      ...Array.from({ length: 10 }, (_, i) => hit(`r${i}`, RUNNER, 0.5 - i * 0.01)),
    ];
    const search = rankedPool(pool);
    const { strategy } = vectorWith(search);

    const results = await strategy.execute({ collectionName: "col", embedding, limit: 5, pathPattern: RUNNER_GLOB });

    expect(results).toHaveLength(5);
    expect(new Set(paths(results))).toEqual(new Set([RUNNER]));
    expect(search).toHaveBeenCalledTimes(2);
    expect(search.mock.calls[1][2]).toBe((search.mock.calls[0][2] as number) * 2);
  });

  it("stops after a bounded number of fetches when nothing ever matches", async () => {
    const search = vi.fn(async (_c: string, _v: number[], limit: number) =>
      Promise.resolve(Array.from({ length: limit }, (_, i) => hit(`c${i}`, COORDINATOR))),
    );
    const { strategy } = vectorWith(search);

    const results = await strategy.execute({ collectionName: "col", embedding, limit: 5, pathPattern: RUNNER_GLOB });

    expect(results).toEqual([]);
    expect(search.mock.calls.length).toBeLessThanOrEqual(4);
  });

  it("drops test paths under a negated pattern", async () => {
    const { strategy } = vectorWith(
      vi.fn().mockResolvedValue([hit("1", "src/a.ts"), hit("2", "tests/a.test.ts"), hit("3", "src/tests/b.ts")]),
    );

    const results = await strategy.execute({
      collectionName: "col",
      embedding,
      limit: 10,
      pathPattern: "!**/tests/**",
    });

    expect(paths(results)).toEqual(["src/a.ts"]);
  });

  it("keeps every alternative of a brace pattern", async () => {
    const { strategy } = vectorWith(
      vi.fn().mockResolvedValue([hit("1", "src/a/x.ts"), hit("2", "src/c/y.ts"), hit("3", "src/b/z.ts")]),
    );

    const results = await strategy.execute({
      collectionName: "col",
      embedding,
      limit: 10,
      pathPattern: "{src/a/**,src/b/**}",
    });

    expect(paths(results)).toEqual(["src/a/x.ts", "src/b/z.ts"]);
  });

  it("answers an empty page when nothing matches exactly", async () => {
    const { strategy } = vectorWith(vi.fn().mockResolvedValue([hit("c1", COORDINATOR)]));

    await expect(
      strategy.execute({ collectionName: "col", embedding, limit: 10, pathPattern: RUNNER_GLOB }),
    ).resolves.toEqual([]);
  });

  it("sends exactly one unchanged search when no pathPattern is given", async () => {
    const filter = { must: [{ key: "language", match: { value: "typescript" } }] };
    const search = vi.fn().mockResolvedValue(supersetHits);
    const { strategy } = vectorWith(search);

    const results = await strategy.execute({ collectionName: "col", embedding, limit: 5, filter });

    expect(search.mock.calls).toEqual([["col", embedding, 20, filter]]);
    expect(paths(results)).toEqual([RUNNER, COORDINATOR, RUNNER, COORDINATOR]);
  });

  it("filters file-level groups to the files the glob names", async () => {
    const queryGroups = vi.fn().mockResolvedValue(supersetHits);
    const { strategy } = vectorWith(vi.fn(), queryGroups);

    const results = await strategy.execute({
      collectionName: "col",
      embedding,
      limit: 10,
      level: "file",
      pathPattern: RUNNER_GLOB,
    });

    expect(paths(results)).toEqual([RUNNER]);
  });
});

// ---------------------------------------------------------------------------
// hybrid_search — HybridSearchStrategy
// ---------------------------------------------------------------------------

describe("HybridSearchStrategy — exact pathPattern", () => {
  function hybridWith(hybridSearch: ReturnType<typeof vi.fn>) {
    const qdrant = {
      getCollectionInfo: vi.fn().mockResolvedValue({
        name: "col",
        vectorSize: 2,
        pointsCount: 10,
        distance: "Cosine",
        hybridEnabled: true,
      } satisfies CollectionInfo),
      hybridSearch,
    } as unknown as QdrantManager;
    return new HybridSearchStrategy(qdrant, identityReranker, [], []);
  }

  it("drops directory siblings at chunk level", async () => {
    const strategy = hybridWith(vi.fn().mockResolvedValue(supersetHits));

    const results = await strategy.execute({
      collectionName: "col",
      embedding: [0.1],
      query: "completion runner",
      limit: 10,
      pathPattern: RUNNER_GLOB,
    });

    expect(paths(results)).toEqual([RUNNER, RUNNER]);
  });

  it("filters BEFORE file grouping, so a sibling never takes a file slot", async () => {
    const strategy = hybridWith(vi.fn().mockResolvedValue([hit("c1", COORDINATOR, 0.95), ...supersetHits]));

    const results = await strategy.execute({
      collectionName: "col",
      embedding: [0.1],
      query: "completion runner",
      limit: 1,
      level: "file",
      pathPattern: RUNNER_GLOB,
    });

    expect(paths(results)).toEqual([RUNNER]);
  });

  it("fills the page by fetching again when the superset is thin", async () => {
    const pool = [
      ...Array.from({ length: 20 }, (_, i) => hit(`c${i}`, COORDINATOR, 0.99 - i * 0.01)),
      ...Array.from({ length: 10 }, (_, i) => hit(`r${i}`, RUNNER, 0.5 - i * 0.01)),
    ];
    const hybridSearch = rankedPool(pool);
    const strategy = hybridWith(hybridSearch);

    const results = await strategy.execute({
      collectionName: "col",
      embedding: [0.1],
      query: "completion runner",
      limit: 5,
      pathPattern: RUNNER_GLOB,
    });

    expect(results).toHaveLength(5);
    expect(new Set(paths(results))).toEqual(new Set([RUNNER]));
    expect(hybridSearch).toHaveBeenCalledTimes(2);
  });
});

// ---------------------------------------------------------------------------
// find_similar — SimilarSearchStrategy
// ---------------------------------------------------------------------------

describe("SimilarSearchStrategy — exact pathPattern", () => {
  const embeddings = { embedBatch: vi.fn() } as unknown as EmbeddingProvider;

  function similarWith(query: ReturnType<typeof vi.fn>) {
    const qdrant = { query } as unknown as QdrantManager;
    return new SimilarSearchStrategy(qdrant, identityReranker, [], [], embeddings, { positiveIds: ["seed"] });
  }

  it("drops directory siblings at chunk level", async () => {
    const strategy = similarWith(vi.fn().mockResolvedValue(supersetHits));

    const results = await strategy.execute({ collectionName: "col", limit: 10, pathPattern: RUNNER_GLOB });

    expect(paths(results)).toEqual([RUNNER, RUNNER]);
  });

  it("filters before file grouping", async () => {
    const strategy = similarWith(vi.fn().mockResolvedValue([hit("c1", COORDINATOR, 0.95), ...supersetHits]));

    const results = await strategy.execute({
      collectionName: "col",
      limit: 1,
      level: "file",
      pathPattern: RUNNER_GLOB,
    });

    expect(paths(results)).toEqual([RUNNER]);
  });

  it("does not let Qdrant skip superset points: the offset applies to exact matches only", async () => {
    const query = vi.fn().mockResolvedValue(supersetHits);
    const strategy = similarWith(query);

    const results = await strategy.execute({ collectionName: "col", limit: 10, offset: 1, pathPattern: RUNNER_GLOB });

    expect(query.mock.calls[0][1].offset).toBeUndefined();
    expect(results.map((r) => r.id)).toEqual(["r2"]);
  });
});

// ---------------------------------------------------------------------------
// rank_chunks — ScrollRankStrategy
// ---------------------------------------------------------------------------

describe("ScrollRankStrategy — exact pathPattern", () => {
  const sizeDescriptor: DerivedSignalDescriptor = {
    name: "chunkSize",
    description: "size",
    sources: ["methodLines"],
    defaultBound: 500,
    extract: (raw) => Math.min(1, ((raw.methodLines as number) || 0) / 500),
  };

  function rankWith(scrollOrdered: ReturnType<typeof vi.fn>) {
    const reranker = {
      rerank: vi.fn((results: RerankableResult[]) => results.map((r, i) => ({ ...r, score: 1 - i * 0.001 }))),
      getPreset: vi.fn().mockReturnValue({ chunkSize: 1 }),
      getDescriptors: vi.fn().mockReturnValue([sizeDescriptor]),
    } as unknown as Reranker;
    const qdrant = {
      scrollOrdered,
      ensurePayloadIndex: vi.fn().mockResolvedValue(true),
    } as unknown as QdrantManager;
    return new ScrollRankStrategy(qdrant, reranker, [], []);
  }

  function point(id: string, relativePath: string) {
    return { id, payload: { methodLines: 100, relativePath } };
  }

  function orderedPool(pool: ReturnType<typeof point>[]) {
    return vi.fn(async (_col: string, _orderBy: unknown, limit: number) => Promise.resolve(pool.slice(0, limit)));
  }

  it("drops directory siblings at chunk level", async () => {
    const strategy = rankWith(
      orderedPool([point("r1", RUNNER), point("c1", COORDINATOR), point("r2", RUNNER), point("c2", COORDINATOR)]),
    );

    const results = await strategy.execute({
      collectionName: "col",
      weights: { chunkSize: 1 },
      level: "chunk",
      limit: 5,
      metaOnly: false,
      pathPattern: RUNNER_GLOB,
    });

    expect(paths(results)).toEqual([RUNNER, RUNNER]);
  });

  it("drops directory siblings at file level", async () => {
    const strategy = rankWith(
      orderedPool([point("c1", COORDINATOR), point("r1", RUNNER), point("c2", COORDINATOR), point("r2", RUNNER)]),
    );

    const results = await strategy.execute({
      collectionName: "col",
      weights: { chunkSize: 1 },
      level: "file",
      limit: 5,
      metaOnly: false,
      pathPattern: RUNNER_GLOB,
    });

    expect(paths(results)).toEqual([RUNNER]);
  });

  it("fills a chunk page by scrolling further when the superset is thin", async () => {
    const scrollOrdered = orderedPool([
      ...Array.from({ length: 15 }, (_, i) => point(`c${i}`, COORDINATOR)),
      ...Array.from({ length: 10 }, (_, i) => point(`r${i}`, RUNNER)),
    ]);
    const strategy = rankWith(scrollOrdered);

    const results = await strategy.execute({
      collectionName: "col",
      weights: { chunkSize: 1 },
      level: "chunk",
      limit: 5,
      metaOnly: false,
      pathPattern: RUNNER_GLOB,
    });

    expect(results).toHaveLength(5);
    expect(new Set(paths(results))).toEqual(new Set([RUNNER]));
    expect(scrollOrdered).toHaveBeenCalledTimes(2);
  });

  it("keeps scrolling at file level while the first window held no exact match", async () => {
    const otherRunner = "lib/pipeline/enrichment/completion-runner.ts";
    const strategy = rankWith(
      orderedPool([
        ...Array.from({ length: 18 }, (_, i) => point(`c${i}`, COORDINATOR)),
        point("r1", RUNNER),
        point("o1", otherRunner),
      ]),
    );

    const results = await strategy.execute({
      collectionName: "col",
      weights: { chunkSize: 1 },
      level: "file",
      limit: 2,
      metaOnly: false,
      pathPattern: RUNNER_GLOB,
    });

    expect(new Set(paths(results))).toEqual(new Set([RUNNER, otherRunner]));
  });

  it("drops test paths under a negated pattern", async () => {
    const strategy = rankWith(orderedPool([point("1", "src/a.ts"), point("2", "tests/a.test.ts")]));

    const results = await strategy.execute({
      collectionName: "col",
      weights: { chunkSize: 1 },
      level: "chunk",
      limit: 5,
      metaOnly: false,
      pathPattern: "!**/tests/**",
    });

    expect(paths(results)).toEqual(["src/a.ts"]);
  });

  it("scrolls exactly once per order field when no pathPattern is given", async () => {
    const scrollOrdered = orderedPool([point("r1", RUNNER), point("c1", COORDINATOR)]);
    const strategy = rankWith(scrollOrdered);

    const results = await strategy.execute({
      collectionName: "col",
      weights: { chunkSize: 1 },
      level: "chunk",
      limit: 5,
      metaOnly: false,
    });

    expect(scrollOrdered).toHaveBeenCalledTimes(1);
    expect(paths(results)).toEqual([RUNNER, COORDINATOR]);
  });
});

// ---------------------------------------------------------------------------
// find_symbol — SymbolSearchStrategy
// ---------------------------------------------------------------------------

describe("SymbolSearchStrategy — exact pathPattern", () => {
  it("drops symbol chunks from directory siblings", async () => {
    const chunk = (id: string, relativePath: string, symbolId: string) => ({
      id,
      payload: { relativePath, symbolId, chunkType: "function", content: "", startLine: 1, endLine: 2 },
    });
    const qdrant = {
      scrollFiltered: vi
        .fn()
        .mockResolvedValueOnce([
          chunk("r1", RUNNER, "CompletionRunner#run"),
          chunk("c1", COORDINATOR, "Coordinator#run"),
        ])
        .mockResolvedValueOnce([]),
    } as unknown as QdrantManager;
    const registry = { buildMergedFilter: vi.fn().mockReturnValue(undefined) };
    const strategy = new SymbolSearchStrategy(qdrant, identityReranker, [], [], registry as never, {
      symbol: "run",
      pathPattern: RUNNER_GLOB,
    });

    const results = await strategy.execute({ collectionName: "col", limit: 50 });

    expect(results.length).toBeGreaterThan(0);
    expect(new Set(paths(results))).toEqual(new Set([RUNNER]));
  });
});

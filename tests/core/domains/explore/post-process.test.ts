import { describe, expect, it, vi } from "vitest";

import type { PayloadSignalDescriptor } from "../../../../src/core/contracts/types/trajectory.js";
import {
  computeFetchLimit,
  filterMetaOnly,
  postProcess,
  type SearchResult,
} from "../../../../src/core/domains/explore/post-process.js";
import type { Reranker } from "../../../../src/core/domains/explore/reranker.js";

// ---------------------------------------------------------------------------
// computeFetchLimit
// ---------------------------------------------------------------------------

describe("computeFetchLimit", () => {
  it("returns default limit of 5 when undefined", () => {
    const result = computeFetchLimit(undefined);
    expect(result.requestedLimit).toBe(5);
    expect(result.fetchLimit).toBeGreaterThanOrEqual(20);
  });

  it("uses requested limit", () => {
    const result = computeFetchLimit(10);
    expect(result.requestedLimit).toBe(10);
  });

  it("pathPattern no longer affects overfetch (pre-filter now)", () => {
    const without = computeFetchLimit(10);
    const withPattern = computeFetchLimit(10, "src/**");
    expect(withPattern.fetchLimit).toBe(without.fetchLimit);
  });

  it("applies higher overfetch with rerank (non-relevance)", () => {
    const without = computeFetchLimit(10);
    const withRerank = computeFetchLimit(10, undefined, "hotspots");
    expect(withRerank.fetchLimit).toBeGreaterThan(without.fetchLimit);
  });

  it("does not overfetch for relevance preset", () => {
    const without = computeFetchLimit(10);
    const withRelevance = computeFetchLimit(10, undefined, "relevance");
    expect(withRelevance.fetchLimit).toBe(without.fetchLimit);
  });
});

// ---------------------------------------------------------------------------
// postProcess
// ---------------------------------------------------------------------------

describe("postProcess", () => {
  const mockReranker: Reranker = {
    rerank: vi
      .fn()
      .mockImplementation((results: SearchResult[]) => results.map((r, i) => ({ ...r, score: 1 - i * 0.1 }))),
  } as unknown as Reranker;

  const sampleResults: SearchResult[] = [
    { id: "1", score: 0.9, payload: { relativePath: "src/a.ts" } },
    { id: "2", score: 0.8, payload: { relativePath: "src/b.ts" } },
    { id: "3", score: 0.7, payload: { relativePath: "test/c.test.ts" } },
  ];

  it("returns results trimmed to limit", () => {
    const result = postProcess(sampleResults, { limit: 2, reranker: mockReranker });
    expect(result).toHaveLength(2);
  });

  it("pathPattern in postProcess is a no-op (pre-filter handles it)", () => {
    const result = postProcess(sampleResults, {
      limit: 10,
      pathPattern: "src/**",
      reranker: mockReranker,
    });
    // All 3 results pass through — pathPattern is handled as Qdrant pre-filter, not post-filter
    expect(result).toHaveLength(3);
  });

  it("applies reranking for non-relevance preset", () => {
    postProcess(sampleResults, { limit: 10, rerank: "hotspots", reranker: mockReranker });
    expect(mockReranker.rerank).toHaveBeenCalledWith(sampleResults, "hotspots", "semantic_search", undefined);
  });

  it("skips reranking for relevance preset", () => {
    const reranker = { rerank: vi.fn() } as unknown as Reranker;
    postProcess(sampleResults, { limit: 10, rerank: "relevance", reranker });
    expect(reranker.rerank).not.toHaveBeenCalled();
  });

  it("skips reranking when no rerank option", () => {
    const reranker = { rerank: vi.fn() } as unknown as Reranker;
    postProcess(sampleResults, { limit: 10, reranker });
    expect(reranker.rerank).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// filterMetaOnly
// ---------------------------------------------------------------------------

describe("filterMetaOnly", () => {
  const payloadSignals: PayloadSignalDescriptor[] = [
    { key: "relativePath", type: "string", description: "File path" },
    { key: "language", type: "string", description: "Language" },
    { key: "startLine", type: "number", description: "Start line" },
  ];

  it("extracts score and payload signal fields", () => {
    const results: SearchResult[] = [
      { score: 0.9, payload: { relativePath: "src/a.ts", language: "typescript", startLine: 1, content: "code..." } },
    ];
    const meta = filterMetaOnly(results, payloadSignals, []);
    expect(meta[0].score).toBe(0.9);
    expect(meta[0].relativePath).toBe("src/a.ts");
    expect(meta[0].language).toBe("typescript");
    expect(meta[0].startLine).toBe(1);
    // content should NOT be included (not in payloadSignals)
    expect(meta[0].content).toBeUndefined();
  });

  it("includes overlay git data when overlay has data", () => {
    const results: SearchResult[] = [
      {
        score: 0.8,
        payload: { relativePath: "src/b.ts" },
        rankingOverlay: {
          preset: "techDebt",
          file: { ageDays: 100, commitCount: 5 },
        },
      },
    ];
    const meta = filterMetaOnly(results, payloadSignals, []);
    expect(meta[0].git).toEqual({ file: { ageDays: 100, commitCount: 5 } });
    expect(meta[0].derived).toBeUndefined();
    expect(meta[0].preset).toBe("techDebt");
  });

  it("filters git by essential fields when no overlay", () => {
    const results: SearchResult[] = [
      {
        score: 0.7,
        payload: {
          relativePath: "src/c.ts",
          git: { file: { ageDays: 200, commitCount: 10, authors: ["Alice"] } },
        },
      },
    ];
    const meta = filterMetaOnly(results, payloadSignals, ["git.file.ageDays", "git.file.commitCount"]);
    const git = meta[0].git as Record<string, Record<string, unknown>>;
    expect(git.file.ageDays).toBe(200);
    expect(git.file.commitCount).toBe(10);
    expect(git.file.authors).toBeUndefined(); // not essential
  });

  it("returns empty git when no essential fields match", () => {
    const results: SearchResult[] = [
      {
        score: 0.6,
        payload: {
          relativePath: "src/d.ts",
          git: { file: { ageDays: 50 } },
        },
      },
    ];
    const meta = filterMetaOnly(results, payloadSignals, ["git.chunk.commitCount"]);
    expect(meta[0].git).toBeUndefined();
  });

  it("includes chunk-level overlay data", () => {
    const results: SearchResult[] = [
      {
        score: 0.5,
        payload: { relativePath: "src/e.ts" },
        rankingOverlay: {
          preset: "hotspots",
          chunk: { commitCount: 3 },
        },
      },
    ];
    const meta = filterMetaOnly(results, payloadSignals, []);
    expect(meta[0].git).toEqual({ chunk: { commitCount: 3 } });
  });
});

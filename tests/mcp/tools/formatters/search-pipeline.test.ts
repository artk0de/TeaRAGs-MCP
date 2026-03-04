// src/tools/formatters/search-pipeline.test.ts
import { describe, expect, it, vi } from "vitest";

import type { Reranker } from "../../../../src/core/search/reranker.js";
import {
  applyPostProcessing,
  formatSearchResults,
  getSearchFetchLimit,
  resolveCollectionName,
  validateCollectionExists,
} from "../../../../src/mcp/tools/formatters/search-pipeline.js";

// Stub reranker — tests don't exercise reranking, so a no-op is sufficient
const stubReranker = { rerank: vi.fn((results: unknown[]) => results) } as unknown as Reranker;

describe("resolveCollectionName", () => {
  it("should return collection if provided", () => {
    const result = resolveCollectionName("my-collection", undefined);
    expect(result).toEqual({ collectionName: "my-collection" });
  });

  it("should resolve from path if collection not provided", () => {
    const result = resolveCollectionName(undefined, "/my/project");
    expect(result).toHaveProperty("collectionName");
    expect((result as { collectionName: string }).collectionName).toMatch(/^code_/);
  });

  it("should prefer collection over path", () => {
    const result = resolveCollectionName("explicit", "/my/project");
    expect(result).toEqual({ collectionName: "explicit" });
  });

  it("should return error if neither provided", () => {
    const result = resolveCollectionName(undefined, undefined);
    expect(result).toHaveProperty("error");
  });
});

describe("getSearchFetchLimit", () => {
  it("should return default limit of 5", () => {
    const result = getSearchFetchLimit(undefined);
    expect(result.requestedLimit).toBe(5);
    expect(result.fetchLimit).toBe(5);
  });

  it("should use provided limit", () => {
    const result = getSearchFetchLimit(20);
    expect(result.requestedLimit).toBe(20);
  });

  it("should overfetch when pathPattern is set", () => {
    const result = getSearchFetchLimit(5, "src/**");
    expect(result.fetchLimit).toBeGreaterThan(5);
  });

  it("should overfetch when rerank is non-relevance", () => {
    const result = getSearchFetchLimit(5, undefined, "hotspots");
    expect(result.fetchLimit).toBeGreaterThan(5);
  });

  it("should not overfetch for relevance rerank", () => {
    const result = getSearchFetchLimit(5, undefined, "relevance");
    expect(result.fetchLimit).toBe(5);
  });
});

describe("applyPostProcessing", () => {
  const mockResults = [
    { id: "1", score: 0.95, payload: { relativePath: "src/a.ts" } },
    { id: "2", score: 0.9, payload: { relativePath: "lib/b.ts" } },
    { id: "3", score: 0.85, payload: { relativePath: "src/c.ts" } },
  ];

  it("should trim to limit", () => {
    const result = applyPostProcessing(mockResults, { limit: 2, reranker: stubReranker });
    expect(result).toHaveLength(2);
  });

  it("should apply pathPattern filter", () => {
    const result = applyPostProcessing(mockResults, { pathPattern: "src/**", limit: 10, reranker: stubReranker });
    expect(result).toHaveLength(2);
    expect(result.every((r) => r.payload?.relativePath?.toString().startsWith("src/"))).toBe(true);
  });

  it("should return all when no filters", () => {
    const result = applyPostProcessing(mockResults, { limit: 10, reranker: stubReranker });
    expect(result).toHaveLength(3);
  });
});

describe("formatSearchResults", () => {
  it("should format full results as JSON", () => {
    const results = [{ id: "1", score: 0.9, payload: { content: "test", relativePath: "a.ts" } }];
    const output = formatSearchResults(results, false);
    expect(output.content[0].text).toContain('"score"');
    expect(output.content[0].text).toContain('"content"');
  });

  it("should format metaOnly results without content", () => {
    const results = [
      {
        id: "1",
        score: 0.9,
        payload: {
          relativePath: "src/a.ts",
          startLine: 1,
          endLine: 10,
          language: "typescript",
          chunkType: "function",
          name: "foo",
          imports: ["bar"],
          git: { file: { dominantAuthor: "John", ageDays: 10, commitCount: 5 } },
          content: "should not appear in metaOnly",
        },
      },
    ];
    const output = formatSearchResults(results, true, ["git.file.ageDays", "git.file.commitCount"]);
    const parsed = JSON.parse(output.content[0].text);
    expect(parsed[0]).not.toHaveProperty("content");
    expect(parsed[0]).toHaveProperty("relativePath", "src/a.ts");
    expect(parsed[0].git).toEqual({ file: { ageDays: 10, commitCount: 5 } });
    expect(parsed[0]).toHaveProperty("imports");
  });

  it("should include all BASE_PAYLOAD_SIGNALS in metaOnly results", () => {
    const results = [
      {
        id: "1",
        score: 0.9,
        payload: {
          relativePath: "src/reranker.ts",
          fileExtension: ".ts",
          language: "typescript",
          startLine: 45,
          endLine: 120,
          chunkIndex: 3,
          isDocumentation: false,
          chunkType: "function",
          name: "rerank",
          parentName: "Reranker",
          parentType: "class",
          symbolId: "Reranker.rerank",
          imports: ["./types.js"],
          git: { chunk: { commitCount: 5 } },
          content: "should be excluded",
        },
      },
    ];
    const output = formatSearchResults(results, true);
    const parsed = JSON.parse(output.content[0].text);
    const meta = parsed[0];

    // All BASE_PAYLOAD_SIGNALS must be present
    expect(meta).toHaveProperty("relativePath", "src/reranker.ts");
    expect(meta).toHaveProperty("fileExtension", ".ts");
    expect(meta).toHaveProperty("language", "typescript");
    expect(meta).toHaveProperty("startLine", 45);
    expect(meta).toHaveProperty("endLine", 120);
    expect(meta).toHaveProperty("chunkIndex", 3);
    expect(meta).toHaveProperty("isDocumentation", false);
    expect(meta).toHaveProperty("chunkType", "function");
    expect(meta).toHaveProperty("name", "rerank");
    expect(meta).toHaveProperty("parentName", "Reranker");
    expect(meta).toHaveProperty("parentType", "class");
    expect(meta).toHaveProperty("symbolId", "Reranker.rerank");
    expect(meta).toHaveProperty("imports");

    // Non-base fields excluded
    expect(meta).not.toHaveProperty("content");
    expect(meta).not.toHaveProperty("id");
  });

  it("should handle empty results", () => {
    const output = formatSearchResults([], false);
    expect(output.content[0].text).toBe("[]");
  });

  it("should mask git by overlay when metaOnly + rankingOverlay has data", () => {
    const results = [
      {
        id: "1",
        score: 0.9,
        payload: {
          relativePath: "src/a.ts",
          git: {
            file: { ageDays: 42, commitCount: 18, bugFixRate: 33, churnVolatility: 0.65 },
            chunk: { commitCount: 7, churnRatio: 0.39, ageDays: 5 },
          },
        },
        rankingOverlay: {
          preset: "hotspots",
          file: { bugFixRate: 33, churnVolatility: 0.65 },
          chunk: { commitCount: 7, churnRatio: 0.39 },
        },
      },
    ] as any[];
    const output = formatSearchResults(results, true, [
      "git.file.ageDays",
      "git.file.commitCount",
      "git.chunk.ageDays",
      "git.chunk.commitCount",
    ]);
    const parsed = JSON.parse(output.content[0].text);
    const meta = parsed[0];

    // git masked to overlay data only
    expect(meta.git).toEqual({
      file: { bugFixRate: 33, churnVolatility: 0.65 },
      chunk: { commitCount: 7, churnRatio: 0.39 },
    });
    // preset promoted to top-level
    expect(meta.preset).toBe("hotspots");
    // rankingOverlay removed
    expect(meta).not.toHaveProperty("rankingOverlay");
  });

  it("should use essential fields when metaOnly + no rankingOverlay", () => {
    const results = [
      {
        id: "1",
        score: 0.9,
        payload: {
          relativePath: "src/a.ts",
          git: {
            file: { ageDays: 42, commitCount: 18, bugFixRate: 33, churnVolatility: 0.65 },
            chunk: { commitCount: 7, churnRatio: 0.39, ageDays: 5 },
          },
        },
      },
    ] as any[];
    const output = formatSearchResults(results, true, [
      "git.file.ageDays",
      "git.file.commitCount",
      "git.chunk.ageDays",
      "git.chunk.commitCount",
    ]);
    const parsed = JSON.parse(output.content[0].text);
    const meta = parsed[0];

    // git filtered to essential fields only
    expect(meta.git).toEqual({
      file: { ageDays: 42, commitCount: 18 },
      chunk: { ageDays: 5, commitCount: 7 },
    });
    expect(meta).not.toHaveProperty("preset");
    expect(meta).not.toHaveProperty("rankingOverlay");
  });

  it("should use essential fields when metaOnly + empty overlay (relevance)", () => {
    const results = [
      {
        id: "1",
        score: 0.9,
        payload: {
          relativePath: "src/a.ts",
          git: {
            chunk: { commitCount: 7, churnRatio: 0.39, ageDays: 5 },
          },
        },
        rankingOverlay: { preset: "relevance" },
      },
    ] as any[];
    const output = formatSearchResults(results, true, [
      "git.file.ageDays",
      "git.file.commitCount",
      "git.chunk.ageDays",
      "git.chunk.commitCount",
    ]);
    const parsed = JSON.parse(output.content[0].text);
    const meta = parsed[0];

    // git filtered to essential fields
    expect(meta.git).toEqual({ chunk: { ageDays: 5, commitCount: 7 } });
    expect(meta.preset).toBe("relevance");
    expect(meta).not.toHaveProperty("rankingOverlay");
  });

  it("should not mask git when metaOnly=false", () => {
    const results = [
      {
        id: "1",
        score: 0.9,
        payload: {
          relativePath: "src/a.ts",
          git: { chunk: { commitCount: 7, churnRatio: 0.39 } },
        },
        rankingOverlay: { preset: "hotspots", chunk: { commitCount: 7 } },
      },
    ] as any[];
    const output = formatSearchResults(results, false, [
      "git.file.ageDays",
      "git.file.commitCount",
      "git.chunk.ageDays",
      "git.chunk.commitCount",
    ]);
    const parsed = JSON.parse(output.content[0].text);

    // Full results unchanged
    expect(parsed[0].payload.git.chunk.churnRatio).toBe(0.39);
    expect(parsed[0].rankingOverlay).toBeDefined();
  });
});

describe("validateCollectionExists", () => {
  it("should return null when collection exists", async () => {
    const mockQdrant = { collectionExists: vi.fn().mockResolvedValue(true) };
    const result = await validateCollectionExists(mockQdrant, "my-collection");
    expect(result).toBeNull();
  });

  it("should return error when collection does not exist", async () => {
    const mockQdrant = { collectionExists: vi.fn().mockResolvedValue(false) };
    const result = await validateCollectionExists(mockQdrant, "missing");
    expect(result).not.toBeNull();
    expect(result?.isError).toBe(true);
    expect(result?.content[0].text).toContain("missing");
  });

  it("should include path info in error when provided", async () => {
    const mockQdrant = { collectionExists: vi.fn().mockResolvedValue(false) };
    const result = await validateCollectionExists(mockQdrant, "missing", "/my/project");
    expect(result?.content[0].text).toContain("/my/project");
    expect(result?.content[0].text).toContain("not be indexed");
  });
});

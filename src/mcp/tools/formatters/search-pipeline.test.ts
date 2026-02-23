// src/tools/formatters/search-pipeline.test.ts
import { describe, expect, it, vi } from "vitest";
import {
  applyPostProcessing,
  formatSearchResults,
  getSearchFetchLimit,
  resolveCollectionName,
  validateCollectionExists,
} from "./search-pipeline.js";

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
    const result = applyPostProcessing(mockResults, { limit: 2 });
    expect(result).toHaveLength(2);
  });

  it("should apply pathPattern filter", () => {
    const result = applyPostProcessing(mockResults, { pathPattern: "src/**", limit: 10 });
    expect(result).toHaveLength(2);
    expect(result.every((r) => r.payload?.relativePath?.toString().startsWith("src/"))).toBe(true);
  });

  it("should return all when no filters", () => {
    const result = applyPostProcessing(mockResults, { limit: 10 });
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
          git: { dominantAuthor: "John" },
          content: "should not appear in metaOnly",
        },
      },
    ];
    const output = formatSearchResults(results, true);
    const parsed = JSON.parse(output.content[0].text);
    expect(parsed[0]).not.toHaveProperty("content");
    expect(parsed[0]).toHaveProperty("relativePath", "src/a.ts");
    expect(parsed[0]).toHaveProperty("git");
    expect(parsed[0]).toHaveProperty("imports");
  });

  it("should handle empty results", () => {
    const output = formatSearchResults([], false);
    expect(output.content[0].text).toBe("[]");
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

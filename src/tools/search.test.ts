import { beforeEach, describe, expect, it, vi } from "vitest";

import { calculateFetchLimit, filterResultsByGlob } from "../qdrant/filters/index.js";

// Test the glob filtering integration
describe("Search tools glob filtering", () => {
  describe("filterResultsByGlob", () => {
    const mockResults = [
      {
        id: "1",
        score: 0.95,
        payload: { relativePath: "src/api/users.ts", content: "user code" },
      },
      {
        id: "2",
        score: 0.9,
        payload: { relativePath: "src/api/posts.ts", content: "post code" },
      },
      {
        id: "3",
        score: 0.85,
        payload: { relativePath: "src/utils/helpers.ts", content: "helper code" },
      },
      {
        id: "4",
        score: 0.8,
        payload: { relativePath: "lib/core.ts", content: "core code" },
      },
    ];

    it("should filter results when pathPattern is provided", () => {
      const filtered = filterResultsByGlob(mockResults, "src/api/**");

      expect(filtered).toHaveLength(2);
      expect(filtered.every((r) => r.payload?.relativePath?.startsWith("src/api/"))).toBe(true);
    });

    it("should return all results when pathPattern matches everything", () => {
      const filtered = filterResultsByGlob(mockResults, "**/*.ts");

      expect(filtered).toHaveLength(4);
    });

    it("should return empty array when pathPattern matches nothing", () => {
      const filtered = filterResultsByGlob(mockResults, "nonexistent/**");

      expect(filtered).toHaveLength(0);
    });

    it("should support domain-style glob patterns", () => {
      const domainResults = [
        { id: "1", score: 0.9, payload: { relativePath: "models/workflow/task.ts" } },
        { id: "2", score: 0.85, payload: { relativePath: "services/workflow/exec.ts" } },
        { id: "3", score: 0.8, payload: { relativePath: "services/auth/login.ts" } },
      ];

      const filtered = filterResultsByGlob(domainResults, "**/workflow/**");

      expect(filtered).toHaveLength(2);
      expect(filtered.every((r) => r.payload?.relativePath?.includes("workflow"))).toBe(true);
    });

    it("should support brace expansion patterns", () => {
      const filtered = filterResultsByGlob(mockResults, "{src/api,lib}/**");

      expect(filtered).toHaveLength(3);
      filtered.forEach((r) => {
        const path = r.payload?.relativePath;
        expect(path?.startsWith("src/api/") || path?.startsWith("lib/")).toBe(true);
      });
    });
  });

  describe("calculateFetchLimit", () => {
    it("should return original limit when no pathPattern", () => {
      expect(calculateFetchLimit(5, false)).toBe(5);
      expect(calculateFetchLimit(10, false)).toBe(10);
    });

    it("should multiply limit by 3 when pathPattern is provided", () => {
      expect(calculateFetchLimit(5, true)).toBe(15);
      expect(calculateFetchLimit(10, true)).toBe(30);
    });

    it("should use custom multiplier when provided", () => {
      expect(calculateFetchLimit(5, true, 5)).toBe(25);
    });
  });

  describe("semantic_search pathPattern integration", () => {
    it("should apply glob filter when pathPattern parameter is passed", () => {
      // Simulate what happens in semantic_search handler
      const mockQdrantResults = [
        { id: "1", score: 0.95, payload: { relativePath: "src/api/users.ts" } },
        { id: "2", score: 0.9, payload: { relativePath: "lib/utils.ts" } },
      ];
      const pathPattern = "src/**";
      const requestedLimit = 5;

      // This is the logic from search.ts
      const filteredResults = pathPattern
        ? filterResultsByGlob(mockQdrantResults, pathPattern).slice(0, requestedLimit)
        : mockQdrantResults;

      expect(filteredResults).toHaveLength(1);
      expect(filteredResults[0].payload?.relativePath).toBe("src/api/users.ts");
    });

    it("should not filter when pathPattern is not provided", () => {
      const mockQdrantResults = [
        { id: "1", score: 0.95, payload: { relativePath: "src/api/users.ts" } },
        { id: "2", score: 0.9, payload: { relativePath: "lib/utils.ts" } },
      ];
      const pathPattern = undefined;

      const filteredResults = pathPattern
        ? filterResultsByGlob(mockQdrantResults, pathPattern).slice(0, 5)
        : mockQdrantResults;

      expect(filteredResults).toHaveLength(2);
    });
  });

  describe("hybrid_search pathPattern integration", () => {
    it("should apply glob filter when pathPattern parameter is passed", () => {
      const mockQdrantResults = [
        { id: "1", score: 0.95, payload: { relativePath: "models/workflow/task.ts" } },
        { id: "2", score: 0.9, payload: { relativePath: "models/auth/user.ts" } },
        { id: "3", score: 0.85, payload: { relativePath: "services/workflow/exec.ts" } },
      ];
      const pathPattern = "**/workflow/**";
      const requestedLimit = 10;

      const filteredResults = pathPattern
        ? filterResultsByGlob(mockQdrantResults, pathPattern).slice(0, requestedLimit)
        : mockQdrantResults;

      expect(filteredResults).toHaveLength(2);
      expect(filteredResults.every((r) => r.payload?.relativePath?.includes("workflow"))).toBe(true);
    });
  });

  describe("search_code pathPattern integration", () => {
    it("should apply glob filter in searchCode method", () => {
      // Simulate indexer.searchCode behavior
      const mockQdrantResults = [
        { id: "1", score: 0.95, payload: { relativePath: "src/services/auth.ts" } },
        { id: "2", score: 0.9, payload: { relativePath: "src/services/user.ts" } },
        { id: "3", score: 0.85, payload: { relativePath: "tests/services/auth.test.ts" } },
      ];
      const pathPattern = "src/**";

      const globFilteredResults = pathPattern ? filterResultsByGlob(mockQdrantResults, pathPattern) : mockQdrantResults;

      expect(globFilteredResults).toHaveLength(2);
      expect(globFilteredResults.every((r) => r.payload?.relativePath?.startsWith("src/"))).toBe(true);
    });
  });
});

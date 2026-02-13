import { describe, expect, it } from "vitest";

import {
  calculateFetchLimit,
  createGlobMatcher,
  filterResultsByGlob,
  type ResultWithPath,
} from "../../../src/qdrant/filters/glob.js";

describe("createGlobMatcher", () => {
  it("should match simple wildcard pattern", () => {
    const isMatch = createGlobMatcher("*.ts");
    expect(isMatch("file.ts")).toBe(true);
    expect(isMatch("file.js")).toBe(false);
    // With bash mode, * can match across directories
    expect(isMatch("dir/file.ts")).toBe(true);
  });

  it("should match double wildcard pattern", () => {
    const isMatch = createGlobMatcher("**/*.ts");
    expect(isMatch("file.ts")).toBe(true);
    expect(isMatch("src/file.ts")).toBe(true);
    expect(isMatch("src/deep/nested/file.ts")).toBe(true);
    expect(isMatch("file.js")).toBe(false);
  });

  it("should match domain pattern", () => {
    const isMatch = createGlobMatcher("**/workflow/**");
    expect(isMatch("models/workflow/task.ts")).toBe(true);
    expect(isMatch("services/workflow/handler.ts")).toBe(true);
    expect(isMatch("workflow/index.ts")).toBe(true);
    expect(isMatch("src/utils/helper.ts")).toBe(false);
  });

  it("should match brace expansion", () => {
    const isMatch = createGlobMatcher("{models,services}/workflow/**");
    expect(isMatch("models/workflow/task.ts")).toBe(true);
    expect(isMatch("services/workflow/handler.ts")).toBe(true);
    expect(isMatch("controllers/workflow/api.ts")).toBe(false);
  });

  it("should match directory pattern", () => {
    const isMatch = createGlobMatcher("src/**");
    expect(isMatch("src/file.ts")).toBe(true);
    expect(isMatch("src/deep/file.ts")).toBe(true);
    expect(isMatch("lib/file.ts")).toBe(false);
  });

  it("should match single character wildcard", () => {
    const isMatch = createGlobMatcher("file?.ts");
    expect(isMatch("file1.ts")).toBe(true);
    expect(isMatch("fileA.ts")).toBe(true);
    expect(isMatch("file.ts")).toBe(false);
    expect(isMatch("file12.ts")).toBe(false);
  });

  it("should handle patterns with dots", () => {
    const isMatch = createGlobMatcher("**/*.test.ts");
    expect(isMatch("file.test.ts")).toBe(true);
    expect(isMatch("src/utils/helper.test.ts")).toBe(true);
    expect(isMatch("file.spec.ts")).toBe(false);
  });
});

describe("filterResultsByGlob", () => {
  const createResult = (relativePath: string): ResultWithPath => ({
    id: `id-${relativePath}`,
    score: 0.9,
    payload: { relativePath, content: "test content" },
  });

  const mockResults: ResultWithPath[] = [
    createResult("models/workflow/task.ts"),
    createResult("services/workflow/handler.ts"),
    createResult("src/utils/helper.ts"),
    createResult("controllers/api/routes.ts"),
    createResult("workflow/index.ts"),
  ];

  it("should filter by domain pattern", () => {
    const filtered = filterResultsByGlob(mockResults, "**/workflow/**");
    expect(filtered).toHaveLength(3);
    expect(filtered.map((r) => r.payload?.relativePath)).toEqual([
      "models/workflow/task.ts",
      "services/workflow/handler.ts",
      "workflow/index.ts",
    ]);
  });

  it("should filter by directory pattern", () => {
    const filtered = filterResultsByGlob(mockResults, "src/**");
    expect(filtered).toHaveLength(1);
    expect(filtered[0].payload?.relativePath).toBe("src/utils/helper.ts");
  });

  it("should return empty array when no matches", () => {
    const filtered = filterResultsByGlob(mockResults, "**/nonexistent/**");
    expect(filtered).toHaveLength(0);
  });

  it("should return all results when pattern matches everything", () => {
    const filtered = filterResultsByGlob(mockResults, "**/*");
    expect(filtered).toHaveLength(5);
  });

  it("should handle empty results array", () => {
    const filtered = filterResultsByGlob([], "**/workflow/**");
    expect(filtered).toHaveLength(0);
  });

  it("should handle results without payload", () => {
    const results: ResultWithPath[] = [{ id: "1", score: 0.9 }, createResult("models/workflow/task.ts")];
    const filtered = filterResultsByGlob(results, "**/workflow/**");
    expect(filtered).toHaveLength(1);
  });

  it("should handle results with null relativePath", () => {
    const results: ResultWithPath[] = [
      { id: "1", score: 0.9, payload: { relativePath: undefined } },
      createResult("models/workflow/task.ts"),
    ];
    const filtered = filterResultsByGlob(results, "**/workflow/**");
    expect(filtered).toHaveLength(1);
  });

  it("should preserve result structure", () => {
    const results: ResultWithPath[] = [
      {
        id: "test-id",
        score: 0.95,
        payload: {
          relativePath: "models/workflow/task.ts",
          content: "function test() {}",
          startLine: 1,
          endLine: 10,
        },
      },
    ];
    const filtered = filterResultsByGlob(results, "**/workflow/**");
    expect(filtered).toHaveLength(1);
    expect(filtered[0]).toEqual(results[0]);
  });

  it("should filter with brace expansion", () => {
    const filtered = filterResultsByGlob(mockResults, "{models,services}/**/*.ts");
    expect(filtered).toHaveLength(2);
    expect(filtered.map((r) => r.payload?.relativePath)).toEqual([
      "models/workflow/task.ts",
      "services/workflow/handler.ts",
    ]);
  });
});

describe("calculateFetchLimit", () => {
  it("should return original limit when no pattern", () => {
    expect(calculateFetchLimit(10, false)).toBe(10);
    expect(calculateFetchLimit(5, false)).toBe(5);
  });

  it("should multiply limit when pattern exists", () => {
    expect(calculateFetchLimit(10, true)).toBe(30);
    expect(calculateFetchLimit(5, true)).toBe(15);
  });

  it("should use custom multiplier", () => {
    expect(calculateFetchLimit(10, true, 5)).toBe(50);
    expect(calculateFetchLimit(10, true, 2)).toBe(20);
  });

  it("should handle edge cases", () => {
    expect(calculateFetchLimit(0, true)).toBe(0);
    expect(calculateFetchLimit(1, true)).toBe(3);
  });
});

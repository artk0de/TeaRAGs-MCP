import { describe, expect, it } from "vitest";

import { staticFilters } from "../../../../../src/core/domains/trajectory/static/filters.js";

describe("staticFilters", () => {
  it("has 6 filters", () => {
    expect(staticFilters).toHaveLength(6);
  });

  it("language filter produces must condition", () => {
    const f = staticFilters.find((f) => f.param === "language")!;
    const result = f.toCondition("typescript");
    expect(result.must).toEqual([{ key: "language", match: { value: "typescript" } }]);
  });

  it("chunkType filter produces must condition", () => {
    const f = staticFilters.find((f) => f.param === "chunkType")!;
    const result = f.toCondition("function");
    expect(result.must).toEqual([{ key: "chunkType", match: { value: "function" } }]);
  });

  it("fileExtension filter produces must condition for string", () => {
    const f = staticFilters.find((f) => f.param === "fileExtension")!;
    const result = f.toCondition(".ts");
    expect(result.must).toEqual([{ key: "fileExtension", match: { value: ".ts" } }]);
  });

  it("fileExtension filter produces must condition with match.any for array", () => {
    const f = staticFilters.find((f) => f.param === "fileExtension")!;
    const result = f.toCondition([".ts", ".py"]);
    expect(result.must).toEqual([{ key: "fileExtension", match: { any: [".ts", ".py"] } }]);
  });

  it("fileExtension filter with empty array produces no conditions", () => {
    const f = staticFilters.find((f) => f.param === "fileExtension")!;
    const result = f.toCondition([]);
    expect(result.must).toBeUndefined();
  });

  it("documentation='only' produces must condition", () => {
    const f = staticFilters.find((f) => f.param === "documentation")!;
    const result = f.toCondition("only");
    expect(result.must).toEqual([{ key: "isDocumentation", match: { value: true } }]);
  });

  it("documentation='exclude' produces must_not condition", () => {
    const f = staticFilters.find((f) => f.param === "documentation")!;
    const result = f.toCondition("exclude");
    expect(result.must_not).toEqual([{ key: "isDocumentation", match: { value: true } }]);
    expect(result.must).toBeUndefined();
  });

  it("documentation='include' produces no conditions", () => {
    const f = staticFilters.find((f) => f.param === "documentation")!;
    const result = f.toCondition("include");
    expect(result.must).toBeUndefined();
    expect(result.must_not).toBeUndefined();
  });

  it("pathPattern filter produces text match condition from glob", () => {
    const f = staticFilters.find((f) => f.param === "pathPattern")!;
    const result = f.toCondition("src/core/domains/**");
    expect(result.must).toEqual([{ key: "relativePath", match: { text: "src/core/domains/" } }]);
  });

  it("pathPattern filter with pure wildcard produces no conditions", () => {
    const f = staticFilters.find((f) => f.param === "pathPattern")!;
    const result = f.toCondition("**/*");
    expect(result.must).toBeUndefined();
  });

  it("symbolId filter produces text match condition", () => {
    const f = staticFilters.find((f) => f.param === "symbolId")!;
    expect(f).toBeDefined();
    const result = f.toCondition("ExploreFacade.semanticSearch");
    expect(result.must).toEqual([{ key: "symbolId", match: { text: "ExploreFacade.semanticSearch" } }]);
  });

  it("symbolId filter works with partial class name", () => {
    const f = staticFilters.find((f) => f.param === "symbolId")!;
    const result = f.toCondition("ExploreFacade");
    expect(result.must).toEqual([{ key: "symbolId", match: { text: "ExploreFacade" } }]);
  });

  it("symbolId filter works with method name only", () => {
    const f = staticFilters.find((f) => f.param === "symbolId")!;
    const result = f.toCondition("semanticSearch");
    expect(result.must).toEqual([{ key: "symbolId", match: { text: "semanticSearch" } }]);
  });
});

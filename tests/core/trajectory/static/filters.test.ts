import { describe, expect, it } from "vitest";

import { staticFilters } from "../../../../src/core/trajectory/static/filters.js";

describe("staticFilters", () => {
  it("has 7 filters", () => {
    expect(staticFilters).toHaveLength(7);
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

  it("isDocumentation filter produces must condition", () => {
    const f = staticFilters.find((f) => f.param === "isDocumentation")!;
    const result = f.toCondition(true);
    expect(result.must).toEqual([{ key: "isDocumentation", match: { value: true } }]);
  });

  it("fileExtension filter produces must condition", () => {
    const f = staticFilters.find((f) => f.param === "fileExtension")!;
    const result = f.toCondition(".ts");
    expect(result.must).toEqual([{ key: "fileExtension", match: { value: ".ts" } }]);
  });

  it("excludeDocumentation=true produces must_not condition", () => {
    const f = staticFilters.find((f) => f.param === "excludeDocumentation")!;
    const result = f.toCondition(true);
    expect(result.must_not).toEqual([{ key: "isDocumentation", match: { value: true } }]);
    expect(result.must).toBeUndefined();
  });

  it("excludeDocumentation=false produces no conditions", () => {
    const f = staticFilters.find((f) => f.param === "excludeDocumentation")!;
    const result = f.toCondition(false);
    expect(result.must).toBeUndefined();
    expect(result.must_not).toBeUndefined();
  });

  it("fileTypes produces must condition with match.any", () => {
    const f = staticFilters.find((f) => f.param === "fileTypes")!;
    const result = f.toCondition([".ts", ".py"]);
    expect(result.must).toEqual([{ key: "fileExtension", match: { any: [".ts", ".py"] } }]);
  });

  it("fileTypes with empty array produces no conditions", () => {
    const f = staticFilters.find((f) => f.param === "fileTypes")!;
    const result = f.toCondition([]);
    expect(result.must).toBeUndefined();
  });

  it("documentationOnly=true produces must condition", () => {
    const f = staticFilters.find((f) => f.param === "documentationOnly")!;
    const result = f.toCondition(true);
    expect(result.must).toEqual([{ key: "isDocumentation", match: { value: true } }]);
  });

  it("documentationOnly=false produces no conditions", () => {
    const f = staticFilters.find((f) => f.param === "documentationOnly")!;
    const result = f.toCondition(false);
    expect(result.must).toBeUndefined();
  });
});

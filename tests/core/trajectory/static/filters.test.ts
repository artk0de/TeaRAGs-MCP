import { describe, expect, it } from "vitest";

import { staticFilters } from "../../../../src/core/trajectory/static/filters.js";

describe("staticFilters", () => {
  it("has 4 filters", () => {
    expect(staticFilters).toHaveLength(4);
  });

  it("language filter produces correct condition", () => {
    const f = staticFilters.find((f) => f.param === "language")!;
    const conditions = f.toCondition("typescript");
    expect(conditions).toEqual([{ key: "language", match: { value: "typescript" } }]);
  });

  it("chunkType filter produces correct condition", () => {
    const f = staticFilters.find((f) => f.param === "chunkType")!;
    const conditions = f.toCondition("function");
    expect(conditions).toEqual([{ key: "chunkType", match: { value: "function" } }]);
  });

  it("isDocumentation filter produces correct condition", () => {
    const f = staticFilters.find((f) => f.param === "isDocumentation")!;
    const conditions = f.toCondition(true);
    expect(conditions).toEqual([{ key: "isDocumentation", match: { value: true } }]);
  });

  it("fileExtension filter produces correct condition", () => {
    const f = staticFilters.find((f) => f.param === "fileExtension")!;
    const conditions = f.toCondition(".ts");
    expect(conditions).toEqual([{ key: "fileExtension", match: { value: ".ts" } }]);
  });
});

import { describe, expect, it } from "vitest";

import { DeclaredVisibilityIndex } from "../../../src/core/infra/declared-visibility-index.js";

describe("DeclaredVisibilityIndex (bd tea-rags-mcp-sqqkz)", () => {
  const index = DeclaredVisibilityIndex.fromRows([
    { relPath: "src/a.ts", symbolId: "A#helper", visibility: "private" },
    { relPath: "src/b.ts", symbolId: "A#helper", visibility: "public" },
    { relPath: "src/a.ts", symbolId: "A#hook", visibility: "protected" },
    { relPath: "src/a.ts", symbolId: "A#unknown", visibility: null },
    { relPath: "src/a.ts", symbolId: "A#run", visibility: "public" },
    { relPath: "src/c.ts", symbolId: "A#run", visibility: "public" },
    { relPath: "src/a.ts", symbolId: "A#half", visibility: "private" },
    { relPath: "src/c.ts", symbolId: "A#half", visibility: null },
  ]);

  it("answers the definition at (relPath, symbolId), not a namesake", () => {
    expect(index.at("src/a.ts", "A#helper")).toBe("private");
    expect(index.at("src/b.ts", "A#helper")).toBe("public");
    expect(index.at("src/a.ts", "A#hook")).toBe("protected");
  });

  it("answers undefined for a NULL column, an unknown file, or an unknown symbol", () => {
    expect(index.at("src/a.ts", "A#unknown")).toBeUndefined();
    expect(index.at("src/z.ts", "A#helper")).toBeUndefined();
    expect(index.at("src/a.ts", "Nope#x")).toBeUndefined();
  });

  it("agreedFor answers only when every definition of a bare id states the same level", () => {
    expect(index.agreedFor("A#run")).toBe("public");
    expect(index.agreedFor("A#hook")).toBe("protected");
    expect(index.agreedFor("A#helper")).toBeUndefined(); // namesakes disagree
    expect(index.agreedFor("A#half")).toBeUndefined(); // one namesake unknown
    expect(index.agreedFor("A#unknown")).toBeUndefined();
    expect(index.agreedFor("Nope#x")).toBeUndefined();
  });

  it("EMPTY knows nothing", () => {
    expect(DeclaredVisibilityIndex.EMPTY.at("src/a.ts", "A#helper")).toBeUndefined();
    expect(DeclaredVisibilityIndex.EMPTY.agreedFor("A#helper")).toBeUndefined();
    expect(DeclaredVisibilityIndex.EMPTY.isEmpty).toBe(true);
    expect(index.isEmpty).toBe(false);
  });

  it("a set of only NULL rows is empty", () => {
    const allNull = DeclaredVisibilityIndex.fromRows([{ relPath: "a.ts", symbolId: "x", visibility: null }]);
    expect(allNull.isEmpty).toBe(true);
  });
});

import { describe, expect, it } from "vitest";

import { extensionsForLanguages } from "../../../../../../src/core/domains/ingest/pipeline/chunker/config.js";

describe("extensionsForLanguages", () => {
  it("returns every extension a language owns", () => {
    // A language is not one extension: restricting a run to typescript that
    // forgot .tsx would silently skip most of a React codebase.
    expect(extensionsForLanguages(["typescript"]).sort()).toEqual([".ts", ".tsx"]);
  });

  it("unions the extensions of several languages", () => {
    const result = extensionsForLanguages(["ruby", "python"]);
    expect(result).toContain(".rb");
    expect(result).toContain(".py");
  });

  it("matches case-insensitively, as the selector does", () => {
    expect(extensionsForLanguages(["TypeScript"])).toContain(".ts");
  });

  it("de-duplicates when two languages are asked for once each", () => {
    const result = extensionsForLanguages(["typescript", "typescript"]);
    expect(result.filter((e) => e === ".ts")).toHaveLength(1);
  });

  it("yields nothing for a language no extension maps to", () => {
    // Validation refuses unknown languages before this point; the function
    // stays total rather than throwing a second, redundant error.
    expect(extensionsForLanguages(["cobol"])).toEqual([]);
  });

  it("yields nothing for an empty request", () => {
    expect(extensionsForLanguages([])).toEqual([]);
  });
});

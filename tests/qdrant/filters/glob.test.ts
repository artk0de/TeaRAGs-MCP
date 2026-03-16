import { describe, expect, it } from "vitest";

import { globToTextFilter } from "../../../src/core/adapters/qdrant/filters/glob.js";

describe("globToTextFilter", () => {
  it("converts directory glob to text match with trailing slash", () => {
    const result = globToTextFilter("src/core/domains/explore/**");
    expect(result.must).toEqual([{ key: "relativePath", match: { text: "src/core/domains/explore/" } }]);
  });

  it("converts middle wildcard to text match", () => {
    const result = globToTextFilter("**/workflow/**");
    expect(result.must).toEqual([{ key: "relativePath", match: { text: "workflow/" } }]);
  });

  it("converts extension pattern", () => {
    const result = globToTextFilter("**/*.ts");
    expect(result.must).toEqual([{ key: "relativePath", match: { text: ".ts" } }]);
  });

  it("returns empty for pure wildcard", () => {
    expect(globToTextFilter("**/*")).toEqual({});
    expect(globToTextFilter("**")).toEqual({});
  });

  it("handles negation → must_not", () => {
    const result = globToTextFilter("!**/explore/**");
    expect(result.must_not).toEqual([{ key: "relativePath", match: { text: "explore/" } }]);
    expect(result.must).toBeUndefined();
  });

  it("handles brace expansion → should (OR)", () => {
    const result = globToTextFilter("{src/bootstrap/**,src/mcp/**}");
    expect(result.must).toBeDefined();
    expect(result.must).toHaveLength(1);
    expect(result.must_not).toBeUndefined();
  });

  it("handles single brace alternative → must", () => {
    const result = globToTextFilter("{src/core/**}");
    expect(result.must).toEqual([{ key: "relativePath", match: { text: "src/core/" } }]);
  });

  it("handles brace + negation → must + must_not", () => {
    const result = globToTextFilter("{src/core/adapters/**,!**/filters/**}");
    expect(result.must).toBeDefined();
    expect(result.must_not).toEqual([{ key: "relativePath", match: { text: "filters/" } }]);
  });

  it("handles deep path", () => {
    const result = globToTextFilter("src/core/domains/ingest/pipeline/**");
    expect(result.must).toEqual([{ key: "relativePath", match: { text: "src/core/domains/ingest/pipeline/" } }]);
  });

  it("handles path with file extension wildcard", () => {
    const result = globToTextFilter("src/core/adapters/qdrant/*.ts");
    expect(result.must).toEqual([{ key: "relativePath", match: { text: "src/core/adapters/qdrant/.ts" } }]);
  });

  it("handles nested braces in brace expansion", () => {
    const result = globToTextFilter("{src/{core,mcp}/**,lib/**}");
    expect(result.must).toBeDefined();
  });

  it("handles brace with all negations (no positive)", () => {
    const result = globToTextFilter("{!**/test/**,!**/dist/**}");
    expect(result.must).toBeUndefined();
    expect(result.must_not).toHaveLength(2);
  });

  it("negation of pure wildcard returns empty", () => {
    expect(globToTextFilter("!**")).toEqual({});
    expect(globToTextFilter("!**/*")).toEqual({});
  });

  it("brace with all-wildcard alternatives returns empty", () => {
    expect(globToTextFilter("{**,**/*}")).toEqual({});
  });
});

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

  it("handles inline brace expansion mid-path → should (OR)", () => {
    // **/pipelines/{batch_create,jobs/create}** → OR of two path queries
    const result = globToTextFilter("**/pipelines/{batch_create,jobs/create}**");
    expect(result.must).toBeDefined();
    expect(result.must).toHaveLength(1);
    // Should contain a `should` OR clause with 2 alternatives
    const shouldClause = (result.must as unknown[])[0] as { should: unknown[] };
    expect(shouldClause.should).toHaveLength(2);
  });

  it("handles inline brace with 3 alternatives", () => {
    const result = globToTextFilter("**/workflow/{stage_clients/batch_create,jobs/create,automations}/**");
    expect(result.must).toBeDefined();
    const shouldClause = (result.must as unknown[])[0] as { should: unknown[] };
    expect(shouldClause.should).toHaveLength(3);
    // Each alternative should include the common prefix "workflow/"
    for (const cond of shouldClause.should as { key: string; match: { text: string } }[]) {
      expect(cond.match.text).toContain("workflow/");
    }
  });

  it("handles inline brace with single alternative (no OR needed)", () => {
    const result = globToTextFilter("src/{core}/**");
    expect(result.must).toEqual([{ key: "relativePath", match: { text: "src/core/" } }]);
  });

  it("strips orphaned filename fragments after wildcard removal", () => {
    // spec/services/workflow/**/*_spec.rb → should keep only directory prefix
    const result = globToTextFilter("spec/services/workflow/**/*_spec.rb");
    expect(result.must).toEqual([{ key: "relativePath", match: { text: "spec/services/workflow/" } }]);
  });

  it("keeps extension pattern after directory prefix", () => {
    // src/core/**/*.test.ts → keeps ".test.ts" (pure extension, starts with ".")
    const result = globToTextFilter("src/core/**/*.test.ts");
    expect(result.must).toEqual([{ key: "relativePath", match: { text: "src/core/.test.ts" } }]);
  });

  it("preserves extension-only patterns like **/*.ts", () => {
    // This existing behavior should remain — extension is the only useful part
    const result = globToTextFilter("**/*.ts");
    expect(result.must).toEqual([{ key: "relativePath", match: { text: ".ts" } }]);
  });
});

import { describe, expect, it } from "vitest";

import { mergeQdrantFilters } from "../../../../../src/core/adapters/qdrant/filters/utils.js";

describe("mergeQdrantFilters", () => {
  it("returns undefined when both are undefined", () => {
    expect(mergeQdrantFilters(undefined, undefined)).toBeUndefined();
  });

  it("returns a when b is undefined", () => {
    const a = { must: [{ key: "lang", match: { value: "ts" } }] };
    expect(mergeQdrantFilters(a, undefined)).toEqual(a);
  });

  it("returns b when a is undefined", () => {
    const b = { must: [{ key: "lang", match: { value: "ts" } }] };
    expect(mergeQdrantFilters(undefined, b)).toEqual(b);
  });

  it("merges must arrays", () => {
    const a = { must: [{ key: "lang", match: { value: "ts" } }] };
    const b = { must: [{ key: "path", match: { value: "src/" } }] };
    const result = mergeQdrantFilters(a, b);
    expect(result?.must).toHaveLength(2);
  });

  it("merges must_not arrays", () => {
    const a = { must_not: [{ key: "isDoc", match: { value: true } }] };
    const b = { must_not: [{ key: "lang", match: { value: "md" } }] };
    const result = mergeQdrantFilters(a, b);
    expect(result?.must_not).toHaveLength(2);
  });

  it("preserves should from raw filter (b) only", () => {
    const a = { should: [{ key: "type", match: { value: "fn" } }] };
    const b = {
      should: [{ key: "path", match: { value: "src/" } }],
      must: [{ key: "lang", match: { value: "ts" } }],
    };
    const result = mergeQdrantFilters(a, b);
    expect(result?.should).toHaveLength(1);
    expect(result?.should?.[0]).toEqual({
      key: "path",
      match: { value: "src/" },
    });
    expect(result?.must).toHaveLength(1);
  });

  it("handles empty arrays gracefully", () => {
    const a = { must: [] };
    const b = { must: [{ key: "lang", match: { value: "ts" } }] };
    const result = mergeQdrantFilters(a, b);
    expect(result?.must).toHaveLength(1);
  });
});

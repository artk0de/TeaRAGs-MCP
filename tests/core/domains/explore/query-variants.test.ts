import { describe, expect, it } from "vitest";

import { InvalidQueryError } from "../../../../src/core/domains/explore/errors/index.js";
import {
  MAX_QUERY_VARIANTS,
  QUERY_VARIANT_SEPARATOR,
  splitQueryVariants,
} from "../../../../src/core/domains/explore/query-variants.js";

describe("splitQueryVariants", () => {
  it("returns a plain string query verbatim, untrimmed (the single-query path is unchanged)", () => {
    expect(splitQueryVariants("  rate limit  ")).toEqual(["  rate limit  "]);
  });

  it("splits a string on the ||| separator, trims each variant and drops empty ones", () => {
    expect(QUERY_VARIANT_SEPARATOR).toBe("|||");
    expect(splitQueryVariants("rate limit ||| retry after|||  ||| throttle")).toEqual([
      "rate limit",
      "retry after",
      "throttle",
    ]);
  });

  it("treats an array as the same variant list: trimmed, empties dropped, separators inside split too", () => {
    expect(splitQueryVariants([" rate limit ", "", "retry after ||| throttle"])).toEqual([
      "rate limit",
      "retry after",
      "throttle",
    ]);
  });

  it("collapses a one-element list to its single variant", () => {
    expect(splitQueryVariants(["rate limit"])).toEqual(["rate limit"]);
  });

  it("rejects a query whose variants are all empty", () => {
    expect(() => splitQueryVariants(" ||| ")).toThrow(InvalidQueryError);
    expect(() => splitQueryVariants([" ", ""])).toThrow(InvalidQueryError);
  });

  it(`rejects more than ${MAX_QUERY_VARIANTS} variants`, () => {
    expect(MAX_QUERY_VARIANTS).toBe(5);
    const six = Array.from({ length: 6 }, (_, i) => `q${i}`);
    expect(() => splitQueryVariants(six)).toThrow(InvalidQueryError);
    expect(() => splitQueryVariants(six.join(" ||| "))).toThrow(InvalidQueryError);
    expect(splitQueryVariants(six.slice(0, 5))).toHaveLength(5);
  });
});

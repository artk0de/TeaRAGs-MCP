/**
 * validateFindSimilarRequest — extracted from ExploreFacade.findSimilar.
 */

import { describe, expect, it } from "vitest";

import { validateFindSimilarRequest } from "../../../../../src/core/api/internal/facades/explore-facade.js";

describe("validateFindSimilarRequest", () => {
  it("accepts request with positive ids only", () => {
    expect(() => {
      validateFindSimilarRequest({ positiveIds: ["a"] } as any);
    }).not.toThrow();
  });

  it("accepts request with negative ids only (default best_score strategy)", () => {
    expect(() => {
      validateFindSimilarRequest({ negativeIds: ["a"] } as any);
    }).not.toThrow();
  });

  it("accepts request with positive code blocks", () => {
    expect(() => {
      validateFindSimilarRequest({ positiveCode: ["function foo() {}"] } as any);
    }).not.toThrow();
  });

  it("rejects when both positive and negative are empty/missing", () => {
    expect(() => {
      validateFindSimilarRequest({} as any);
    }).toThrow(/At least one positive or negative input/);
  });

  it("rejects when positive code blocks are all whitespace-only", () => {
    expect(() => {
      validateFindSimilarRequest({ positiveCode: ["   ", ""] } as any);
    }).toThrow(/At least one positive or negative input/);
  });

  it("rejects non-best_score strategy with no positive input", () => {
    expect(() => {
      validateFindSimilarRequest({ strategy: "average_vector", negativeIds: ["n"] } as any);
    }).toThrow(/Strategy 'average_vector' requires at least one positive input/);
  });

  it("accepts non-best_score strategy when positive input present", () => {
    expect(() => {
      validateFindSimilarRequest({ strategy: "sum_scores", positiveIds: ["p"], negativeIds: ["n"] } as any);
    }).not.toThrow();
  });
});

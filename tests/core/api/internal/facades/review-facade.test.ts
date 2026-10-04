/**
 * `ReviewFacade` (bd tea-rags-mcp-89k7k.1.4, F3 slice 1) — per
 * facade-discipline: validate input, delegate to ops, nothing else. What is
 * pinned here is the dispatch and the two shape rules the ops cannot see
 * (empty allowlists are caller bugs, not "review nothing").
 */
import { describe, expect, it, vi } from "vitest";

import { InvalidParameterError } from "../../../../../src/core/api/errors.js";
import {
  ReviewFacade,
  validateReviewChangesRequest,
} from "../../../../../src/core/api/internal/facades/review-facade.js";
import type { ReviewChangesResult } from "../../../../../src/core/api/public/dto/review.js";

const ANSWER: ReviewChangesResult = {
  review: {
    workTree: "/w",
    base: "HEAD",
    mergeBase: "mb",
    changedFiles: 0,
    skipped: 0,
    sections: {},
  },
};

function makeFacade() {
  const reviewChanges = vi.fn().mockResolvedValue(ANSWER);
  const facade = new ReviewFacade({ ops: { reviewChanges } });
  return { facade, reviewChanges };
}

describe("ReviewFacade", () => {
  it("validates and delegates", async () => {
    const { facade, reviewChanges } = makeFacade();
    const request = { project: "p", sections: ["cohesion"] as const };
    await expect(facade.reviewChanges(request)).resolves.toBe(ANSWER);
    expect(reviewChanges).toHaveBeenCalledWith(request);
  });
});

describe("validateReviewChangesRequest", () => {
  it("accepts a bare diff review (default base, all sections)", () => {
    expect(() => {
      validateReviewChangesRequest({ project: "p" });
    }).not.toThrow();
    expect(() => {
      validateReviewChangesRequest({ project: "p", changes: { base: "main" } });
    }).not.toThrow();
  });

  it("rejects an empty sections allowlist and an empty files list", () => {
    expect(() => {
      validateReviewChangesRequest({ project: "p", sections: [] });
    }).toThrow(InvalidParameterError);
    expect(() => {
      validateReviewChangesRequest({ project: "p", files: [] });
    }).toThrow(InvalidParameterError);
  });
});

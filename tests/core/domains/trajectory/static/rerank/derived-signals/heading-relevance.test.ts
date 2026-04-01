import { describe, expect, it } from "vitest";

import { HeadingRelevanceSignal } from "../../../../../../../src/core/domains/trajectory/static/rerank/derived-signals/heading-relevance.js";

describe("HeadingRelevanceSignal", () => {
  const signal = new HeadingRelevanceSignal();

  it("returns 0 when no headingPath", () => {
    expect(signal.extract({}, { query: "test" })).toBe(0);
  });

  it("returns 0 when headingPath is empty", () => {
    expect(signal.extract({ headingPath: [] }, { query: "test" })).toBe(0);
  });

  it("returns 0 when no query in context", () => {
    expect(signal.extract({ headingPath: [{ depth: 1, text: "Auth" }] })).toBe(0);
  });

  it("returns 0 when query is all stop-words", () => {
    expect(signal.extract({ headingPath: [{ depth: 1, text: "Auth" }] }, { query: "the a an" })).toBe(0);
  });

  it("returns 1.0 for exact h1 match", () => {
    expect(signal.extract({ headingPath: [{ depth: 1, text: "Authentication" }] }, { query: "authentication" })).toBe(
      1.0,
    );
  });

  it("returns 0.67 for exact h2 match", () => {
    const score = signal.extract({ headingPath: [{ depth: 2, text: "Authentication" }] }, { query: "authentication" });
    expect(score).toBeCloseTo(0.667, 2);
  });

  it("returns 0.33 for exact h3 match", () => {
    const score = signal.extract({ headingPath: [{ depth: 3, text: "Authentication" }] }, { query: "authentication" });
    expect(score).toBeCloseTo(0.333, 2);
  });

  it("selects max score from breadcrumb path", () => {
    const score = signal.extract(
      {
        headingPath: [
          { depth: 1, text: "Authentication" },
          { depth: 2, text: "Endpoints" },
          { depth: 3, text: "Rate Limits" },
        ],
      },
      { query: "authentication" },
    );
    expect(score).toBe(1.0);
  });

  it("handles multi-word heading overlap", () => {
    const score = signal.extract({ headingPath: [{ depth: 2, text: "Rate Limits" }] }, { query: "rate limits" });
    expect(score).toBeCloseTo(0.667, 2);
  });

  it("is case-insensitive", () => {
    const score = signal.extract({ headingPath: [{ depth: 1, text: "API Reference" }] }, { query: "api reference" });
    expect(score).toBe(1.0);
  });

  it("has correct metadata", () => {
    expect(signal.name).toBe("headingRelevance");
    expect(signal.sources).toEqual([]);
  });
});

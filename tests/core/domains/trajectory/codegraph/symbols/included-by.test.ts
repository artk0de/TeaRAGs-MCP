import { describe, expect, it } from "vitest";

import { buildIncludedBy } from "../../../../../../src/core/domains/trajectory/codegraph/symbols/provider.js";

describe("buildIncludedBy — reverse include-by index (cai0/2oky5)", () => {
  it("inverts classAncestors: a module's including classes list it", () => {
    // PerfettoTrace included into two Trace subclasses; both list it.
    const ancestors = {
      "GraphQL::Tracing::PerfettoTraceA": ["PerfettoTrace", "GraphQL::Tracing::Trace"],
      "GraphQL::Tracing::PerfettoTraceB": ["PerfettoTrace", "GraphQL::Tracing::Trace"],
    };
    const out = buildIncludedBy(ancestors, {});
    expect(out["PerfettoTrace"]).toEqual(["GraphQL::Tracing::PerfettoTraceA", "GraphQL::Tracing::PerfettoTraceB"]);
    expect(out["GraphQL::Tracing::Trace"]).toEqual([
      "GraphQL::Tracing::PerfettoTraceA",
      "GraphQL::Tracing::PerfettoTraceB",
    ]);
  });

  it("includes prepended modules (Wrapper prepended into Agent)", () => {
    const out = buildIncludedBy({}, { Agent: ["DryRunnable::Wrapper"] });
    expect(out["DryRunnable::Wrapper"]).toEqual(["Agent"]);
  });

  it("de-dups a child that lists the same ancestor via include AND prepend", () => {
    const out = buildIncludedBy({ C: ["M"] }, { C: ["M"] });
    expect(out["M"]).toEqual(["C"]);
  });

  it("returns an empty object for empty inputs", () => {
    expect(buildIncludedBy({}, {})).toEqual({});
  });
});

import { describe, it, expect } from "vitest";
import { STATIC_FILTER_PRESETS } from "../../../../../src/core/domains/trajectory/static/filter-presets/index.js";
import { compileFilterPreset } from "../../../../../src/core/domains/trajectory/filter-presets/compiler.js";

const byName = (n: string) => STATIC_FILTER_PRESETS.find((p) => p.name === n)!;

describe("static filter presets", () => {
  it("production excludes tests, docs, and block chunks", () => {
    expect(compileFilterPreset(byName("production"), undefined, "chunk")).toEqual({
      must_not: [
        { key: "isTest", match: { value: true } },
        { key: "isDocumentation", match: { value: true } },
        { key: "chunkType", match: { value: "block" } },
      ],
    });
  });

  it("coreLogic requires function|class and excludes tests", () => {
    const f = compileFilterPreset(byName("coreLogic"), undefined, "chunk");
    expect(f.must).toContainEqual({ key: "chunkType", match: { any: ["function", "class"] } });
    expect(f.must_not).toContainEqual({ key: "isTest", match: { value: true } });
  });

  it("securityPaths matches security path tokens via should-group of text matches", () => {
    const f = compileFilterPreset(byName("securityPaths"), undefined, "chunk");
    // should-group compiles to nested must:[{should:[...]}]
    const should = (f.must as { should?: unknown[] }[]).find((c) => "should" in c)?.should as Record<string, unknown>[];
    expect(should).toContainEqual({ key: "relativePath", match: { text: "auth" } });
    expect(should).toContainEqual({ key: "relativePath", match: { text: "crypto" } });
  });

  it("none of the static presets declare a trajectory requirement", () => {
    for (const p of STATIC_FILTER_PRESETS) expect(p.requires).toBeUndefined();
  });
});

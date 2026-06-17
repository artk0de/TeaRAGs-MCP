import { describe, it, expect } from "vitest";
import { CODEGRAPH_FILTER_PRESETS } from "../../../../../../src/core/domains/trajectory/codegraph/symbols/filter-presets/index.js";
import { compileFilterPreset } from "../../../../../../src/core/domains/trajectory/filter-presets/compiler.js";

const byName = (n: string) => CODEGRAPH_FILTER_PRESETS.find((p) => p.name === n)!;

describe("codegraph filter presets", () => {
  it("all require codegraph.symbols", () => {
    for (const p of CODEGRAPH_FILTER_PRESETS) expect(p.requires).toContain("codegraph.symbols");
  });

  it("hubs compiles to physical isHub match", () => {
    expect(compileFilterPreset(byName("hubs"), undefined, "file")).toEqual({
      must: [{ key: "codegraph.symbols.file.isHub", match: { value: true } }],
    });
  });

  it("deadCandidates: physical fanIn==0 + function chunk, and documents the false-positive caveat", () => {
    const f = compileFilterPreset(byName("deadCandidates"), undefined, "chunk");
    expect(f.must).toContainEqual({ key: "codegraph.symbols.chunk.fanIn", match: { value: 0 } });
    expect(f.must).toContainEqual({ key: "chunkType", match: { value: "function" } });
    expect(byName("deadCandidates").description.toLowerCase()).toContain("false positive");
  });

  it("unstableCore: instability p90 (fb0.9) + connectionCount p50 (fb5), physical keys", () => {
    const f = compileFilterPreset(byName("unstableCore"), undefined, "file");
    expect(f.must).toContainEqual({ key: "codegraph.symbols.file.instability", range: { gte: 0.9 } });
    expect(f.must).toContainEqual({ key: "codegraph.symbols.file.connectionCount", range: { gte: 5 } });
  });
});

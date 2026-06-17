import { describe, it, expect } from "vitest";
import { GIT_FILTER_PRESETS } from "../../../../../src/core/domains/trajectory/git/filter-presets/index.js";
import { compileFilterPreset } from "../../../../../src/core/domains/trajectory/filter-presets/compiler.js";

const byName = (n: string) => GIT_FILTER_PRESETS.find((p) => p.name === n)!;

describe("git filter presets", () => {
  it("all require the git trajectory", () => {
    for (const p of GIT_FILTER_PRESETS) expect(p.requires).toContain("git");
  });

  it("godMethods: chunk churnRatio >= 0.8 AND file commitCount >= p50 (fallback 5)", () => {
    const f = compileFilterPreset(byName("godMethods"), undefined, "chunk");
    expect(f.must).toContainEqual({ key: "git.chunk.churnRatio", range: { gte: 0.8 } });
    expect(f.must).toContainEqual({ key: "git.file.commitCount", range: { gte: 5 } });
  });

  it("panicZone: recency required + at-least-one of bugFix/volatility (nested should)", () => {
    const f = compileFilterPreset(byName("panicZone"), undefined, "file");
    expect(f.must).toContainEqual({ key: "git.file.recencyWeightedFreq", range: { gte: 1 } });
    const should = (f.must as { should?: unknown[] }[]).find((c) => "should" in c)?.should;
    expect(should).toContainEqual({ key: "git.file.bugFixRate", range: { gte: 30 } });
    expect(should).toContainEqual({ key: "git.file.churnVolatility", range: { gte: 25 } });
  });

  it("freshLegacyEdits: old file (p75 fb60) + fresh chunk (<=7)", () => {
    const f = compileFilterPreset(byName("freshLegacyEdits"), undefined, "file");
    expect(f.must).toContainEqual({ key: "git.file.ageDays", range: { gte: 60 } });
    expect(f.must).toContainEqual({ key: "git.chunk.ageDays", range: { lte: 7 } });
  });

  it("fragileSilo: solo owner + churning chunk", () => {
    const f = compileFilterPreset(byName("fragileSilo"), undefined, "chunk");
    expect(f.must).toContainEqual({ key: "git.file.blameContributorCount", range: { lte: 1 } });
    expect(f.must).toContainEqual({ key: "git.chunk.commitCount", range: { gte: 5 } });
  });
});

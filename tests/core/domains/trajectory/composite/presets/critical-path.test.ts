import { describe, expect, it } from "vitest";

import type { RerankPreset } from "../../../../../../src/core/contracts/types/reranker.js";
import { resolvePresets } from "../../../../../../src/core/domains/explore/rerank/presets/index.js";
import {
  buildCompositePresets,
  CriticalPathPreset,
} from "../../../../../../src/core/domains/trajectory/composite/presets/index.js";
import { GIT_PRESETS } from "../../../../../../src/core/domains/trajectory/git/rerank/presets/index.js";
import { STATIC_PRESETS } from "../../../../../../src/core/domains/trajectory/static/rerank/presets/index.js";

const WITH_BOTH = new Set(["static", "git", "codegraph.symbols"]);
const CODEGRAPH_ONLY = new Set(["static", "codegraph.symbols"]);
const GIT_ONLY = new Set(["static", "git"]);

function resolve(registeredKeys: ReadonlySet<string>): Map<string, RerankPreset> {
  const resolved = resolvePresets([...GIT_PRESETS, ...STATIC_PRESETS], buildCompositePresets(registeredKeys));
  return new Map(resolved.map((p) => [p.name, p]));
}

/**
 * `criticalPath` is the QA lens — central AND historically unstable methods,
 * i.e. where a regression costs the most. New composite name; nothing shadows
 * it, so it either appears or it does not.
 */
describe("CriticalPathPreset", () => {
  const preset = new CriticalPathPreset();

  it("is named criticalPath", () => {
    expect(preset.name).toBe("criticalPath");
  });

  it("scores per method, not per file", () => {
    expect(preset.signalLevel).toBe("chunk");
  });

  it("needs both the call graph and the history", () => {
    expect(preset.requires).toEqual(["codegraph.symbols", "git"]);
  });

  it("lets the process signals outweigh the structural one (Yatish 2020)", () => {
    expect(preset.weights).toEqual({ similarity: 0.2, pageRank: 0.3, bugFix: 0.3, churn: 0.2 });
    const process = (preset.weights.bugFix ?? 0) + (preset.weights.churn ?? 0);
    expect(process).toBeGreaterThan(preset.weights.pageRank ?? 0);
  });

  it("ranks production code only — test churn would drown the signal", () => {
    expect(preset.filter).toEqual({ presets: "production" });
  });

  it("carries the codegraph triad plus the two git history numbers in the overlay", () => {
    expect(preset.overlayMask.chunk).toEqual([
      "codegraph.chunk.pageRank",
      "codegraph.chunk.fanIn",
      "codegraph.chunk.fanOut",
      "bugFixRate",
      "commitCount",
    ]);
    expect(preset.overlayMask.file).toBeUndefined();
  });

  it("is offered on the four chunk-returning tools, with no grouping", () => {
    expect(preset.tools).toEqual(["semantic_search", "hybrid_search", "rank_chunks", "find_similar"]);
    expect(preset.groupBy).toBeUndefined();
  });
});

describe("criticalPath gating", () => {
  it("reaches the resolved set when codegraph.symbols and git are both registered", () => {
    expect(resolve(WITH_BOTH).get("criticalPath")?.weights).toEqual({
      similarity: 0.2,
      pageRank: 0.3,
      bugFix: 0.3,
      churn: 0.2,
    });
  });

  it("is dropped when git is missing — bugFix and churn would score nothing", () => {
    expect(resolve(CODEGRAPH_ONLY).has("criticalPath")).toBe(false);
  });

  it("is dropped when codegraph is missing — pageRank would score nothing", () => {
    expect(resolve(GIT_ONLY).has("criticalPath")).toBe(false);
  });

  it("has no trajectory preset behind it — nothing survives when it is gated out", () => {
    const gitOnlyNames = [...resolve(GIT_ONLY).keys()];
    const codegraphOnlyNames = [...resolve(CODEGRAPH_ONLY).keys()];
    expect(gitOnlyNames).not.toContain("criticalPath");
    expect(codegraphOnlyNames).not.toContain("criticalPath");
  });
});

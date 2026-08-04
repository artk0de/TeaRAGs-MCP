import { describe, expect, it } from "vitest";

import type { RerankPreset } from "../../../../../../src/core/contracts/types/reranker.js";
import { resolvePresets } from "../../../../../../src/core/domains/explore/rerank/presets/index.js";
import {
  BugHuntCompositePreset,
  buildCompositePresets,
} from "../../../../../../src/core/domains/trajectory/composite/presets/index.js";
import { BugHuntPreset } from "../../../../../../src/core/domains/trajectory/git/rerank/presets/bug-hunt.js";
import { GIT_PRESETS } from "../../../../../../src/core/domains/trajectory/git/rerank/presets/index.js";
import { STATIC_PRESETS } from "../../../../../../src/core/domains/trajectory/static/rerank/presets/index.js";

const WITH_CODEGRAPH = new Set(["static", "git", "codegraph.symbols"]);
const WITHOUT_CODEGRAPH = new Set(["static", "git"]);

function resolveFor(registeredKeys: ReadonlySet<string>, tool: string): RerankPreset | undefined {
  return resolvePresets([...GIT_PRESETS, ...STATIC_PRESETS], buildCompositePresets(registeredKeys)).find(
    (p) => p.name === "bugHunt" && p.tools.includes(tool),
  );
}

/**
 * The composite `bugHunt` keeps the git preset's temporal character — burst,
 * volatility, churn, bugFix history — and adds one call-graph term: a bug-prone
 * zone that is also central outranks an equally bug-prone leaf.
 */
describe("BugHuntCompositePreset", () => {
  const composite = new BugHuntCompositePreset();
  const base = new BugHuntPreset();

  it("shares the git preset's name so it overrides by (name, tool)", () => {
    expect(composite.name).toBe("bugHunt");
    expect(composite.name).toBe(base.name);
  });

  it("needs both trajectories — the git half is most of the score", () => {
    expect(composite.requires).toEqual(["codegraph.symbols", "git"]);
  });

  it("covers every tool the base preset covers — a partial override would split the UX", () => {
    expect(composite.tools).toEqual(base.tools);
    expect(composite.tools).toContain("trace_path");
  });

  it("keeps the base population filter", () => {
    expect(composite.filter).toEqual({ presets: "production" });
    expect(composite.filter).toEqual(base.filter);
  });

  it("rebalances the git temporal signals and adds pageRank", () => {
    expect(composite.weights).toEqual({
      similarity: 0.2,
      burstActivity: 0.18,
      volatility: 0.18,
      bugFix: 0.15,
      pageRank: 0.14,
      relativeChurnNorm: 0.1,
      recency: 0.05,
      blockPenalty: -0.05,
    });
  });

  it("keeps the temporal signals dominant over the structural one", () => {
    const temporal =
      (composite.weights.burstActivity ?? 0) +
      (composite.weights.volatility ?? 0) +
      (composite.weights.bugFix ?? 0) +
      (composite.weights.relativeChurnNorm ?? 0);
    expect(temporal).toBeGreaterThan(composite.weights.pageRank ?? 0);
  });

  it("carries the base preset's block penalty through", () => {
    expect(composite.weights.blockPenalty).toBe(base.weights.blockPenalty);
    expect(composite.weights.blockPenalty).toBeLessThan(0);
  });

  it("keeps the base overlay verbatim and appends the codegraph triad on chunk", () => {
    expect(composite.overlayMask.file).toEqual(base.overlayMask.file);
    expect(composite.overlayMask.chunk).toEqual([
      ...(base.overlayMask.chunk ?? []),
      "codegraph.chunk.pageRank",
      "codegraph.chunk.fanIn",
      "codegraph.chunk.fanOut",
    ]);
  });

  it("stays chunk-level like the base (undeclared signalLevel defaults to chunk)", () => {
    expect(composite.signalLevel).toBeUndefined();
    expect(composite.groupBy).toBeUndefined();
  });
});

describe("bugHunt override resolution", () => {
  const base = new BugHuntPreset();

  it.each(base.tools)("composite wins over the git preset on %s when codegraph is registered", (tool) => {
    expect(resolveFor(WITH_CODEGRAPH, tool)?.weights.pageRank).toBe(0.14);
  });

  it.each(base.tools)("git base survives on %s when codegraph is missing", (tool) => {
    const resolved = resolveFor(WITHOUT_CODEGRAPH, tool);
    expect(resolved?.weights).toEqual(base.weights);
    expect(resolved?.weights.pageRank).toBeUndefined();
  });

  it("resolves exactly one bugHunt per configuration", () => {
    for (const keys of [WITH_CODEGRAPH, WITHOUT_CODEGRAPH]) {
      const all = resolvePresets([...GIT_PRESETS, ...STATIC_PRESETS], buildCompositePresets(keys)).filter(
        (p) => p.name === "bugHunt",
      );
      expect(all).toHaveLength(1);
    }
  });
});

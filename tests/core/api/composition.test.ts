import { describe, expect, it } from "vitest";

import { createComposition } from "../../../src/core/api/composition.js";

describe("createComposition", () => {
  it("builds registry with GitTrajectory", () => {
    const { registry } = createComposition();
    expect(registry.has("git")).toBe(true);
  });

  it("aggregates payload signals from BASE + trajectories", () => {
    const { allPayloadSignalDescriptors } = createComposition();
    // BASE has relativePath, language, etc. + git has git.file.*, git.chunk.*
    expect(allPayloadSignalDescriptors.length).toBeGreaterThan(12);
    expect(allPayloadSignalDescriptors.find((s) => s.key === "relativePath")).toBeDefined();
    expect(allPayloadSignalDescriptors.find((s) => s.key === "git.file.commitCount")).toBeDefined();
  });

  it("aggregates derived signals from trajectories + structural", () => {
    const { allDerivedSignals } = createComposition();
    // Git: 14 derived + structural: 5
    expect(allDerivedSignals.length).toBe(19);
    expect(allDerivedSignals.find((d) => d.name === "recency")).toBeDefined();
    expect(allDerivedSignals.find((d) => d.name === "similarity")).toBeDefined();
  });

  it("resolves presets from relevance + trajectory", () => {
    const { resolvedPresets } = createComposition();
    expect(resolvedPresets.length).toBeGreaterThan(0);
    expect(resolvedPresets.find((p) => p.name === "relevance")).toBeDefined();
    expect(resolvedPresets.find((p) => p.name === "techDebt")).toBeDefined();
  });

  it("creates a functional reranker", () => {
    const { reranker } = createComposition();
    expect(reranker.getAvailablePresets("semantic_search")).toContain("techDebt");
    expect(reranker.getAvailablePresets("search_code")).toContain("relevance");
  });
});

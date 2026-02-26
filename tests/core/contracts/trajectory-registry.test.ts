import { describe, expect, it } from "vitest";

import type { EnrichmentProvider } from "../../../src/core/contracts/index.js";
import { TrajectoryRegistry } from "../../../src/core/contracts/trajectory-registry.js";

/** Minimal mock provider with only the fields TrajectoryRegistry cares about. */
function mockProvider(overrides: Partial<EnrichmentProvider> & { key: string }): EnrichmentProvider {
  return {
    signals: [],
    filters: [],
    presets: {},
    resolveRoot: (p: string) => p,
    buildFileSignals: async () => new Map(),
    buildChunkSignals: async () => new Map(),
    ...overrides,
  };
}

describe("TrajectoryRegistry", () => {
  const gitProvider = mockProvider({
    key: "git",
    signals: [
      { key: "git.file.ageDays", name: "recency", type: "number", description: "Recent files", defaultBound: 365 },
      { key: "git.file.commitCount", name: "churn", type: "number", description: "High churn", defaultBound: 50 },
    ],
    filters: [
      {
        param: "author",
        description: "Filter by author",
        type: "string",
        toCondition: (v, _level) => [{ key: "git.file.dominantAuthor", match: { value: v } }],
      },
      {
        param: "minAge",
        description: "Min age days",
        type: "number",
        toCondition: (v, level) => [{ key: `git.${level}.ageDays`, range: { gte: v as number } }],
      },
    ],
    presets: {
      techDebt: { recency: 0.3, churn: 0.7 },
      hotspots: { churn: 1.0 },
    },
  });

  it("should register and retrieve signals", () => {
    const registry = new TrajectoryRegistry();
    registry.register(gitProvider);
    const signals = registry.getAllSignals();
    expect(signals).toHaveLength(2);
    expect(signals[0].name).toBe("recency");
  });

  it("should register and retrieve filters", () => {
    const registry = new TrajectoryRegistry();
    registry.register(gitProvider);
    expect(registry.getAllFilters()).toHaveLength(2);
  });

  it("should merge presets from multiple providers", () => {
    const registry = new TrajectoryRegistry();
    registry.register(gitProvider);
    registry.register(
      mockProvider({
        key: "graph",
        signals: [{ key: "graph.complexity", name: "complexity", type: "number", description: "Code complexity" }],
        presets: { techDebt: { complexity: 0.5 }, codeGraph: { complexity: 1.0 } },
      }),
    );
    const presets = registry.getAllPresets();
    expect(presets.techDebt).toEqual({ complexity: 0.5 });
    expect(presets.codeGraph).toEqual({ complexity: 1.0 });
    expect(presets.hotspots).toEqual({ churn: 1.0 });
  });

  it("should collect signals from all providers without dedup", () => {
    const registry = new TrajectoryRegistry();
    registry.register(gitProvider);
    registry.register(
      mockProvider({
        key: "graph",
        signals: [{ key: "graph.recency", name: "recency", type: "number", description: "Graph recency" }],
      }),
    );
    expect(registry.getAllSignals()).toHaveLength(3);
  });

  it("should build filter using default chunk level", () => {
    const registry = new TrajectoryRegistry();
    registry.register(gitProvider);
    const filter = registry.buildFilter({ author: "alice", minAge: 30 });
    expect(filter).toBeDefined();
    expect(filter!.must).toHaveLength(2);
    expect(filter!.must![0]).toEqual({ key: "git.file.dominantAuthor", match: { value: "alice" } });
    expect(filter!.must![1]).toEqual({ key: "git.chunk.ageDays", range: { gte: 30 } });
  });

  it("should build filter with explicit file level", () => {
    const registry = new TrajectoryRegistry();
    registry.register(gitProvider);
    const filter = registry.buildFilter({ minAge: 30 }, "file");
    expect(filter!.must![0]).toEqual({ key: "git.file.ageDays", range: { gte: 30 } });
  });

  it("should return undefined from buildFilter when no params match", () => {
    const registry = new TrajectoryRegistry();
    registry.register(gitProvider);
    expect(registry.buildFilter({})).toBeUndefined();
    expect(registry.buildFilter({ unknownParam: "value" })).toBeUndefined();
  });

  it("should skip undefined/null param values in buildFilter", () => {
    const registry = new TrajectoryRegistry();
    registry.register(gitProvider);
    const filter = registry.buildFilter({ author: undefined, minAge: 30 });
    expect(filter!.must).toHaveLength(1);
  });

  it("should report registered keys", () => {
    const registry = new TrajectoryRegistry();
    registry.register(gitProvider);
    expect(registry.getRegisteredKeys()).toEqual(["git"]);
    expect(registry.has("git")).toBe(true);
    expect(registry.has("graph")).toBe(false);
  });

  it("should work with empty registry", () => {
    const registry = new TrajectoryRegistry();
    expect(registry.getAllSignals()).toEqual([]);
    expect(registry.getAllFilters()).toEqual([]);
    expect(registry.getAllPresets()).toEqual({});
    expect(registry.buildFilter({ author: "alice" })).toBeUndefined();
  });

  it("should return all providers via getAll()", () => {
    const registry = new TrajectoryRegistry();
    expect(registry.getAll()).toHaveLength(0);
    registry.register(gitProvider);
    registry.register(mockProvider({ key: "graph" }));
    const all = registry.getAll();
    expect(all).toHaveLength(2);
    expect(all[0].key).toBe("git");
    expect(all[1].key).toBe("graph");
  });

  it("should override provider on re-register with same key", () => {
    const registry = new TrajectoryRegistry();
    registry.register(gitProvider);
    const gitV2 = mockProvider({
      key: "git",
      signals: [{ key: "git.v2.metric", name: "v2", type: "number", description: "V2" }],
    });
    registry.register(gitV2);
    expect(registry.getAll()).toHaveLength(1);
    expect(registry.getAllSignals()).toHaveLength(1);
    expect(registry.getAllSignals()[0].name).toBe("v2");
  });
});

import { describe, expect, it } from "vitest";

import type {
  DerivedSignalDescriptor,
  EnrichmentProvider,
  FilterDescriptor,
  OverlayMask,
  RerankPreset,
} from "../../../src/core/contracts/index.js";
import type { PayloadSignalDescriptor, Trajectory } from "../../../src/core/contracts/types/trajectory.js";
// Import from NEW location (trajectory/index.ts — does not exist yet)
import { TrajectoryRegistry } from "../../../src/core/trajectory/index.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function mockDerived(name: string): DerivedSignalDescriptor {
  return {
    name,
    description: `Derived signal: ${name}`,
    sources: [`raw.${name}`],
    extract: () => 0.5,
  };
}

const EMPTY_MASK: OverlayMask = {};

function mockPreset(name: string, weights: Record<string, number>): RerankPreset {
  return { name, description: `Preset: ${name}`, tools: ["semantic_search"], weights, overlayMask: EMPTY_MASK };
}

function mockEnrichment(key: string): EnrichmentProvider {
  return {
    key,
    signals: [],
    derivedSignals: [],
    filters: [],
    presets: [],
    resolveRoot: (p: string) => p,
    buildFileSignals: async () => new Map(),
    buildChunkSignals: async () => new Map(),
  };
}

function mockTrajectory(overrides: Partial<Trajectory> & { key: string }): Trajectory {
  return {
    name: overrides.key,
    description: `Trajectory: ${overrides.key}`,
    payloadSignals: [],
    derivedSignals: [],
    filters: [],
    presets: [],
    enrichment: mockEnrichment(overrides.key),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("TrajectoryRegistry (Trajectory interface)", () => {
  // --- register + has ---

  it("registers a Trajectory and has() returns true", () => {
    const registry = new TrajectoryRegistry();
    expect(registry.has("git")).toBe(false);
    registry.register(mockTrajectory({ key: "git" }));
    expect(registry.has("git")).toBe(true);
  });

  it("reports registered keys", () => {
    const registry = new TrajectoryRegistry();
    registry.register(mockTrajectory({ key: "git" }));
    registry.register(mockTrajectory({ key: "graph" }));
    expect(registry.getRegisteredKeys()).toEqual(["git", "graph"]);
  });

  // --- payloadSignals ---

  it("aggregates payloadSignals from trajectories", () => {
    const ps: PayloadSignalDescriptor[] = [
      { key: "git.file.ageDays", type: "number", description: "Age" },
      { key: "git.file.commitCount", type: "number", description: "Commits" },
    ];
    const registry = new TrajectoryRegistry();
    registry.register(mockTrajectory({ key: "git", payloadSignals: ps }));
    expect(registry.getAllPayloadSignalDescriptors()).toHaveLength(2);
    expect(registry.getAllPayloadSignalDescriptors()[0].key).toBe("git.file.ageDays");
  });

  it("aggregates payloadSignals from multiple trajectories", () => {
    const registry = new TrajectoryRegistry();
    registry.register(
      mockTrajectory({
        key: "git",
        payloadSignals: [{ key: "git.file.ageDays", type: "number", description: "Age" }],
      }),
    );
    registry.register(
      mockTrajectory({
        key: "graph",
        payloadSignals: [{ key: "graph.complexity", type: "number", description: "Complexity" }],
      }),
    );
    expect(registry.getAllPayloadSignalDescriptors()).toHaveLength(2);
  });

  // --- derivedSignals ---

  it("aggregates derivedSignals from trajectories", () => {
    const registry = new TrajectoryRegistry();
    registry.register(mockTrajectory({ key: "git", derivedSignals: [mockDerived("recency"), mockDerived("churn")] }));
    const result = registry.getAllDerivedSignals();
    expect(result).toHaveLength(2);
    expect(result[0].name).toBe("recency");
  });

  it("aggregates derivedSignals from multiple trajectories", () => {
    const registry = new TrajectoryRegistry();
    registry.register(mockTrajectory({ key: "git", derivedSignals: [mockDerived("recency")] }));
    registry.register(mockTrajectory({ key: "graph", derivedSignals: [mockDerived("complexity")] }));
    expect(registry.getAllDerivedSignals()).toHaveLength(2);
    expect(registry.getAllDerivedSignals().map((d) => d.name)).toEqual(["recency", "complexity"]);
  });

  it("throws on duplicate derived signal name from different trajectory", () => {
    const registry = new TrajectoryRegistry();
    registry.register(mockTrajectory({ key: "git", derivedSignals: [mockDerived("recency")] }));
    expect(() => {
      registry.register(mockTrajectory({ key: "graph", derivedSignals: [mockDerived("recency")] }));
    }).toThrow(/Derived signal name conflict: "recency"/);
  });

  it("allows overriding same key without conflict", () => {
    const registry = new TrajectoryRegistry();
    registry.register(mockTrajectory({ key: "git", derivedSignals: [mockDerived("recency")] }));
    const gitV2 = mockTrajectory({ key: "git", derivedSignals: [mockDerived("recency"), mockDerived("churn")] });
    expect(() => {
      registry.register(gitV2);
    }).not.toThrow();
    expect(registry.getAllDerivedSignals()).toHaveLength(2);
  });

  // --- filters ---

  it("aggregates filters from trajectories", () => {
    const filters: FilterDescriptor[] = [
      {
        param: "author",
        description: "Filter by author",
        type: "string",
        toCondition: (v) => [{ key: "git.file.dominantAuthor", match: { value: v } }],
      },
    ];
    const registry = new TrajectoryRegistry();
    registry.register(mockTrajectory({ key: "git", filters }));
    expect(registry.getAllFilters()).toHaveLength(1);
  });

  // --- presets ---

  it("aggregates presets from trajectories", () => {
    const registry = new TrajectoryRegistry();
    registry.register(
      mockTrajectory({
        key: "git",
        presets: [mockPreset("techDebt", { recency: 0.3 }), mockPreset("hotspots", { churn: 1.0 })],
      }),
    );
    expect(registry.getAllPresets()).toHaveLength(2);
    expect(registry.getAllPresets().map((p) => p.name)).toEqual(["techDebt", "hotspots"]);
  });

  // --- enrichment providers ---

  it("returns enrichment providers from all trajectories", () => {
    const registry = new TrajectoryRegistry();
    registry.register(mockTrajectory({ key: "git" }));
    registry.register(mockTrajectory({ key: "graph" }));
    const providers = registry.getAllEnrichmentProviders();
    expect(providers).toHaveLength(2);
    expect(typeof providers[0].buildFileSignals).toBe("function");
    expect(providers[0].key).toBe("git");
    expect(providers[1].key).toBe("graph");
  });

  // --- buildFilter ---

  it("builds filter using default chunk level", () => {
    const filters: FilterDescriptor[] = [
      {
        param: "author",
        description: "Author",
        type: "string",
        toCondition: (v) => [{ key: "git.file.dominantAuthor", match: { value: v } }],
      },
      {
        param: "minAge",
        description: "Min age",
        type: "number",
        toCondition: (v, level) => [{ key: `git.${level}.ageDays`, range: { gte: v as number } }],
      },
    ];
    const registry = new TrajectoryRegistry();
    registry.register(mockTrajectory({ key: "git", filters }));

    const filter = registry.buildFilter({ author: "alice", minAge: 30 });
    expect(filter).toBeDefined();
    expect(filter!.must).toHaveLength(2);
    expect(filter!.must![0]).toEqual({ key: "git.file.dominantAuthor", match: { value: "alice" } });
    expect(filter!.must![1]).toEqual({ key: "git.chunk.ageDays", range: { gte: 30 } });
  });

  it("builds filter with explicit file level", () => {
    const filters: FilterDescriptor[] = [
      {
        param: "minAge",
        description: "Min age",
        type: "number",
        toCondition: (v, level) => [{ key: `git.${level}.ageDays`, range: { gte: v as number } }],
      },
    ];
    const registry = new TrajectoryRegistry();
    registry.register(mockTrajectory({ key: "git", filters }));
    const filter = registry.buildFilter({ minAge: 30 }, "file");
    expect(filter!.must![0]).toEqual({ key: "git.file.ageDays", range: { gte: 30 } });
  });

  it("returns undefined from buildFilter when no params match", () => {
    const registry = new TrajectoryRegistry();
    registry.register(mockTrajectory({ key: "git" }));
    expect(registry.buildFilter({})).toBeUndefined();
    expect(registry.buildFilter({ unknownParam: "value" })).toBeUndefined();
  });

  it("skips undefined/null param values in buildFilter", () => {
    const filters: FilterDescriptor[] = [
      {
        param: "author",
        description: "Author",
        type: "string",
        toCondition: (v) => [{ key: "git.file.dominantAuthor", match: { value: v } }],
      },
      {
        param: "minAge",
        description: "Min age",
        type: "number",
        toCondition: (v, level) => [{ key: `git.${level}.ageDays`, range: { gte: v as number } }],
      },
    ];
    const registry = new TrajectoryRegistry();
    registry.register(mockTrajectory({ key: "git", filters }));
    const filter = registry.buildFilter({ author: undefined, minAge: 30 });
    expect(filter!.must).toHaveLength(1);
  });

  // --- empty registry ---

  it("works with empty registry", () => {
    const registry = new TrajectoryRegistry();
    expect(registry.getAllPayloadSignalDescriptors()).toEqual([]);
    expect(registry.getAllDerivedSignals()).toEqual([]);
    expect(registry.getAllFilters()).toEqual([]);
    expect(registry.getAllPresets()).toEqual([]);
    expect(registry.getAllEnrichmentProviders()).toEqual([]);
    expect(registry.buildFilter({ author: "alice" })).toBeUndefined();
    expect(registry.getRegisteredKeys()).toEqual([]);
  });

  // --- override ---

  it("overrides trajectory on re-register with same key", () => {
    const registry = new TrajectoryRegistry();
    registry.register(
      mockTrajectory({
        key: "git",
        payloadSignals: [{ key: "git.file.ageDays", type: "number", description: "Age" }],
      }),
    );
    registry.register(
      mockTrajectory({
        key: "git",
        payloadSignals: [{ key: "git.v2.metric", type: "number", description: "V2" }],
      }),
    );
    expect(registry.getAllPayloadSignalDescriptors()).toHaveLength(1);
    expect(registry.getAllPayloadSignalDescriptors()[0].key).toBe("git.v2.metric");
    expect(registry.getRegisteredKeys()).toEqual(["git"]);
  });

  // --- integration with real GitTrajectory ---

  it("works with real GitTrajectory", async () => {
    const { GitTrajectory } = await import("../../../src/core/trajectory/git.js");
    const registry = new TrajectoryRegistry();
    registry.register(new GitTrajectory());

    expect(registry.has("git")).toBe(true);
    expect(registry.getAllPayloadSignalDescriptors().length).toBeGreaterThan(0);
    expect(registry.getAllDerivedSignals().length).toBeGreaterThan(0);
    expect(registry.getAllFilters().length).toBeGreaterThan(0);
    expect(registry.getAllPresets().length).toBeGreaterThan(0);
    expect(registry.getAllEnrichmentProviders()).toHaveLength(1);
    expect(typeof registry.getAllEnrichmentProviders()[0].buildFileSignals).toBe("function");
  });
});

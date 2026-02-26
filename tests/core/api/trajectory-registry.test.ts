import { describe, expect, it } from "vitest";

import { TrajectoryRegistry } from "../../../src/core/api/trajectory-registry.js";
import type { TrajectoryQueryContract } from "../../../src/core/trajectory/types.js";

describe("TrajectoryRegistry", () => {
  const mockContract: TrajectoryQueryContract = {
    signals: [
      { name: "recency", description: "Recent files", extract: () => 0.5 },
      { name: "churn", description: "High churn", extract: () => 0.7 },
    ],
    filters: [
      {
        param: "author",
        description: "Filter by author",
        type: "string",
        levels: ["file"],
        toCondition: (v, _level) => [{ key: "git.file.dominantAuthor", match: { value: v } }],
      },
      {
        param: "minAge",
        description: "Min age days",
        type: "number",
        levels: ["file", "chunk"],
        toCondition: (v, level) => [{ key: `git.${level}.ageDays`, range: { gte: v as number } }],
      },
    ],
    presets: {
      techDebt: { recency: 0.3, churn: 0.7 },
      hotspots: { churn: 1.0 },
    },
    payloadFields: [{ key: "git.file.commitCount", type: "number", description: "Commits" }],
  };

  it("should register and retrieve signals", () => {
    const registry = new TrajectoryRegistry();
    registry.register("git", mockContract);
    const signals = registry.getAllSignals();
    expect(signals).toHaveLength(2);
    expect(signals[0].name).toBe("recency");
  });

  it("should register and retrieve filters", () => {
    const registry = new TrajectoryRegistry();
    registry.register("git", mockContract);
    expect(registry.getAllFilters()).toHaveLength(2);
  });

  it("should merge presets from multiple providers", () => {
    const registry = new TrajectoryRegistry();
    registry.register("git", mockContract);
    registry.register("graph", {
      signals: [{ name: "complexity", description: "Code complexity", extract: () => 0.3 }],
      filters: [],
      presets: { techDebt: { complexity: 0.5 }, codeGraph: { complexity: 1.0 } },
      payloadFields: [],
    });
    const presets = registry.getAllPresets();
    expect(presets.techDebt).toEqual({ complexity: 0.5 });
    expect(presets.codeGraph).toEqual({ complexity: 1.0 });
    expect(presets.hotspots).toEqual({ churn: 1.0 });
  });

  it("should collect signals from all providers without dedup", () => {
    const registry = new TrajectoryRegistry();
    registry.register("git", mockContract);
    registry.register("graph", {
      signals: [{ name: "recency", description: "Graph recency", extract: () => 0.1 }],
      filters: [],
      presets: {},
      payloadFields: [],
    });
    expect(registry.getAllSignals()).toHaveLength(3);
  });

  it("should build filter using default chunk level", () => {
    const registry = new TrajectoryRegistry();
    registry.register("git", mockContract);
    const filter = registry.buildFilter({ author: "alice", minAge: 30 });
    expect(filter).toBeDefined();
    expect(filter!.must).toHaveLength(2);
    expect(filter!.must![0]).toEqual({ key: "git.file.dominantAuthor", match: { value: "alice" } });
    expect(filter!.must![1]).toEqual({ key: "git.chunk.ageDays", range: { gte: 30 } });
  });

  it("should build filter with explicit file level", () => {
    const registry = new TrajectoryRegistry();
    registry.register("git", mockContract);
    const filter = registry.buildFilter({ minAge: 30 }, "file");
    expect(filter!.must![0]).toEqual({ key: "git.file.ageDays", range: { gte: 30 } });
  });

  it("should return undefined from buildFilter when no params match", () => {
    const registry = new TrajectoryRegistry();
    registry.register("git", mockContract);
    expect(registry.buildFilter({})).toBeUndefined();
    expect(registry.buildFilter({ unknownParam: "value" })).toBeUndefined();
  });

  it("should skip undefined/null param values in buildFilter", () => {
    const registry = new TrajectoryRegistry();
    registry.register("git", mockContract);
    const filter = registry.buildFilter({ author: undefined, minAge: 30 });
    expect(filter!.must).toHaveLength(1);
  });

  it("should report registered keys", () => {
    const registry = new TrajectoryRegistry();
    registry.register("git", mockContract);
    expect(registry.getRegisteredKeys()).toEqual(["git"]);
    expect(registry.has("git")).toBe(true);
    expect(registry.has("graph")).toBe(false);
  });

  it("should return all payload fields from all providers", () => {
    const registry = new TrajectoryRegistry();
    registry.register("git", mockContract);
    registry.register("graph", {
      signals: [],
      filters: [],
      presets: {},
      payloadFields: [{ key: "graph.complexity", type: "number", description: "Complexity" }],
    });
    expect(registry.getAllPayloadFields()).toHaveLength(2);
  });

  it("should work with empty registry", () => {
    const registry = new TrajectoryRegistry();
    expect(registry.getAllSignals()).toEqual([]);
    expect(registry.getAllFilters()).toEqual([]);
    expect(registry.getAllPresets()).toEqual({});
    expect(registry.getAllPayloadFields()).toEqual([]);
    expect(registry.buildFilter({ author: "alice" })).toBeUndefined();
  });
});

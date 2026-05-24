import { describe, expect, it } from "vitest";

import type { Trajectory } from "../../../../src/core/contracts/types/trajectory.js";
import { codegraphFilters } from "../../../../src/core/domains/trajectory/codegraph/symbols/filters.js";
import { TrajectoryRegistry } from "../../../../src/core/domains/trajectory/index.js";
import { StaticTrajectory } from "../../../../src/core/domains/trajectory/static/index.js";

describe("TrajectoryRegistry.buildMergedFilter", () => {
  it("merges typed filter with raw filter", () => {
    const registry = new TrajectoryRegistry();
    registry.register(new StaticTrajectory());

    const result = registry.buildMergedFilter(
      { language: "typescript" },
      { must: [{ key: "path", match: { text: "src/" } }] },
    );

    const must = (result as any)?.must as unknown[];
    expect(must).toHaveLength(2);
  });

  it("returns raw filter when no typed params match", () => {
    const registry = new TrajectoryRegistry();
    registry.register(new StaticTrajectory());

    const raw = { must: [{ key: "path", match: { text: "src/" } }] };
    const result = registry.buildMergedFilter({}, raw);
    expect(result).toEqual(raw);
  });

  it("returns undefined when both are empty", () => {
    const registry = new TrajectoryRegistry();
    const result = registry.buildMergedFilter({});
    expect(result).toBeUndefined();
  });

  describe("codegraph typed filters (tea-rags-mcp-tr5k)", () => {
    // Lightweight stub: register only the codegraph filters surface — the
    // registry only inspects `filters` to build typed Qdrant conditions.
    function registerCodegraphStub(): TrajectoryRegistry {
      const registry = new TrajectoryRegistry();
      const stub: Trajectory = {
        key: "codegraph.symbols",
        name: "CodegraphSymbolsStub",
        description: "stub for filter routing test",
        payloadSignals: [],
        derivedSignals: [],
        filters: codegraphFilters,
        presets: [],
      };
      registry.register(stub);
      return registry;
    }

    it("routes minFanOut at chunk level to the nested codegraph.symbols.chunk path", () => {
      const registry = registerCodegraphStub();
      const filter = registry.buildFilter({ minFanOut: 3 }, "chunk");
      expect(filter).toEqual({
        must: [
          {
            key: "codegraph.symbols.chunk.codegraph.chunk.fanOut",
            range: { gte: 3 },
          },
        ],
      });
    });

    it("routes minConnectionCount to the file-level nested path", () => {
      const registry = registerCodegraphStub();
      const filter = registry.buildFilter({ minConnectionCount: 5 });
      expect(filter).toEqual({
        must: [
          {
            key: "codegraph.symbols.file.codegraph.file.connectionCount",
            range: { gte: 5 },
          },
        ],
      });
    });

    it("routes isHub:true as a boolean match on the file-level isHub key", () => {
      const registry = registerCodegraphStub();
      const filter = registry.buildFilter({ isHub: true });
      expect(filter).toEqual({
        must: [
          {
            key: "codegraph.symbols.file.codegraph.file.isHub",
            match: { value: true },
          },
        ],
      });
    });
  });
});

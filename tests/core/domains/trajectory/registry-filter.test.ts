import { describe, expect, it } from "vitest";

import type { Trajectory } from "../../../../src/core/contracts/types/trajectory.js";
import { codegraphFilters } from "../../../../src/core/domains/trajectory/codegraph/symbols/filters.js";
import { gitFilters } from "../../../../src/core/domains/trajectory/git/filters.js";
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

  describe("level defaults (tea-rags-mcp-9mwny)", () => {
    // Mirrors ExploreOps: the effective level is undefined when the caller
    // passes no `level` and the rerank preset declares no signalLevel.
    function registerGitAndCodegraph(): TrajectoryRegistry {
      const registry = new TrajectoryRegistry();
      const stub = (key: string, filters: Trajectory["filters"]): Trajectory => ({
        key,
        name: `${key}-stub`,
        description: "stub for level-default routing",
        payloadSignals: [],
        derivedSignals: [],
        filters,
        presets: [],
      });
      registry.register(stub("git", gitFilters));
      registry.register(stub("codegraph.symbols", codegraphFilters));
      return registry;
    }

    it("lets each descriptor's own default apply when no level is given", () => {
      const filter = registerGitAndCodegraph().buildMergedFilter({ taskId: "T-1", minFanIn: 3, minCommitCount: 2 });
      expect(filter).toEqual({
        must: [
          { key: "git.chunk.commitCount", range: { gte: 2 } },
          { key: "git.file.taskIds", match: { any: ["T-1"] } },
          { key: "codegraph.symbols.file.fanIn", range: { gte: 3 } },
        ],
      });
    });

    it("the MCP `author` param compiles to a blame-owner condition instead of being dropped", () => {
      expect(registerGitAndCodegraph().buildMergedFilter({ author: "Nobody At All" })).toEqual({
        must: [{ key: "git.file.blameDominantAuthor", match: { value: "Nobody At All" } }],
      });
    });

    it("an explicit level still overrides every level-aware descriptor", () => {
      const filter = registerGitAndCodegraph().buildMergedFilter(
        { taskId: "T-1", minFanIn: 3, minCommitCount: 2 },
        undefined,
        "chunk",
      );
      expect(filter).toEqual({
        must: [
          { key: "git.chunk.commitCount", range: { gte: 2 } },
          { key: "git.chunk.taskIds", match: { any: ["T-1"] } },
          { key: "codegraph.symbols.chunk.fanIn", range: { gte: 3 } },
        ],
      });
    });
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
            key: "codegraph.symbols.chunk.fanOut",
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
            key: "codegraph.symbols.file.connectionCount",
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
            key: "codegraph.symbols.file.isHub",
            match: { value: true },
          },
        ],
      });
    });
  });
});

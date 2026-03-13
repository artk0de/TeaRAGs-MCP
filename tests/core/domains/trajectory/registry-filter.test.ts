import { describe, expect, it } from "vitest";

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
});

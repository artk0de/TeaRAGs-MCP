/**
 * Backward-compatibility test: TrajectoryRegistry imported via contracts barrel.
 *
 * The canonical implementation lives in src/core/trajectory/index.ts.
 * This file verifies the re-export from contracts/trajectory-registry.ts works.
 * Full test coverage is in tests/core/trajectory/trajectory-registry.test.ts.
 */
import { describe, expect, it } from "vitest";

import { TrajectoryRegistry } from "../../../src/core/contracts/trajectory-registry.js";
import type { Trajectory } from "../../../src/core/contracts/types/trajectory.js";

function stubTrajectory(key: string): Trajectory {
  return {
    key,
    name: key,
    description: `stub ${key}`,
    payloadSignals: [],
    derivedSignals: [],
    filters: [],
    presets: [],
    enrichment: {
      key,
      signals: [],
      derivedSignals: [],
      filters: [],
      presets: [],
      resolveRoot: (p: string) => p,
      buildFileSignals: async () => new Map(),
      buildChunkSignals: async () => new Map(),
    },
  };
}

describe("TrajectoryRegistry (contracts re-export)", () => {
  it("re-exports the same class as trajectory/index", async () => {
    const { TrajectoryRegistry: Canonical } = await import("../../../src/core/trajectory/index.js");
    expect(TrajectoryRegistry).toBe(Canonical);
  });

  it("registers and queries via contracts import path", () => {
    const registry = new TrajectoryRegistry();
    registry.register(stubTrajectory("git"));
    expect(registry.has("git")).toBe(true);
    expect(registry.getRegisteredKeys()).toEqual(["git"]);
    expect(registry.getAllEnrichmentProviders()).toHaveLength(1);
  });
});

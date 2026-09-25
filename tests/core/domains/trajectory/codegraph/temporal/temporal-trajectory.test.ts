/**
 * The temporal sub-graph joins the codegraph family (bd tea-rags-mcp-x4rpp):
 * registered by the family factory beside symbols, carrying no payload in
 * Phase 1, and building its tables through a completion hook only when git
 * history is configured.
 */

import { describe, expect, it } from "vitest";

import { buildTestCodegraphDeps } from "../__helpers__/language-factory.js";
import { createCodegraphTrajectories } from "../../../../../../src/core/domains/trajectory/codegraph/index.js";
import { InMemoryGlobalSymbolTable } from "../../../../../../src/core/domains/trajectory/codegraph/symbols/symbol-table.js";
import {
  CODEGRAPH_TEMPORAL_TRAJECTORY_KEY,
  createTemporalCochangeHooks,
  createTemporalTrajectory,
  TemporalCochangeBuilder,
} from "../../../../../../src/core/domains/trajectory/codegraph/temporal/index.js";

describe("TemporalTrajectory", () => {
  it("is registered by the codegraph family beside symbols", () => {
    const trajectories = createCodegraphTrajectories({
      graphDb: {} as never,
      symbolTable: new InMemoryGlobalSymbolTable(),
      ...buildTestCodegraphDeps(new Map()),
      exclusion: { customPatterns: [] },
    } as never);

    expect(trajectories.map((t) => t.key)).toEqual(["codegraph.symbols", CODEGRAPH_TEMPORAL_TRAJECTORY_KEY]);
  });

  it("carries no payload, filter or preset in Phase 1", () => {
    const trajectory = createTemporalTrajectory();

    expect(trajectory).toMatchObject({ payloadSignals: [], derivedSignals: [], filters: [], presets: [] });
    expect(trajectory.enrichment).toBeUndefined();
  });

  it("builds a co-change hook only when git history is configured", () => {
    expect(createTemporalCochangeHooks(undefined)).toEqual([]);

    const hooks = createTemporalCochangeHooks({
      windowMonths: 6,
      sessionGapMinutes: null,
      vcsAdapter: "git",
      gitTimeoutMs: 120_000,
    });
    expect(hooks).toHaveLength(1);
    expect(hooks[0]).toBeInstanceOf(TemporalCochangeBuilder);
  });
});

/**
 * The age filters measure against the REQUEST clock (bd tea-rags-mcp-zwu7m):
 * `FilterDescriptor.toCondition(value, level, nowSec)` — a head-anchored index
 * hands its indexed commit's time, and the filter must not read the wall clock
 * on its own. Without the clock they keep today's wall-clock behaviour.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { GitTrajectory } from "../../../../../src/core/domains/trajectory/git.js";
import { gitFilters } from "../../../../../src/core/domains/trajectory/git/filters.js";
import { TrajectoryRegistry } from "../../../../../src/core/domains/trajectory/index.js";

const DAY = 86_400;
/** HEAD of an index built ~2850 days before the pinned wall clock. */
const WALL_SEC = 1_800_000_000;
const HEAD_SEC = WALL_SEC - 2850 * DAY;

const filter = (param: string) => gitFilters.find((f) => f.param === param)!;

describe("git age filters take the request clock", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(WALL_SEC * 1000);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("minAgeDays selects by age measured from the clock it is handed", () => {
    expect(filter("minAgeDays").toCondition(30, "chunk", HEAD_SEC)).toEqual({
      must: [{ key: "git.chunk.lastModifiedAt", range: { gt: 0, lte: HEAD_SEC - 30 * DAY } }],
      must_not: [{ is_empty: { key: "git.chunk.lastModifiedAt" } }],
    });
  });

  it("maxAgeDays selects by age measured from the clock it is handed", () => {
    expect(filter("maxAgeDays").toCondition(7, "file", HEAD_SEC)).toEqual({
      must: [{ key: "git.file.lastModifiedAt", range: { gt: HEAD_SEC - 8 * DAY } }],
      must_not: [{ is_empty: { key: "git.file.lastModifiedAt" } }],
    });
  });

  it("without a clock both keep the wall clock", () => {
    expect(filter("minAgeDays").toCondition(30, "chunk").must).toEqual([
      { key: "git.chunk.lastModifiedAt", range: { gt: 0, lte: WALL_SEC - 30 * DAY } },
    ]);
    expect(filter("maxAgeDays").toCondition(7).must).toEqual([
      { key: "git.chunk.lastModifiedAt", range: { gt: WALL_SEC - 8 * DAY } },
    ]);
  });

  it("TrajectoryRegistry.buildFilter / buildMergedFilter thread the clock to every descriptor", () => {
    const registry = new TrajectoryRegistry();
    registry.register(new GitTrajectory());
    expect(registry.buildFilter({ minAgeDays: 30 }, "chunk", HEAD_SEC)?.must).toContainEqual({
      key: "git.chunk.lastModifiedAt",
      range: { gt: 0, lte: HEAD_SEC - 30 * DAY },
    });
    expect(registry.buildMergedFilter({ maxAgeDays: 0 }, undefined, "file", HEAD_SEC)).toMatchObject({
      must: [{ key: "git.file.lastModifiedAt", range: { gt: HEAD_SEC - DAY } }],
    });
    // No clock → wall clock, exactly as before.
    expect(registry.buildFilter({ minAgeDays: 30 }, "chunk")?.must).toContainEqual({
      key: "git.chunk.lastModifiedAt",
      range: { gt: 0, lte: WALL_SEC - 30 * DAY },
    });
  });
});

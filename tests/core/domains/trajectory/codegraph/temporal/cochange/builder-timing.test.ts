/**
 * `TemporalCochangeBuilder` phase timings (bd tea-rags-mcp-l1ot.3): under DEBUG
 * the hook emits ONE single-line `[GitEnrich] PHASE: TEMPORAL_COCHANGE <json>`
 * record decomposing wall-clock into skip-check / history / extract / write
 * alongside the build's own counts — the measurement surface the profiling bead
 * reads the worker debug logs against. Silent without DEBUG, in both the built
 * and the fresh (skip) outcome.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import type {
  TemporalCochangeBuildMeta,
  TemporalCochangeSnapshot,
} from "../../../../../../../src/core/contracts/types/codegraph.js";
import {
  TemporalCochangeBuilder,
  type TemporalCochangeHistorySource,
} from "../../../../../../../src/core/domains/trajectory/codegraph/temporal/index.js";
import { setDebug } from "../../../../../../../src/core/infra/runtime.js";

const NOW_MS = 1_760_000_000_000;
const HOUR = 3600;

function entry(sha: string, timestamp: number, paths: string[]) {
  return {
    commit: { sha, author: "alice", authorEmail: "alice@x", timestamp, body: "feat: x", parents: ["p"] },
    changedFiles: paths.map((path) => ({ path })),
  };
}

/** Newest first, two committed pairs — enough for a nonzero build. */
const HISTORY = [entry("s2", 2 * HOUR, ["a.ts", "b.ts"]), entry("s1", 1 * HOUR, ["a.ts", "b.ts"])];

function historySource(head: string): TemporalCochangeHistorySource {
  return {
    open: async () => ({
      repoRoot: "/repo",
      head,
      worktreeDeletions: [],
      trackedPaths: async () => ["a.ts", "b.ts"],
      entries: async () => HISTORY,
    }),
  };
}

function fakeGraphDb(initial: TemporalCochangeBuildMeta | null = null) {
  let meta = initial;
  const writes: TemporalCochangeSnapshot[] = [];
  return {
    graphDb: {
      readTemporalCochangeMeta: vi.fn(async () => meta),
      replaceTemporalCochange: vi.fn(async (snapshot: TemporalCochangeSnapshot) => {
        writes.push(snapshot);
        ({ meta } = snapshot);
      }),
    },
    writes,
  };
}

/** now() hands out queued millisecond readings: t0 start, then one per phase. */
function builder(source: TemporalCochangeHistorySource, clock: number[]) {
  const queue = [...clock];
  return new TemporalCochangeBuilder({
    windowMonths: 6,
    sessionGapMinutes: null,
    historySource: source,
    now: () => queue.shift() ?? NOW_MS,
  });
}

/** t0 start / t1 skip-check / t2 history / t3 extract / t4 write — 10+15+15+15. */
const CLOCK = [0, 10, 25, 40, 55];

type ErrorSpy = { mock: { calls: unknown[][] } };

/** The TEMPORAL_COCHANGE records: one grep-able line each, payload parsed off its trailing JSON. */
function timingLines(errorSpy: ErrorSpy): [string, Record<string, unknown>][] {
  return errorSpy.mock.calls
    .map((call) => String(call[0]))
    .filter((line) => line.includes("TEMPORAL_COCHANGE"))
    .map((line) => [line, JSON.parse(line.slice(line.indexOf("{"))) as Record<string, unknown>]);
}

describe("TemporalCochangeBuilder — phase timing line", () => {
  afterEach(() => {
    setDebug(false);
    vi.restoreAllMocks();
  });

  it("emits one phase-timing debug line on a built outcome", async () => {
    setDebug(true);
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const { graphDb } = fakeGraphDb();

    const outcome = await builder(historySource("h1"), CLOCK).onCollectionComplete({
      projectRoot: "/repo",
      graphDb,
    });

    expect(outcome.status).toBe("built");
    const lines = timingLines(errorSpy);
    expect(lines).toHaveLength(1);
    const [line, fields] = lines[0];
    expect(line).toContain("[GitEnrich] PHASE: TEMPORAL_COCHANGE");
    expect(fields).toMatchObject({
      status: "built",
      totalMs: 55,
      skipCheckMs: 10,
      historyMs: 15,
      extractMs: 15,
      writeMs: 15,
      commitCount: 2,
      bundleCount: 2,
      admittedBundleCount: 2,
      edgeCount: 1,
    });
  });

  it("emits a fresh-status line without build counts on the skip path", async () => {
    setDebug(true);
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const source = historySource("h1");
    const first = fakeGraphDb();
    await builder(source, CLOCK).onCollectionComplete({ projectRoot: "/repo", graphDb: first.graphDb });

    errorSpy.mockClear();
    // Skip path ends at the check: t0 start, t1 check done — no build phases run.
    const outcome = await builder(source, [0, 7]).onCollectionComplete({
      projectRoot: "/repo",
      graphDb: first.graphDb,
    });

    expect(outcome.status).toBe("fresh");
    const lines = timingLines(errorSpy);
    expect(lines).toHaveLength(1);
    const [, fields] = lines[0];
    expect(fields).toMatchObject({ status: "fresh", totalMs: 7, skipCheckMs: 7 });
    expect(fields).not.toHaveProperty("historyMs");
    expect(fields).not.toHaveProperty("edgeCount");
  });

  it("stays silent without DEBUG", async () => {
    setDebug(false);
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const { graphDb } = fakeGraphDb();

    const outcome = await builder(historySource("h1"), CLOCK).onCollectionComplete({
      projectRoot: "/repo",
      graphDb,
    });

    expect(outcome.status).toBe("built");
    expect(errorSpy).not.toHaveBeenCalled();
  });
});

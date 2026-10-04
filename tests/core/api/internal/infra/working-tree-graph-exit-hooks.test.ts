/**
 * `processExitHooks` (bd tea-rags-mcp-xi2r9, D6): the production exit hook the
 * tree graph cache registers while a build runs, so an exiting server kills
 * its build children and drops its staging. Pinned here against the real
 * `process` listeners — but never by emitting `exit` or a signal on the test
 * process: the registered listeners are picked out of `process.listeners` and
 * invoked directly, and `process.kill` is a spy.
 *
 * Also the sweep scheduler's resilience: a sweep that rejects must not surface
 * as an unhandled rejection nor stop the next sweep.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  processExitHooks,
  scheduleWorkingTreeGraphSweep,
} from "../../../../../src/core/api/internal/infra/working-tree-graph-cache.js";

const EVENTS = ["exit", "beforeExit", "SIGINT", "SIGTERM"] as const;
type HookEvent = (typeof EVENTS)[number];

/** Registers `onExit` and answers the listeners the registration added, per event. */
function registerAndCapture(onExit: () => void): {
  unregister: () => void;
  added: Record<HookEvent, ((...args: unknown[]) => void)[]>;
} {
  const before = Object.fromEntries(EVENTS.map((event) => [event, new Set(process.listeners(event))]));
  const unregister = processExitHooks.register(onExit);
  const added = Object.fromEntries(
    EVENTS.map((event) => [
      event,
      process.listeners(event).filter((listener) => !before[event].has(listener)) as ((...args: unknown[]) => void)[],
    ]),
  ) as Record<HookEvent, ((...args: unknown[]) => void)[]>;
  return { unregister, added };
}

describe("processExitHooks", () => {
  let unregisters: (() => void)[] = [];

  afterEach(() => {
    for (const unregister of unregisters) unregister();
    unregisters = [];
    vi.restoreAllMocks();
  });

  it("hooks exit, beforeExit, SIGINT and SIGTERM, and the unregister removes every one", () => {
    const counts = Object.fromEntries(EVENTS.map((event) => [event, process.listenerCount(event)]));
    const { unregister, added } = registerAndCapture(() => undefined);

    for (const event of EVENTS) {
      expect(added[event]).toHaveLength(1);
      expect(process.listenerCount(event)).toBe(counts[event] + 1);
    }

    unregister();
    for (const event of EVENTS) expect(process.listenerCount(event)).toBe(counts[event]);
  });

  it("runs the cleanup on exit and swallows a cleanup that throws — the process is going away", () => {
    const onExit = vi.fn(() => {
      throw new Error("kill failed");
    });
    const { unregister, added } = registerAndCapture(onExit);
    unregisters.push(unregister);

    expect(() => {
      added.exit[0]();
    }).not.toThrow();
    expect(() => {
      added.beforeExit[0]();
    }).not.toThrow();
    expect(onExit).toHaveBeenCalledTimes(2);
  });

  it("beside the server's own signal listeners, only cleans up and leaves the exit to them", () => {
    const kill = vi.spyOn(process, "kill").mockImplementation(() => true);
    vi.spyOn(process, "listenerCount").mockReturnValue(2);
    const onExit = vi.fn();
    const { unregister, added } = registerAndCapture(onExit);
    unregisters.push(unregister);

    added.SIGTERM[0]("SIGTERM");

    expect(onExit).toHaveBeenCalledTimes(1);
    expect(kill).not.toHaveBeenCalled();
    vi.mocked(process.listenerCount).mockRestore();
    expect(process.listeners("SIGTERM")).toContain(added.SIGTERM[0]);
  });

  it("as the only signal listener, cleans up, steps aside and re-raises the signal so it still terminates", () => {
    const kill = vi.spyOn(process, "kill").mockImplementation(() => true);
    vi.spyOn(process, "listenerCount").mockReturnValue(1);
    const onExit = vi.fn();
    const { unregister, added } = registerAndCapture(onExit);
    unregisters.push(unregister);

    added.SIGINT[0]("SIGINT");

    expect(onExit).toHaveBeenCalledTimes(1);
    expect(kill).toHaveBeenCalledWith(process.pid, "SIGINT");
    vi.mocked(process.listenerCount).mockRestore();
    for (const event of EVENTS) {
      for (const listener of added[event]) expect(process.listeners(event)).not.toContain(listener);
    }
  });
});

describe("scheduleWorkingTreeGraphSweep — a failing sweep", () => {
  it("is swallowed, and the next interval still sweeps", async () => {
    vi.useFakeTimers();
    try {
      const sweepIfDue = vi.fn(async () => Promise.reject(new Error("disk gone")));
      const stop = scheduleWorkingTreeGraphSweep({ sweepIfDue }, { initialDelayMs: 1_000, intervalMs: 5_000 });

      await vi.advanceTimersByTimeAsync(1_000);
      expect(sweepIfDue).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(5_000);
      expect(sweepIfDue).toHaveBeenCalledTimes(2);

      stop();
    } finally {
      vi.useRealTimers();
    }
  });
});

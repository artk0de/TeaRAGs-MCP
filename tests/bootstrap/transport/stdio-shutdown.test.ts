import { EventEmitter } from "node:events";

import { describe, expect, it, vi } from "vitest";

import { installStdioShutdown } from "../../../src/bootstrap/transport/stdio.js";

/**
 * bd tea-rags-mcp-e6cpu — the stdio MCP server outlived its client: our
 * SIGTERM/SIGINT handler ran cleanup but, by existing, disabled Node's default
 * exit, and a closed stdin was never noticed, so in-flight indexing kept
 * spawning VCS children. Owner decision: when stdin closes (and on the
 * termination signals), release resources, then exit the process.
 */
function harness(cleanup: () => void | Promise<void> = vi.fn(), cleanupTimeoutMs?: number) {
  const stdin = new EventEmitter();
  const signals = new EventEmitter();
  const exit = vi.fn();
  const order: string[] = [];
  const trackedCleanup = vi.fn(async () => {
    order.push("cleanup");
    await cleanup();
  });
  exit.mockImplementation(() => order.push("exit"));
  const shutdown = installStdioShutdown({
    cleanup: trackedCleanup,
    stdin,
    signals,
    exit: exit as unknown as (code: number) => never,
    ...(cleanupTimeoutMs !== undefined ? { cleanupTimeoutMs } : {}),
  });
  return { stdin, signals, exit, order, cleanup: trackedCleanup, shutdown };
}

async function settle(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve));
}

describe("installStdioShutdown", () => {
  it("releases resources and then exits 0 when stdin ends", async () => {
    const h = harness();
    h.stdin.emit("end");
    await settle();
    expect(h.order).toEqual(["cleanup", "exit"]);
    expect(h.exit).toHaveBeenCalledWith(0);
  });

  it("treats a closed stdin the same as an ended one", async () => {
    const h = harness();
    h.stdin.emit("close");
    await settle();
    expect(h.order).toEqual(["cleanup", "exit"]);
  });

  it.each(["SIGTERM", "SIGINT"])("exits after cleanup on %s instead of swallowing it", async (signal) => {
    const h = harness();
    h.signals.emit(signal);
    await settle();
    expect(h.order).toEqual(["cleanup", "exit"]);
    expect(h.exit).toHaveBeenCalledWith(0);
  });

  it("runs the shutdown once however many triggers fire", async () => {
    const h = harness();
    h.stdin.emit("end");
    h.stdin.emit("close");
    h.signals.emit("SIGTERM");
    await settle();
    expect(h.cleanup).toHaveBeenCalledTimes(1);
    expect(h.exit).toHaveBeenCalledTimes(1);
  });

  it("waits for an async cleanup before exiting", async () => {
    let release!: () => void;
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    const h = harness(async () => pending);
    h.stdin.emit("end");
    await settle();
    expect(h.exit).not.toHaveBeenCalled();
    release();
    await settle();
    expect(h.order).toEqual(["cleanup", "exit"]);
  });

  it("still exits when cleanup throws", async () => {
    const h = harness(() => {
      throw new Error("boom");
    });
    h.stdin.emit("end");
    await settle();
    expect(h.exit).toHaveBeenCalledWith(0);
  });

  it("exits once the cleanup budget runs out, even if cleanup never settles", async () => {
    vi.useFakeTimers();
    try {
      const h = harness(async () => new Promise<void>(() => undefined), 1_000);
      h.stdin.emit("end");
      await vi.advanceTimersByTimeAsync(999);
      expect(h.exit).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      expect(h.exit).toHaveBeenCalledWith(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("exits even with no cleanup to run", async () => {
    const stdin = new EventEmitter();
    const exit = vi.fn();
    installStdioShutdown({ stdin, signals: new EventEmitter(), exit: exit as unknown as (code: number) => never });
    stdin.emit("end");
    await settle();
    expect(exit).toHaveBeenCalledWith(0);
  });
});

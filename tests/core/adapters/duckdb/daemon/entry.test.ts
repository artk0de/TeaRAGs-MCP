/**
 * Daemon shutdown bounding tests.
 *
 * Root cause 2 of the lock-leak bug: a daemon spawned by an MCP reindex did
 * NOT die on SIGTERM (needed SIGKILL). The idle watcher and the SIGTERM handler
 * both shut the daemon down via the same `shutdown()` path; if `pool.closeAll()`
 * (or `server.close`) hangs, the process never exits and the RW DuckDB lock is
 * held forever. `createShutdown` wraps cleanup in a hard timeout so a hung
 * close can never keep the process alive.
 */

import { afterEach, describe, expect, it, vi } from "vitest";

import { createShutdown } from "../../../../../src/core/adapters/duckdb/daemon/entry.js";

describe("createShutdown — bounded daemon teardown", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  function fakeServer(closeImpl: (cb: () => void) => void): { close: (cb: () => void) => void } {
    return { close: closeImpl };
  }

  /** server.close that fires its callback synchronously (clean close). */
  const closesCleanly = (cb: () => void): void => {
    cb();
  };
  /** server.close that NEVER fires its callback (hung close). */
  const neverCloses = (): void => undefined;
  /** pool.closeAll that never resolves (wedged DuckDB driver). */
  const hangsForever = async (): Promise<void> => new Promise<void>(() => undefined);

  it("completes when server.close and pool.closeAll resolve normally", async () => {
    const cleanup = vi.fn();
    const shutdown = createShutdown({
      server: fakeServer(closesCleanly) as never,
      pool: { closeAll: vi.fn().mockResolvedValue(undefined) } as never,
      cleanup,
      timeoutMs: 3000,
    });
    await shutdown();
    expect(cleanup).toHaveBeenCalledTimes(1);
  });

  it("resolves within the timeout even when pool.closeAll hangs forever", async () => {
    const cleanup = vi.fn();
    const shutdown = createShutdown({
      server: fakeServer(closesCleanly) as never,
      // closeAll never resolves — simulates a wedged DuckDB driver close.
      pool: { closeAll: hangsForever } as never,
      cleanup,
      timeoutMs: 50,
    });

    // Must resolve via the timeout race rather than hang.
    await expect(shutdown()).resolves.toBeUndefined();
    // cleanup still runs after the bounded wait (files unlinked even on hang).
    expect(cleanup).toHaveBeenCalledTimes(1);
  });

  it("resolves even when server.close never invokes its callback", async () => {
    const cleanup = vi.fn();
    const shutdown = createShutdown({
      // server.close hangs (callback never fires).
      server: fakeServer(neverCloses) as never,
      pool: { closeAll: vi.fn().mockResolvedValue(undefined) } as never,
      cleanup,
      timeoutMs: 50,
    });
    await expect(shutdown()).resolves.toBeUndefined();
    expect(cleanup).toHaveBeenCalledTimes(1);
  });

  it("is idempotent — second call is a no-op", async () => {
    const cleanup = vi.fn();
    const shutdown = createShutdown({
      server: fakeServer(closesCleanly) as never,
      pool: { closeAll: vi.fn().mockResolvedValue(undefined) } as never,
      cleanup,
      timeoutMs: 3000,
    });
    await shutdown();
    await shutdown();
    expect(cleanup).toHaveBeenCalledTimes(1);
  });

  it("swallows a rejecting pool.closeAll and still runs cleanup", async () => {
    const cleanup = vi.fn();
    const shutdown = createShutdown({
      server: fakeServer(closesCleanly) as never,
      pool: { closeAll: vi.fn().mockRejectedValue(new Error("close failed")) } as never,
      cleanup,
      timeoutMs: 3000,
    });
    await expect(shutdown()).resolves.toBeUndefined();
    expect(cleanup).toHaveBeenCalledTimes(1);
  });
});

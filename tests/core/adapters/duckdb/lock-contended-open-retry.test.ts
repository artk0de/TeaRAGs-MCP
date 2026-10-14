/**
 * `LockContendedOpenRetry` (bd tea-rags-mcp-42hno, hw27k, 89k7k.35.27; split
 * out of `GraphDbClientPool` in 0qaht.38): only a held lock is retried, a
 * successful open clears the remembered foreign holder, and a verdict no connect
 * can change fails the next open at once without settling again.
 */

import { describe, expect, it, vi } from "vitest";

import { fixturePhysicalCollectionName } from "../../__helpers__/collection-identity.js";
import type { ForeignBuildDaemonLockArbiter } from "../../../../src/core/adapters/duckdb/daemon/foreign-build-lock-arbiter.js";
import {
  CodegraphDatabaseHeldByForeignDaemonError,
  DuckDbOpenFailedError,
} from "../../../../src/core/adapters/duckdb/errors.js";
import { LockContendedOpenRetry } from "../../../../src/core/adapters/duckdb/lock-contended-open-retry.js";

const name = fixturePhysicalCollectionName("code_a");
const lockHeld = (): DuckDbOpenFailedError =>
  new DuckDbOpenFailedError(
    "/db/code_a.duckdb",
    new Error('IO Error: Could not set lock on file "/db/code_a.duckdb": Conflicting lock is held in node (PID 4242)'),
  );
const holder = { pid: 4242, buildDir: "/daemons/other", buildFingerprint: "other-build" };

describe("LockContendedOpenRetry", () => {
  it("rethrows a failure that is not lock contention without retrying", async () => {
    const retry = new LockContendedOpenRetry({ openRetry: { maxMs: 10_000, intervalMs: 1 }, pathFor: () => "/db" });
    const openOnce = vi.fn(async () => {
      throw new DuckDbOpenFailedError("/db/code_a.duckdb", new Error("not a database file"));
    });
    await expect(retry.open(name, openOnce)).rejects.toBeInstanceOf(DuckDbOpenFailedError);
    expect(openOnce).toHaveBeenCalledTimes(1);
  });

  it("retries a held lock within the window and returns the open that succeeds", async () => {
    const retry = new LockContendedOpenRetry({ openRetry: { maxMs: 10_000, intervalMs: 1 }, pathFor: () => "/db" });
    let attempts = 0;
    const opened = await retry.open(name, async () => {
      attempts += 1;
      if (attempts < 3) throw lockHeld();
      return "entry";
    });
    expect(opened).toBe("entry");
    expect(attempts).toBe(3);
  });

  it("fails a later open at once against a holder whose verdict no connect can change", async () => {
    const settle = vi.fn(async () => ({ kind: "held" as const, holder, reason: "unreachable" as const }));
    const arbiter = {
      settle,
      describe: vi.fn(async () => holder),
      isStillHeldBy: vi.fn(() => true),
    } as unknown as ForeignBuildDaemonLockArbiter;
    const retry = new LockContendedOpenRetry({ foreignBuildLockArbiter: arbiter, pathFor: () => "/db" });
    const failing = async (): Promise<string> => {
      throw lockHeld();
    };
    await expect(retry.open(name, failing)).rejects.toBeInstanceOf(CodegraphDatabaseHeldByForeignDaemonError);
    expect(settle).toHaveBeenCalledTimes(1);
    await expect(retry.open(name, failing)).rejects.toBeInstanceOf(CodegraphDatabaseHeldByForeignDaemonError);
    expect(settle).toHaveBeenCalledTimes(1);
    // A successful open forgets the verdict: the next contention settles afresh.
    await expect(retry.open(name, async () => "entry")).resolves.toBe("entry");
    await expect(retry.open(name, failing)).rejects.toBeInstanceOf(CodegraphDatabaseHeldByForeignDaemonError);
    expect(settle).toHaveBeenCalledTimes(2);
  });

  // bd tea-rags-mcp-8noie: a foreign holder that released the collection on
  // request leaves the file free now — the next attempt runs at once, not one
  // interval later, so the open costs about one retry instead of the holder's
  // remaining idle window.
  it("retries at once after the foreign holder released the collection on request", async () => {
    const settle = vi.fn(async () => ({ kind: "released" as const, holder }));
    const arbiter = {
      settle,
      describe: vi.fn(async () => holder),
      isStillHeldBy: vi.fn(() => true),
    } as unknown as ForeignBuildDaemonLockArbiter;
    const retry = new LockContendedOpenRetry({
      openRetry: { maxMs: 120_000, intervalMs: 60_000 },
      foreignBuildLockArbiter: arbiter,
      pathFor: () => "/db",
    });
    let attempts = 0;
    const started = Date.now();
    const opened = await retry.open(name, async () => {
      attempts += 1;
      if (attempts < 2) throw lockHeld();
      return "entry";
    });
    expect(opened).toBe("entry");
    expect(settle).toHaveBeenCalledTimes(1);
    expect(Date.now() - started).toBeLessThan(5_000);
  });
});

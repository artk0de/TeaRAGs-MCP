import { existsSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { DaemonLock, STALE_LOCK_GRACE_MS } from "../../../../../src/core/adapters/qdrant/embedded/daemon-lock.js";

/**
 * A pid that is guaranteed not to run: probe upward until signal 0 reports
 * ESRCH. EPERM means the pid EXISTS but belongs to another user, so it is not
 * a usable stand-in for a dead holder.
 */
function deadPid(): number {
  for (let pid = 60_000; pid < 70_000; pid++) {
    try {
      process.kill(pid, 0);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ESRCH") return pid;
    }
  }
  throw new Error("no dead pid available in the probed range");
}

/** Backdate a file past the stale-lock grace window. */
function backdate(path: string): void {
  const past = new Date(Date.now() - STALE_LOCK_GRACE_MS - 60_000);
  utimesSync(path, past, past);
}

describe("DaemonLock", () => {
  let tempDir: string;
  let lockPath: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "daemon-lock-test-"));
    lockPath = join(tempDir, "daemon.lock");
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("acquire returns fd on success", () => {
    const lock = new DaemonLock();
    const result = lock.acquire(lockPath);
    expect(result).not.toBeNull();
    expect(result!.fd).toBeGreaterThan(0);
    lock.release(result!.fd);
  });

  it("acquire returns null when lock already held", () => {
    const lock = new DaemonLock();
    const first = lock.acquire(lockPath);
    expect(first).not.toBeNull();

    const second = lock.acquire(lockPath);
    expect(second).toBeNull();

    lock.release(first!.fd);
  });

  it("release allows re-acquire", () => {
    const lock = new DaemonLock();
    const first = lock.acquire(lockPath);
    lock.release(first!.fd);

    const second = lock.acquire(lockPath);
    expect(second).not.toBeNull();
    lock.release(second!.fd);
  });

  it("isHeld returns true when lock file exists", () => {
    const lock = new DaemonLock();
    const result = lock.acquire(lockPath);
    expect(lock.isHeld(lockPath)).toBe(true);
    lock.release(result!.fd);
  });

  it("isHeld returns false when no lock file", () => {
    const lock = new DaemonLock();
    expect(lock.isHeld(lockPath)).toBe(false);
  });

  it("release removes lock file", () => {
    const lock = new DaemonLock();
    const result = lock.acquire(lockPath);
    lock.release(result!.fd);
    expect(existsSync(lockPath)).toBe(false);
  });

  it("acquire records the holder pid in the lock file", () => {
    const lock = new DaemonLock();
    const result = lock.acquire(lockPath);

    expect(readFileSync(lockPath, "utf-8").trim()).toBe(String(process.pid));

    lock.release(result!.fd);
  });

  it("acquire steals a lock whose recorded holder is dead", () => {
    writeFileSync(lockPath, String(deadPid()), "utf-8");

    const lock = new DaemonLock();
    const result = lock.acquire(lockPath);

    expect(result).not.toBeNull();
    expect(readFileSync(lockPath, "utf-8").trim()).toBe(String(process.pid));

    lock.release(result!.fd);
  });

  it("acquire returns null when the recorded holder is still alive", () => {
    writeFileSync(lockPath, String(process.pid), "utf-8");

    const lock = new DaemonLock();

    expect(lock.acquire(lockPath)).toBeNull();
    expect(existsSync(lockPath)).toBe(true);
  });

  it("acquire steals an unparseable lock once it is older than the grace window", () => {
    writeFileSync(lockPath, "", "utf-8");
    backdate(lockPath);

    const lock = new DaemonLock();
    const result = lock.acquire(lockPath);

    expect(result).not.toBeNull();

    lock.release(result!.fd);
  });

  it("acquire returns null for an unparseable lock inside the grace window", () => {
    writeFileSync(lockPath, "", "utf-8");

    const lock = new DaemonLock();

    expect(lock.acquire(lockPath)).toBeNull();
  });
});

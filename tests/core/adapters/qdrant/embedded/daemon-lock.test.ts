import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { DaemonLock } from "../../../../../src/core/adapters/qdrant/embedded/daemon-lock.js";

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
});

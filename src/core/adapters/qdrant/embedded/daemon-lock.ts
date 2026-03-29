import { closeSync, existsSync, openSync, unlinkSync } from "node:fs";

/**
 * Exclusive file lock for daemon lifecycle operations.
 * Uses O_CREAT | O_EXCL (wx) for atomic lock acquisition.
 */
export class DaemonLock {
  private readonly activeLocks = new Map<number, string>();

  /**
   * Try to acquire an exclusive lock.
   * Returns { fd } on success, null if already held.
   */
  acquire(lockPath: string): { fd: number } | null {
    try {
      const fd = openSync(lockPath, "wx");
      this.activeLocks.set(fd, lockPath);
      return { fd };
    } catch {
      return null;
    }
  }

  /** Release the lock: close fd and remove lock file. */
  release(fd: number): void {
    const lockPath = this.activeLocks.get(fd);
    try {
      closeSync(fd);
    } catch {
      /* ignore */
    }
    if (lockPath) {
      try {
        unlinkSync(lockPath);
      } catch {
        /* ignore */
      }
      this.activeLocks.delete(fd);
    }
  }

  /** Check if lock file exists (non-authoritative -- file may be stale). */
  isHeld(lockPath: string): boolean {
    return existsSync(lockPath);
  }
}

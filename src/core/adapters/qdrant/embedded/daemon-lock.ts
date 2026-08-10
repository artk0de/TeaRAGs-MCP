import { closeSync, existsSync, openSync, readFileSync, statSync, unlinkSync, writeFileSync } from "node:fs";

/**
 * How long a lock whose holder cannot be identified is honoured before it is
 * treated as abandoned. Every holder writes its pid, so this window only
 * covers locks left by a pre-pid build and the sliver between `open` and the
 * pid `write`. A live holder keeps the lock for the length of one spawn —
 * milliseconds — so a minute is far past any legitimate hold.
 */
export const STALE_LOCK_GRACE_MS = 60_000;

/**
 * Exclusive file lock for daemon lifecycle operations.
 * Uses O_CREAT | O_EXCL (wx) for atomic lock acquisition.
 *
 * The holder's pid is written into the lock file so a lock left behind by a
 * killed process can be told apart from one a live process is holding. Without
 * that distinction a single SIGKILL between `acquire` and `release` strands the
 * file forever, and every later `ensureCodegraphDaemon` takes its "another
 * process is spawning" branch — so nobody spawns the daemon and every codegraph
 * call fails with ENOENT on the socket until the file is removed by hand.
 */
export class DaemonLock {
  private readonly activeLocks = new Map<number, string>();

  /**
   * Try to acquire an exclusive lock.
   * Returns { fd } on success, null if held by a live process.
   *
   * A lock whose recorded holder is dead (or which predates the grace window
   * with no readable pid) is abandoned: it is removed and re-created under this
   * process. Two processes may reach that conclusion together — the one that
   * loses the re-create gets null, which is the same answer it would have got
   * from a legitimately held lock.
   */
  acquire(lockPath: string): { fd: number } | null {
    const fd = this.tryCreate(lockPath);
    if (fd !== null) return { fd };
    if (!isAbandoned(lockPath)) return null;
    try {
      unlinkSync(lockPath);
    } catch {
      return null; // another process cleared it first; it owns the retry
    }
    const stolen = this.tryCreate(lockPath);
    return stolen === null ? null : { fd: stolen };
  }

  /**
   * Atomically create the lock file and stamp it with this process's pid.
   * The pid is what makes a later `acquire` able to tell a live holder from a
   * corpse, so a failure to write it leaves no lock behind at all.
   */
  private tryCreate(lockPath: string): number | null {
    let fd: number;
    try {
      fd = openSync(lockPath, "wx");
    } catch {
      return null;
    }
    try {
      writeFileSync(fd, String(process.pid), "utf-8");
    } catch {
      closeSync(fd);
      try {
        unlinkSync(lockPath);
      } catch {
        /* ignore */
      }
      return null;
    }
    this.activeLocks.set(fd, lockPath);
    return fd;
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

/**
 * Whether an existing lock file belongs to nobody. Decided from the recorded
 * pid when there is one; otherwise from age, which is the only evidence left.
 * A file that vanished between the failed create and this read is NOT reported
 * abandoned — there is nothing to remove, and the caller's retry would race
 * whoever created it next.
 */
function isAbandoned(lockPath: string): boolean {
  let raw: string;
  try {
    raw = readFileSync(lockPath, "utf-8").trim();
  } catch {
    return false;
  }
  const pid = parseInt(raw, 10);
  if (Number.isFinite(pid) && pid > 0) return !isPidAlive(pid);
  try {
    return Date.now() - statSync(lockPath).mtimeMs > STALE_LOCK_GRACE_MS;
  } catch {
    return false;
  }
}

/**
 * Signal-0 liveness probe. EPERM means the pid is taken by a process this user
 * may not signal — alive, and emphatically not ours to steal from. Only ESRCH
 * (and an unreadable pid) count as gone.
 */
function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

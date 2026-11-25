/**
 * tea-rags-owned cross-process advisory lock on a read-write codegraph database
 * open (bd tea-rags-mcp-rmbl9).
 *
 * DuckDB's own file lock is what `openRetry` and the foreign-build arbiter were
 * built on, and it is not taken on every host: a second process can open the
 * same file read-write, and two writers corrupt it. This lock makes contention
 * independent of the driver. `<db>.tea-rags-lock` beside the database names the
 * holding process; it is created atomically (a fully written temp file
 * hard-linked into place, which fails when the name exists), so no reader ever
 * sees an empty record.
 *
 * - **Contention** throws {@link DatabaseFileAdvisoryLockHeldError}, whose
 *   message has the shape of DuckDB's own lock error. `DuckDbOpenFailedError`
 *   classifies its cause by that message, so the held lock is retryable, names
 *   its holder pid, and survives the daemon wire, all on the existing path.
 * - **Stale**: a record whose pid is dead, or that does not parse, is reclaimed.
 *   Reclaim runs under a `<lock>.reclaim` marker directory, so two reclaimers
 *   cannot both delete a record and each believe it owns the next one; a marker
 *   older than {@link RECLAIM_MARKER_STALE_MS} was left by a crashed reclaimer
 *   and is cleared.
 * - **Same process**: opens in one process share the lock (the pool may hold a
 *   retiring client and its replacement at once; DuckDB allowed that too). A
 *   record naming this pid that this module did not write is adopted, never
 *   reclaimed: another thread of this process wrote it. Only the writer removes
 *   it, and only while the record still names this pid.
 *
 * Read-only opens do not take it: they never write the file.
 */

import { linkSync, mkdirSync, readFileSync, rmdirSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";

import { InfraError } from "../errors.js";

/** Suffix of the lock record beside a database file. */
export const DATABASE_FILE_ADVISORY_LOCK_SUFFIX = ".tea-rags-lock";

/** A reclaim marker this old was left by a reclaimer that died mid-reclaim. */
const RECLAIM_MARKER_STALE_MS = 10_000;

/** Acquire attempts before a lock that keeps changing hands is reported held. */
const MAX_ACQUIRE_ATTEMPTS = 4;

export function databaseFileAdvisoryLockPath(dbPath: string): string {
  return `${dbPath}${DATABASE_FILE_ADVISORY_LOCK_SUFFIX}`;
}

/**
 * Another process holds the database read-write. Raised as the CAUSE of
 * `DuckDbOpenFailedError`; its message deliberately carries DuckDB's
 * `Could not set lock on file … Conflicting lock is held in … (PID <n>)` shape,
 * which is what that error (and its wire reconstruction) classifies.
 */
export class DatabaseFileAdvisoryLockHeldError extends InfraError {
  constructor(
    readonly dbPath: string,
    readonly lockPath: string,
    readonly holderPid: number | undefined,
  ) {
    super({
      code: "INFRA_CODEGRAPH_DATABASE_ADVISORY_LOCK_HELD",
      message: `Could not set lock on file "${dbPath}": Conflicting lock is held in tea-rags advisory lock ${lockPath}${
        holderPid !== undefined ? ` (PID ${holderPid})` : ""
      }`,
      hint:
        "Another tea-rags process has this codegraph database open read-write. Wait for it to idle out " +
        "or stop it; a lock left by a crashed process is reclaimed automatically.",
      httpStatus: 503,
    });
  }
}

/** One acquisition; `release` is idempotent. */
export interface DatabaseFileAdvisoryLockHandle {
  release: () => void;
}

interface HeldDatabaseFileLock {
  holders: number;
  /** This module wrote the record (as opposed to adopting another thread's). */
  wroteRecord: boolean;
}

/** Locks this module holds, by lock path. Per isolate: a worker thread has its own. */
const heldLocks = new Map<string, HeldDatabaseFileLock>();

/**
 * Take the advisory lock on `dbPath`'s read-write open.
 *
 * @throws DatabaseFileAdvisoryLockHeldError when a live process other than this one holds it.
 */
export function acquireDatabaseFileAdvisoryLock(dbPath: string): DatabaseFileAdvisoryLockHandle {
  const lockPath = databaseFileAdvisoryLockPath(dbPath);
  const held = heldLocks.get(lockPath);
  if (held) {
    held.holders++;
    return handleFor(lockPath, held);
  }
  let holderPid: number | undefined;
  for (let attempt = 0; attempt < MAX_ACQUIRE_ATTEMPTS; attempt++) {
    if (tryCreateRecord(lockPath)) return register(lockPath, true);
    const record = readRecord(lockPath);
    if (record.kind === "missing") continue;
    if (record.kind === "pid" && record.pid === process.pid) return register(lockPath, false);
    if (record.kind === "pid" && isProcessAlive(record.pid)) {
      holderPid = record.pid;
      break;
    }
    holderPid = record.kind === "pid" ? record.pid : undefined;
    if (!reclaimStaleRecord(lockPath, record)) break;
  }
  throw new DatabaseFileAdvisoryLockHeldError(dbPath, lockPath, holderPid);
}

function register(lockPath: string, wroteRecord: boolean): DatabaseFileAdvisoryLockHandle {
  const held: HeldDatabaseFileLock = { holders: 1, wroteRecord };
  heldLocks.set(lockPath, held);
  return handleFor(lockPath, held);
}

function handleFor(lockPath: string, held: HeldDatabaseFileLock): DatabaseFileAdvisoryLockHandle {
  let released = false;
  return {
    release: () => {
      if (released) return;
      released = true;
      if (--held.holders > 0) return;
      if (heldLocks.get(lockPath) === held) heldLocks.delete(lockPath);
      if (!held.wroteRecord) return;
      const record = readRecord(lockPath);
      // Never remove a record another process wrote since.
      if (record.kind === "pid" && record.pid === process.pid) unlinkQuietly(lockPath);
    },
  };
}

/** Atomically create the record naming this process; false when the name is taken. */
function tryCreateRecord(lockPath: string): boolean {
  const tempPath = join(dirname(lockPath), `.${basename(lockPath)}.${process.pid}.${Date.now()}.tmp`);
  writeFileSync(tempPath, `${JSON.stringify({ pid: process.pid, acquiredAt: new Date().toISOString() })}\n`);
  try {
    linkSync(tempPath, lockPath);
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw err;
  } finally {
    unlinkQuietly(tempPath);
  }
}

type LockRecordReading = { kind: "missing" } | { kind: "unreadable"; raw: string } | { kind: "pid"; pid: number };

function readRecord(lockPath: string): LockRecordReading {
  let raw: string;
  try {
    raw = readFileSync(lockPath, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return { kind: "missing" };
    throw err;
  }
  try {
    const { pid } = JSON.parse(raw) as { pid?: unknown };
    if (typeof pid === "number" && Number.isInteger(pid) && pid > 0) return { kind: "pid", pid };
  } catch {
    // Falls through: a record that does not parse names no holder.
  }
  return { kind: "unreadable", raw };
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM: alive, owned by another user.
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * Remove the stale record `seen` under the reclaim marker; false when another
 * reclaim is in progress (the lock then counts as held).
 */
function reclaimStaleRecord(lockPath: string, seen: LockRecordReading): boolean {
  const marker = `${lockPath}.reclaim`;
  if (!tryMakeMarker(marker)) return false;
  try {
    // Re-read under the marker: only the record judged stale may go.
    const currentRecord = readRecord(lockPath);
    if (sameRecord(currentRecord, seen)) unlinkQuietly(lockPath);
    return true;
  } finally {
    rmdirQuietly(marker);
  }
}

function tryMakeMarker(marker: string): boolean {
  try {
    mkdirSync(marker);
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
  }
  const markerMtimeMs = statSync(marker, { throwIfNoEntry: false })?.mtimeMs;
  if (markerMtimeMs !== undefined && Date.now() - markerMtimeMs < RECLAIM_MARKER_STALE_MS) return false;
  rmdirQuietly(marker);
  try {
    mkdirSync(marker);
    return true;
  } catch {
    return false;
  }
}

function sameRecord(a: LockRecordReading, b: LockRecordReading): boolean {
  if (a.kind === "pid" && b.kind === "pid") return a.pid === b.pid;
  if (a.kind === "unreadable" && b.kind === "unreadable") return a.raw === b.raw;
  return false;
}

function unlinkQuietly(path: string): void {
  try {
    unlinkSync(path);
  } catch {
    // Already gone.
  }
}

function rmdirQuietly(path: string): void {
  try {
    rmdirSync(path);
  } catch {
    // Already gone.
  }
}

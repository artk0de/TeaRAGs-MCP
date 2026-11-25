/**
 * The tea-rags-owned cross-process advisory lock on a read-write codegraph
 * database open (bd tea-rags-mcp-rmbl9). DuckDB's own file lock is not taken on
 * every host, so contention must not depend on it: the lock file arbitrates,
 * and a held lock reaches `DuckDbOpenFailedError` through the same message
 * shape the driver's lock error has — retryable, holder pid named, wire-safe.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { DuckDbGraphClient } from "../../../../src/core/adapters/duckdb/client.js";
import {
  acquireDatabaseFileAdvisoryLock,
  DatabaseFileAdvisoryLockHeldError,
  databaseFileAdvisoryLockPath,
} from "../../../../src/core/adapters/duckdb/database-file-advisory-lock.js";
import {
  daemonErrorFromWire,
  daemonErrorToWire,
  DuckDbOpenFailedError,
} from "../../../../src/core/adapters/duckdb/errors.js";

let dir: string;
let dbPath: string;
const children: ChildProcess[] = [];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "cg-advisory-lock-"));
  dbPath = join(dir, "code_lock.duckdb");
});

afterEach(() => {
  for (const child of children.splice(0)) if (child.exitCode === null) child.kill("SIGKILL");
  rmSync(dir, { recursive: true, force: true });
});

/** A live process that is not this one — the foreign holder a lock file names. */
async function spawnLiveProcess(): Promise<number> {
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
  children.push(child);
  await new Promise<void>((resolve) =>
    child.once("spawn", () => {
      resolve();
    }),
  );
  return child.pid as number;
}

/** The pid of a process that has already exited — a crashed holder. */
async function deadPid(): Promise<number> {
  const child = spawn(process.execPath, ["-e", "process.exit(0)"], { stdio: "ignore" });
  await new Promise<void>((resolve) =>
    child.once("exit", () => {
      resolve();
    }),
  );
  return child.pid as number;
}

function writeHolderRecord(pid: number): void {
  writeFileSync(databaseFileAdvisoryLockPath(dbPath), `${JSON.stringify({ pid })}\n`);
}

function recordedPid(): number {
  return (JSON.parse(readFileSync(databaseFileAdvisoryLockPath(dbPath), "utf8")) as { pid: number }).pid;
}

describe("database file advisory lock (rmbl9)", () => {
  it("acquire writes this process's pid beside the database; release removes it", () => {
    const handle = acquireDatabaseFileAdvisoryLock(dbPath);
    expect(databaseFileAdvisoryLockPath(dbPath)).toBe(`${dbPath}.tea-rags-lock`);
    expect(recordedPid()).toBe(process.pid);
    handle.release();
    expect(existsSync(databaseFileAdvisoryLockPath(dbPath))).toBe(false);
  });

  it("a live foreign holder fails the acquire with a typed error naming its pid", async () => {
    const pid = await spawnLiveProcess();
    writeHolderRecord(pid);
    let caught: unknown;
    try {
      acquireDatabaseFileAdvisoryLock(dbPath);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(DatabaseFileAdvisoryLockHeldError);
    const held = caught as DatabaseFileAdvisoryLockHeldError;
    expect(held.holderPid).toBe(pid);
    expect(held.dbPath).toBe(dbPath);
    // The foreign holder's record is untouched.
    expect(recordedPid()).toBe(pid);
  });

  it("the held error drives DuckDbOpenFailedError's lock-contention path, across the daemon wire too", async () => {
    const pid = await spawnLiveProcess();
    writeHolderRecord(pid);
    let cause: Error | undefined;
    try {
      acquireDatabaseFileAdvisoryLock(dbPath);
    } catch (err) {
      cause = err as Error;
    }
    const openError = new DuckDbOpenFailedError(dbPath, cause);
    expect(openError.lockContention).toBe(true);
    expect(openError.lockHolderPid).toBe(pid);
    const rebuilt = daemonErrorFromWire(daemonErrorToWire(openError)) as DuckDbOpenFailedError;
    expect(rebuilt).toBeInstanceOf(DuckDbOpenFailedError);
    expect(rebuilt.lockContention).toBe(true);
    expect(rebuilt.lockHolderPid).toBe(pid);
  });

  it("a dead holder's lock is stale and reclaimed", async () => {
    writeHolderRecord(await deadPid());
    const handle = acquireDatabaseFileAdvisoryLock(dbPath);
    expect(recordedPid()).toBe(process.pid);
    handle.release();
    expect(existsSync(databaseFileAdvisoryLockPath(dbPath))).toBe(false);
  });

  it("an unreadable lock record is stale and reclaimed", () => {
    writeFileSync(databaseFileAdvisoryLockPath(dbPath), "not json");
    const handle = acquireDatabaseFileAdvisoryLock(dbPath);
    expect(recordedPid()).toBe(process.pid);
    handle.release();
  });

  it("opens in one process share the lock: it goes only when the last one releases", () => {
    const first = acquireDatabaseFileAdvisoryLock(dbPath);
    const second = acquireDatabaseFileAdvisoryLock(dbPath);
    first.release();
    expect(recordedPid()).toBe(process.pid);
    second.release();
    expect(existsSync(databaseFileAdvisoryLockPath(dbPath))).toBe(false);
  });

  it("release is idempotent and never removes a lock another process now holds", async () => {
    const handle = acquireDatabaseFileAdvisoryLock(dbPath);
    const pid = await spawnLiveProcess();
    // The record was replaced under us (e.g. reclaimed by mistake elsewhere).
    writeHolderRecord(pid);
    handle.release();
    handle.release();
    expect(recordedPid()).toBe(pid);
  });

  it("a reclaim another process is in the middle of keeps the stale lock contended", async () => {
    const pid = await deadPid();
    writeHolderRecord(pid);
    mkdirSync(`${databaseFileAdvisoryLockPath(dbPath)}.reclaim`);
    expect(() => acquireDatabaseFileAdvisoryLock(dbPath)).toThrow(DatabaseFileAdvisoryLockHeldError);
  });

  it("a reclaim marker left by a crashed reclaimer is cleared once it is old", async () => {
    writeHolderRecord(await deadPid());
    const marker = `${databaseFileAdvisoryLockPath(dbPath)}.reclaim`;
    mkdirSync(marker);
    const old = new Date(Date.now() - 60_000);
    utimesSync(marker, old, old);
    const handle = acquireDatabaseFileAdvisoryLock(dbPath);
    expect(recordedPid()).toBe(process.pid);
    expect(existsSync(marker)).toBe(false);
    handle.release();
  });
});

describe("DuckDbGraphClient takes the advisory lock on read-write opens only (rmbl9)", () => {
  it("a read-write open holds the lock until close", async () => {
    const client = new DuckDbGraphClient({ path: dbPath });
    await client.init();
    expect(recordedPid()).toBe(process.pid);
    await client.close();
    expect(existsSync(databaseFileAdvisoryLockPath(dbPath))).toBe(false);
  });

  it("a read-write open against a live foreign holder fails before DuckDB opens the file", async () => {
    const pid = await spawnLiveProcess();
    writeHolderRecord(pid);
    const client = new DuckDbGraphClient({ path: dbPath });
    await expect(client.init()).rejects.toBeInstanceOf(DatabaseFileAdvisoryLockHeldError);
    await client.close();
    expect(existsSync(dbPath)).toBe(false);
    expect(recordedPid()).toBe(pid);
  });

  it("a read-only open is not blocked by a foreign holder's lock", async () => {
    const writer = new DuckDbGraphClient({ path: dbPath });
    await writer.init();
    await writer.close();
    writeHolderRecord(await spawnLiveProcess());
    const reader = new DuckDbGraphClient({ path: dbPath, accessMode: "READ_ONLY" });
    await reader.init();
    await reader.close();
  });
});

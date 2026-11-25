/**
 * Cross-process contention on a codegraph database through the tea-rags
 * advisory lock (bd tea-rags-mcp-rmbl9): the holder is a tea-rags opener in a
 * separate process (the compiled `DuckDbGraphClient`), so the loser's open is
 * arbitrated by the lock file whether or not DuckDB locks the file on this host.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import { fixturePhysicalCollectionName } from "../../__helpers__/collection-identity.js";
import {
  DatabaseFileAdvisoryLockHeldError,
  databaseFileAdvisoryLockPath,
} from "../../../../src/core/adapters/duckdb/database-file-advisory-lock.js";
import { DuckDbOpenFailedError } from "../../../../src/core/adapters/duckdb/errors.js";
import { GraphDbClientPool } from "../../../../src/core/adapters/duckdb/pool.js";
import { createDatabaseMigrationApplier } from "../../../../src/core/domains/maintenance/migration/database/index.js";
import { InMemoryGlobalSymbolTable } from "../../../../src/core/domains/trajectory/codegraph/symbols/symbol-table.js";

const BUILD_CLIENT = pathToFileURL(resolve(__dirname, "../../../../build/core/adapters/duckdb/client.js")).href;
const COLLECTION = fixturePhysicalCollectionName("code_xproc_v1");

let root: string;
const children: ChildProcess[] = [];
const pools: GraphDbClientPool[] = [];

afterEach(async () => {
  for (const pool of pools.splice(0)) await pool.closeAll().catch(() => undefined);
  for (const child of children.splice(0)) if (child.exitCode === null) child.kill("SIGKILL");
  if (root) rmSync(root, { recursive: true, force: true });
});

/** A separate process holding the database read-write through tea-rags' own client. */
async function spawnTeaRagsHolder(dbPath: string): Promise<ChildProcess> {
  const child = spawn(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      [
        `const { DuckDbGraphClient } = await import(${JSON.stringify(BUILD_CLIENT)});`,
        "const client = new DuckDbGraphClient({ path: process.env.HOLD_DB_PATH });",
        "await client.init();",
        'console.log("HOLDING");',
        'process.stdin.on("data", async () => { await client.close(); console.log("CLOSED"); });',
      ].join("\n"),
    ],
    { env: { ...process.env, HOLD_DB_PATH: dbPath }, stdio: ["pipe", "pipe", "pipe"] },
  );
  children.push(child);
  await waitForLine(child, "HOLDING");
  return child;
}

async function waitForLine(child: ChildProcess, line: string): Promise<void> {
  await new Promise<void>((resolveLine, reject) => {
    const onData = (d: Buffer): void => {
      if (d.toString().includes(line)) {
        child.stdout?.off("data", onData);
        resolveLine();
      }
    };
    child.stdout?.on("data", onData);
    child.stderr?.once("data", (d: Buffer) => {
      reject(new Error(d.toString()));
    });
  });
}

function makeRoot(): string {
  root = mkdtempSync(join(tmpdir(), "cg-xproc-lock-"));
  mkdirSync(join(root, "codegraph"), { recursive: true });
  return join(root, "codegraph", "code_xproc_v1.duckdb");
}

function makePool(openRetry?: { maxMs: number; intervalMs: number }): GraphDbClientPool {
  const pool = new GraphDbClientPool({
    rootDir: root,
    symbolTableFactory: () => new InMemoryGlobalSymbolTable(),
    applyMigrations: createDatabaseMigrationApplier(),
    openRetry,
  });
  pools.push(pool);
  return pool;
}

function recordedPid(dbPath: string): number {
  return (JSON.parse(readFileSync(databaseFileAdvisoryLockPath(dbPath), "utf8")) as { pid: number }).pid;
}

describe("cross-process advisory lock contention (rmbl9)", () => {
  it("without openRetry the loser fails at once with the typed lock error naming the holder", async () => {
    const dbPath = makeRoot();
    const holder = await spawnTeaRagsHolder(dbPath);
    const err = await makePool()
      .acquire(COLLECTION)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DuckDbOpenFailedError);
    const openError = err as DuckDbOpenFailedError;
    expect(openError.lockContention).toBe(true);
    expect(openError.lockHolderPid).toBe(holder.pid);
    expect(openError.cause).toBeInstanceOf(DatabaseFileAdvisoryLockHeldError);
  });

  it("the loser retries until the holder closes the database, then opens it", async () => {
    const dbPath = makeRoot();
    const holder = await spawnTeaRagsHolder(dbPath);
    const pool = makePool({ maxMs: 20_000, intervalMs: 100 });
    let settled = false;
    const pending = pool.acquire(COLLECTION);
    void pending.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );
    await new Promise((r) => setTimeout(r, 500));
    expect(settled).toBe(false);
    expect(recordedPid(dbPath)).toBe(holder.pid);

    // The holder stays alive: the lock is released by close, not reclaimed as stale.
    holder.stdin?.write("close\n");
    await waitForLine(holder, "CLOSED");
    const handle = await pending;
    expect(handle.graphDb).toBeDefined();
    expect(recordedPid(dbPath)).toBe(process.pid);
    expect(holder.exitCode).toBeNull();
  });

  it("a holder that crashed leaves a stale lock the loser reclaims", async () => {
    const dbPath = makeRoot();
    const holder = await spawnTeaRagsHolder(dbPath);
    await new Promise<void>((r) => {
      holder.once("exit", () => {
        r();
      });
      holder.kill("SIGKILL");
    });
    // The crashed holder never released: its record is still on disk.
    expect(recordedPid(dbPath)).toBe(holder.pid);
    const handle = await makePool({ maxMs: 20_000, intervalMs: 100 }).acquire(COLLECTION);
    expect(handle.graphDb).toBeDefined();
    expect(recordedPid(dbPath)).toBe(process.pid);
  });
});

/**
 * Per-collection idle eviction in GraphDbClientPool (bd tea-rags-mcp-nlls).
 *
 * The daemon's process-level idle timer watches SOCKET clients, so as long as
 * any MCP server stays connected every DuckDB connection the daemon ever
 * opened stays open and holds its per-file RW lock. These specs pin the
 * per-collection eviction: a collection's cached RW client is closed once its
 * last op has been idle for the window, never while an op is in flight, the
 * governor parity hook fires, and the next op lazily re-opens — which is what
 * lets an external process take the DuckDB file lock while the daemon stays
 * up.
 */

import { execFile } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { fixturePhysicalCollectionName } from "../../__helpers__/collection-identity.js";
import type { DuckDbGraphClient } from "../../../../src/core/adapters/duckdb/client.js";
import { CodegraphDbFiles } from "../../../../src/core/adapters/duckdb/codegraph-db-files.js";
import { daemonRuntimeOptionsFromEnv } from "../../../../src/core/adapters/duckdb/daemon/entry.js";
import { DaemonMemoryGovernor } from "../../../../src/core/adapters/duckdb/daemon/memory-governor.js";
import { GraphDbClientPool } from "../../../../src/core/adapters/duckdb/pool.js";
import { InMemoryGlobalSymbolTable } from "../../../../src/core/domains/trajectory/codegraph/symbols/symbol-table.js";

const IDLE_MS = 60_000;
const POLL_MS = 5_000;

let root: string;
const pools: GraphDbClientPool[] = [];

afterEach(async () => {
  vi.useRealTimers();
  for (const pool of pools.splice(0)) {
    await pool.closeAll().catch(() => undefined);
  }
  if (root) rmSync(root, { recursive: true, force: true });
});

type ClosedSink = (collectionName: string) => void;

/** Real pool with eviction wired at the test's (accelerated) poll cadence. */
function makeEvictingPool(closedSink?: ClosedSink) {
  root = mkdtempSync(join(tmpdir(), "cg-nlls-"));
  const onClosed = vi.fn<Parameters<ClosedSink>, ReturnType<ClosedSink>>();
  const pool = new GraphDbClientPool({
    rootDir: root,
    symbolTableFactory: () => new InMemoryGlobalSymbolTable(),
    applyMigrations: async () => undefined,
    idleEviction: { idleMs: IDLE_MS, pollMs: POLL_MS },
    onCollectionClientClosed: (collectionName) => {
      onClosed(collectionName);
      closedSink?.(collectionName);
    },
  });
  pools.push(pool);
  return { pool, onClosed };
}

/**
 * Probe from a SEPARATE node process: can a second connection open the
 * collection's `.duckdb` READ_ONLY? The RW lock is per-process, so an
 * in-process probe would silently share the open instance and prove nothing —
 * the cross-process one is the acceptance (bd tea-rags-mcp-nlls).
 */
async function probeReadOnlyOpen(dbPath: string): Promise<boolean> {
  const script = [
    'const { DuckDBInstance } = await import("@duckdb/node-api");',
    "try {",
    '  await DuckDBInstance.create(process.env.PROBE_DB_PATH, { access_mode: "READ_ONLY" });',
    '  console.log("PROBE_OPEN_OK");',
    "  process.exit(0);",
    "} catch {",
    '  console.log("PROBE_OPEN_LOCKED");',
    "  process.exit(1);",
    "}",
  ].join("\n");
  return new Promise<boolean>((resolve, reject) => {
    execFile(
      process.execPath,
      ["--input-type=module", "-e", script],
      { cwd: process.cwd(), timeout: 60_000, env: { ...process.env, PROBE_DB_PATH: dbPath } },
      (err) => {
        if (!err) {
          resolve(true);
          return;
        }
        if (err.killed) {
          reject(new Error(`probe of ${dbPath} timed out`));
          return;
        }
        resolve(false);
      },
    );
  });
}

describe("GraphDbClientPool — per-collection idle eviction (nlls)", () => {
  it("evicts a collection's cached client once its idle window elapses", async () => {
    vi.useFakeTimers();
    const { pool, onClosed } = makeEvictingPool();
    const c = fixturePhysicalCollectionName("code_nlls_evict_v1");

    const first = await pool.acquire(c);
    await vi.advanceTimersByTimeAsync(POLL_MS); // first poll: 5s idle < window
    expect(onClosed).not.toHaveBeenCalled();
    expect((await pool.acquire(c)).graphDb).toBe(first.graphDb); // still cached

    await vi.advanceTimersByTimeAsync(IDLE_MS); // window elapses; next poll evicts
    // The eviction pass awaits a REAL driver close, which fake-timer flushing
    // does not block on — poll until it settles.
    await vi.waitFor(() => {
      expect(onClosed).toHaveBeenCalledTimes(1);
    });
    expect(onClosed).toHaveBeenCalledWith(c);

    // The next acquire lazily re-opens a FRESH client (the existing open path).
    const second = await pool.acquire(c);
    expect(second.graphDb).not.toBe(first.graphDb);
  });

  it("never evicts while an op is in flight; the idle clock restarts on completion", async () => {
    vi.useFakeTimers();
    const { pool, onClosed } = makeEvictingPool();
    const c = fixturePhysicalCollectionName("code_nlls_inflight_v1");

    await pool.runCollectionOp(c, async (handle) => {
      // One op running longer than the WHOLE window + several polls: the
      // in-flight refcount short-circuits every eviction pass.
      await vi.advanceTimersByTimeAsync(IDLE_MS + 3 * POLL_MS);
      expect(onClosed).not.toHaveBeenCalled();
      expect((await pool.acquire(c)).graphDb).toBe(handle.graphDb);
    });

    // The op COMPLETED just now; eviction needs a full fresh window from there.
    await vi.advanceTimersByTimeAsync(POLL_MS);
    expect(onClosed).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(IDLE_MS);
    await vi.waitFor(() => {
      expect(onClosed).toHaveBeenCalledTimes(1);
    });
  });

  it("re-opens transparently on the next op after an eviction", async () => {
    vi.useFakeTimers();
    const { pool, onClosed } = makeEvictingPool();
    const c = fixturePhysicalCollectionName("code_nlls_reopen_v1");

    const first = await pool.acquire(c);
    await vi.advanceTimersByTimeAsync(POLL_MS + IDLE_MS);
    await vi.waitFor(() => {
      expect(onClosed).toHaveBeenCalledTimes(1);
    });

    const { graphDb, rows } = await pool.runCollectionOp(c, async (handle) => ({
      graphDb: handle.graphDb,
      rows: await (handle.graphDb as DuckDbGraphClient).queryAll<{ v: number }>("SELECT 42 AS v"),
    }));
    expect(graphDb).not.toBe(first.graphDb);
    expect(rows[0].v).toBe(42);
    // The op itself is not a second eviction: still exactly one close.
    expect(onClosed).toHaveBeenCalledTimes(1);
  });

  it("eviction fires the governor parity hook — the collection's raised memory entry is forgotten", async () => {
    vi.useFakeTimers();
    // The same wiring runDaemon installs: a closed client takes its governor
    // entry with it (bd tea-rags-mcp-amh78) — eviction must go through it too.
    const governor = new DaemonMemoryGovernor({ baseLimit: "512MB", maxLimit: "1GB" });
    const { pool, onClosed } = makeEvictingPool((collectionName) => {
      governor.forgetCollection(collectionName);
    });
    const c = fixturePhysicalCollectionName("code_nlls_governor_v1");

    const raised = vi.fn<Parameters<Parameters<typeof governor.onWrite>[1]["exec"]>, []>().mockResolvedValue(undefined);
    await governor.onWrite(c, { exec: raised });
    expect(raised).toHaveBeenCalledTimes(1); // burst ceiling applied

    await pool.acquire(c);
    await vi.advanceTimersByTimeAsync(POLL_MS + IDLE_MS); // evicted
    await vi.waitFor(() => {
      expect(onClosed).toHaveBeenCalledTimes(1);
    });

    // Without forgetCollection the raised entry would survive the eviction and
    // this second write of a burst would be SKIPPED as already-raised.
    const fresh = vi.fn<Parameters<Parameters<typeof governor.onWrite>[1]["exec"]>, []>().mockResolvedValue(undefined);
    await governor.onWrite(c, { exec: fresh });
    expect(fresh).toHaveBeenCalledTimes(1);
    expect(String(fresh.mock.calls[0][0])).toContain("'1GB'");
  });

  it("releases the RW lock: a second process can open the database file once evicted", async () => {
    vi.useFakeTimers();
    const { pool, onClosed } = makeEvictingPool();
    const c = fixturePhysicalCollectionName("code_nlls_probe_v1");
    const dbPath = new CodegraphDbFiles(root).pathFor(c);

    await pool.acquire(c); // opens the RW connection; this process holds the lock
    expect(await probeReadOnlyOpen(dbPath)).toBe(false); // non-vacuity: lock is held

    await vi.advanceTimersByTimeAsync(POLL_MS + IDLE_MS); // evicted → closed
    await vi.waitFor(() => {
      expect(onClosed).toHaveBeenCalledTimes(1);
    });

    expect(await probeReadOnlyOpen(dbPath)).toBe(true); // lock released with the connection
  });

  it("does nothing when eviction is not wired — pools without the option are unchanged", async () => {
    vi.useFakeTimers();
    root = mkdtempSync(join(tmpdir(), "cg-nlls-"));
    const onClosed = vi.fn();
    const pool = new GraphDbClientPool({
      rootDir: root,
      symbolTableFactory: () => new InMemoryGlobalSymbolTable(),
      applyMigrations: async () => undefined,
      onCollectionClientClosed: onClosed,
    });
    pools.push(pool);
    const c = fixturePhysicalCollectionName("code_nlls_plain_v1");

    await pool.acquire(c);
    await vi.advanceTimersByTimeAsync(24 * 60 * 60 * 1000); // a whole day
    expect(onClosed).not.toHaveBeenCalled();
    expect((await pool.acquire(c)).graphDb).toBeDefined();
  });
});

describe("daemonRuntimeOptionsFromEnv — CODEGRAPH_DB_IDLE_EVICT_MS (nlls)", () => {
  const baseEnv = { TEA_RAGS_CODEGRAPH_DAEMON_MIGRATIONS: "file:///migrations.js" } as NodeJS.ProcessEnv;

  it("defaults the eviction window to 60000ms when the env var is unset", () => {
    const options = daemonRuntimeOptionsFromEnv({ ...baseEnv });
    expect(options.idleEvictMs).toBe(60_000);
  });

  it("parses a numeric override from the env var", () => {
    const options = daemonRuntimeOptionsFromEnv({ ...baseEnv, CODEGRAPH_DB_IDLE_EVICT_MS: "15000" });
    expect(options.idleEvictMs).toBe(15_000);
  });

  it("falls back to the default on garbage, zero, or a negative value", () => {
    for (const raw of ["soon", "0", "-5"]) {
      const options = daemonRuntimeOptionsFromEnv({ ...baseEnv, CODEGRAPH_DB_IDLE_EVICT_MS: raw });
      expect(options.idleEvictMs).toBe(60_000);
    }
  });
});

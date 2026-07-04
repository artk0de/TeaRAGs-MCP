/**
 * Adaptive DuckDB memory governor (bd tea-rags-mcp-1ruih).
 *
 * The daemon owns the single RW DuckDB connection per collection and knows its
 * activity phases: on the FIRST write op of an ingest burst the governor raises
 * `memory_limit` to the configured ceiling (CODEGRAPH_DB_MEMORY_LIMIT_MAX,
 * default 4GB); when the idle watcher fires it drops the limit back to the base
 * (CODEGRAPH_DB_MEMORY_LIMIT, default 2GB) BEFORE the RW lock is released.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { DuckDbGraphClient } from "../../../../../src/core/adapters/duckdb/client.js";
import { DaemonMemoryGovernor } from "../../../../../src/core/adapters/duckdb/daemon/memory-governor.js";
import { CodegraphDaemonServer } from "../../../../../src/core/adapters/duckdb/daemon/server.js";
import { GraphDbClientPool } from "../../../../../src/core/adapters/duckdb/pool.js";
import { InMemoryGlobalSymbolTable } from "../../../../../src/core/domains/trajectory/codegraph/symbols/symbol-table.js";

let root: string;
afterEach(() => {
  if (root) rmSync(root, { recursive: true, force: true });
});

/** Read the effective memory_limit off an open client connection. */
async function readLimit(db: DuckDbGraphClient): Promise<string> {
  const rows = await db.queryAll<{ m: string }>("SELECT current_setting('memory_limit') AS m");
  return rows[0].m;
}

/**
 * Capture DuckDB's normalised display string for a given limit (e.g. '1GB' →
 * "953.6 MiB") on a scratch instance, so assertions never hard-code the
 * driver's formatting.
 */
async function displayFor(limit: string): Promise<string> {
  const db = new DuckDbGraphClient({ path: join(root, `display-${limit.replace(/[^a-zA-Z0-9]/g, "")}.duckdb`) });
  await db.init();
  await db.exec(`SET memory_limit = '${limit}'`);
  const value = await readLimit(db);
  await db.close();
  return value;
}

/** Real pool (base limit applied at init) + governor + daemon server. */
function makeGovernedServer(baseLimit: string, maxLimit: string) {
  root = mkdtempSync(join(tmpdir(), "cg-gov-"));
  const pool = new GraphDbClientPool({
    rootDir: root,
    symbolTableFactory: () => new InMemoryGlobalSymbolTable(),
    resources: { memoryLimit: baseLimit },
  });
  const governor = new DaemonMemoryGovernor({ baseLimit, maxLimit });
  const server = new CodegraphDaemonServer(pool, undefined, governor);
  return { pool, governor, server };
}

const upsertFileReq = (collection: string) => ({
  id: 2,
  op: "upsertFile" as const,
  params: {
    collection,
    node: { relPath: "a.ts", language: "typescript" },
    edges: { fileEdges: [], methodEdges: [] },
  },
});

describe("runtime SET memory_limit probe (@duckdb/node-api)", () => {
  it("accepts a live SET memory_limit on an already-open connection — no reopen needed", async () => {
    root = mkdtempSync(join(tmpdir(), "cg-gov-"));
    const db = new DuckDbGraphClient({ path: join(root, "probe.duckdb") });
    await db.init(); // init applies the built-in 2GB default cap
    const initial = await readLimit(db);

    await db.exec("SET memory_limit = '1GB'");
    const afterRaise = await readLimit(db);
    expect(afterRaise).not.toBe(initial);

    await db.exec("SET memory_limit = '512MB'");
    const afterLower = await readLimit(db);
    expect(afterLower).not.toBe(afterRaise);

    await db.close();
  });
});

describe("DaemonMemoryGovernor — raise on write burst, lower on idle (real daemon path)", () => {
  it("first write op through the daemon server raises memory_limit to the governor max", async () => {
    const { pool, server } = makeGovernedServer("512MB", "1GB");
    const c = "code_gov_raise_v1";
    // handshake opens the collection at the BASE limit (non-vacuity baseline).
    expect((await server.handle({ id: 1, op: "handshake", params: { collection: c } })).ok).toBe(true);
    const { graphDb } = await pool.acquire(c);
    const expectedBase = await displayFor("512MB");
    const expectedMax = await displayFor("1GB");
    expect(expectedBase).not.toBe(expectedMax); // proves the assertion below can fail
    expect(await readLimit(graphDb as DuckDbGraphClient)).toBe(expectedBase);

    const up = await server.handle(upsertFileReq(c));
    expect(up.ok).toBe(true);
    expect(await readLimit(graphDb as DuckDbGraphClient)).toBe(expectedMax);
    await pool.closeAll();
  });

  it("onIdle restores the base limit on every raised collection before the lock is released", async () => {
    const { pool, governor, server } = makeGovernedServer("512MB", "1GB");
    const c = "code_gov_idle_v1";
    await server.handle({ id: 1, op: "handshake", params: { collection: c } });
    await server.handle(upsertFileReq(c));
    const { graphDb } = await pool.acquire(c);
    const expectedBase = await displayFor("512MB");
    const expectedMax = await displayFor("1GB");
    expect(await readLimit(graphDb as DuckDbGraphClient)).toBe(expectedMax); // raised by the write

    await governor.onIdle();
    expect(await readLimit(graphDb as DuckDbGraphClient)).toBe(expectedBase);
    await pool.closeAll();
  });

  it("read ops do NOT raise the limit — the governor reacts to writes only", async () => {
    const { pool, server } = makeGovernedServer("512MB", "1GB");
    const c = "code_gov_read_v1";
    await server.handle({ id: 1, op: "handshake", params: { collection: c } });
    const res = await server.handle({ id: 2, op: "hasData", params: { collection: c } });
    expect(res.ok).toBe(true);
    const { graphDb } = await pool.acquire(c);
    expect(await readLimit(graphDb as DuckDbGraphClient)).toBe(await displayFor("512MB"));
    await pool.closeAll();
  });
});

describe("DaemonMemoryGovernor — unit behavior (fake exec targets)", () => {
  it("raises once per collection during a burst — subsequent writes don't re-issue SET", async () => {
    const governor = new DaemonMemoryGovernor({ baseLimit: "512MB", maxLimit: "1GB" });
    const exec = vi.fn().mockResolvedValue(undefined);
    await governor.onWrite("code_a", { exec });
    await governor.onWrite("code_a", { exec });
    expect(exec).toHaveBeenCalledTimes(1);
    expect(String(exec.mock.calls[0][0])).toContain("'1GB'");

    // Independent collections raise independently (per-instance memory_limit).
    const execB = vi.fn().mockResolvedValue(undefined);
    await governor.onWrite("code_b", { exec: execB });
    expect(execB).toHaveBeenCalledTimes(1);
  });

  it("onIdle lowers every raised collection back to base and re-arms the governor", async () => {
    const governor = new DaemonMemoryGovernor({ baseLimit: "512MB", maxLimit: "1GB" });
    const execA = vi.fn().mockResolvedValue(undefined);
    const execB = vi.fn().mockResolvedValue(undefined);
    await governor.onWrite("code_a", { exec: execA });
    await governor.onWrite("code_b", { exec: execB });

    await governor.onIdle();
    expect(String(execA.mock.calls[1][0])).toContain("'512MB'");
    expect(String(execB.mock.calls[1][0])).toContain("'512MB'");

    // Re-armed: the next burst raises again.
    await governor.onWrite("code_a", { exec: execA });
    expect(execA).toHaveBeenCalledTimes(3);
    expect(String(execA.mock.calls[2][0])).toContain("'1GB'");
  });

  it("clamps a max below base to the base limit and logs the config error once", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      const governor = new DaemonMemoryGovernor({ baseLimit: "1GB", maxLimit: "512MB" });
      expect(errSpy).toHaveBeenCalledTimes(1); // logged once, at construction
      const exec = vi.fn().mockResolvedValue(undefined);
      await governor.onWrite("code_a", { exec });
      expect(exec).toHaveBeenCalledTimes(1);
      expect(String(exec.mock.calls[0][0])).toContain("'1GB'"); // clamped to base, not 512MB
    } finally {
      errSpy.mockRestore();
    }
  });

  it("treats binary units correctly when clamping (1024MiB is NOT below 1GB)", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      const governor = new DaemonMemoryGovernor({ baseLimit: "1GB", maxLimit: "1024MiB" });
      expect(errSpy).not.toHaveBeenCalled(); // 1024 MiB (1073741824 B) >= 1 GB (1e9 B)
      const exec = vi.fn().mockResolvedValue(undefined);
      await governor.onWrite("code_a", { exec });
      expect(String(exec.mock.calls[0][0])).toContain("'1024MiB'");
    } finally {
      errSpy.mockRestore();
    }
  });

  it("swallows SET failures (best-effort) — a rejecting exec never propagates", async () => {
    const governor = new DaemonMemoryGovernor({ baseLimit: "512MB", maxLimit: "1GB" });
    const exec = vi.fn().mockRejectedValue(new Error("SET rejected by driver"));
    await expect(governor.onWrite("code_a", { exec })).resolves.toBeUndefined();
    await expect(governor.onIdle()).resolves.toBeUndefined();
  });

  it("ignores a graphDb that exposes no exec — never throws on an unexpected handle shape", async () => {
    const governor = new DaemonMemoryGovernor({ baseLimit: "512MB", maxLimit: "1GB" });
    await expect(governor.onWrite("code_a", {})).resolves.toBeUndefined();
  });
});

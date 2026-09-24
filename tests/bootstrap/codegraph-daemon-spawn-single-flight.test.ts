/**
 * The spawn lock covers the child's startup, not just the `spawn` call
 * (bd tea-rags-mcp-imgjx).
 *
 * `ensureCodegraphDaemon` alive-checks the pid file under the spawn lock, but
 * released the lock the moment `spawn` returned — before the detached child had
 * written its pid file. A second ensure in that window (the index run's
 * keep-alive guard, the pool's respawn hook, a second pool) passed the alive
 * check and spawned a twin: live, two daemons of one build from one parent in
 * the same second, the orphan holding the DuckDB RW lock. The lock is now held
 * until the child is observable (its pid file names a live pid) or it exits,
 * bounded by a timeout.
 *
 * Observed at the process-spawn boundary: `spawn` is recorded and returns a
 * fake child with a pid; the test plays the daemon by writing the pid file.
 */

import type * as ChildProcessModule from "node:child_process";
import type { EventEmitter } from "node:events";
import { existsSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { AppConfig, getZodConfig } from "../../src/bootstrap/config/index.js";
import { wireCodegraph } from "../../src/bootstrap/factory.js";
import { getDaemonPaths } from "../../src/core/adapters/duckdb/daemon/lifecycle.js";
import { GraphDbClientPool } from "../../src/core/adapters/duckdb/index.js";
import type { CollectionGraphHandle } from "../../src/core/adapters/duckdb/pool.js";
import type { CollectionRegistry } from "../../src/core/domains/maintenance/registry/index.js";
import { fixturePhysicalCollectionName } from "../core/__helpers__/collection-identity.js";

const spawned = vi.hoisted(() => ({ children: [] as EventEmitter[] }));

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof ChildProcessModule>();
  const { EventEmitter: Emitter } = await import("node:events");
  return {
    ...actual,
    spawn: vi.fn(() => {
      // A spawned-but-not-yet-listening daemon: it has a pid, and has written nothing.
      const child = Object.assign(new Emitter(), { pid: 424242, unref: () => undefined });
      spawned.children.push(child);
      return child;
    }),
  };
});

let rootDir: string;
let storageDir: string;

beforeEach(() => {
  spawned.children.length = 0;
  rootDir = mkdtempSync(join(tmpdir(), "cg-spawn-flight-"));
  storageDir = join(rootDir, "codegraph");
  vi.stubEnv("TEA_RAGS_CODEGRAPH_DAEMON_DIR", storageDir);
  vi.spyOn(GraphDbClientPool.prototype, "acquireWrite").mockResolvedValue({} as CollectionGraphHandle);
});

afterEach(() => {
  // Let any still-held spawn lock go before the dir disappears.
  for (const child of spawned.children) child.emit("exit", 0, null);
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  rmSync(rootDir, { recursive: true, force: true });
});

function wire() {
  const zodConfig = {
    core: { debug: false },
    codegraph: {
      enabled: true,
      dbPath: rootDir,
      dbMemoryLimit: "2GB",
      dbThreads: 2,
      customExcludePatterns: [],
      ambiguousResolveMode: "strict",
    },
  } as unknown as ReturnType<typeof getZodConfig>;
  const config = { paths: { appData: rootDir } } as unknown as AppConfig;
  const ctx = wireCodegraph(config, zodConfig, {} as CollectionRegistry);
  if (!ctx) throw new Error("codegraph did not wire");
  return ctx;
}

describe("ensureCodegraphDaemon — spawn lock held until the child is observable (imgjx)", () => {
  it("concurrent ensures during the child's startup spawn exactly one daemon", async () => {
    const { pool } = wire();

    await Promise.all([
      pool.acquireWrite(fixturePhysicalCollectionName("code_flight_a_v1")),
      pool.acquireWrite(fixturePhysicalCollectionName("code_flight_b_v1")),
      pool.acquireWrite(fixturePhysicalCollectionName("code_flight_c_v1")),
    ]);

    expect(spawned.children).toHaveLength(1);
    // The spawn lock is still held — another PROCESS's ensure sees it too.
    expect(existsSync(getDaemonPaths(storageDir).lockFile)).toBe(true);
  });

  it("releases the spawn lock once the child's pid file names a live pid", async () => {
    const { pool } = wire();
    const paths = getDaemonPaths(storageDir);
    await pool.acquireWrite(fixturePhysicalCollectionName("code_flight_up_v1"));

    // The daemon comes up: its pid file names a live process.
    writeFileSync(paths.pidFile, String(process.pid));
    await vi.waitFor(
      () => {
        expect(existsSync(paths.lockFile)).toBe(false);
      },
      { timeout: 2_000, interval: 10 },
    );

    // Later the daemon idles out; the next acquire spawns a fresh one.
    unlinkSync(paths.pidFile);
    await pool.acquireWrite(fixturePhysicalCollectionName("code_flight_up_v1"));
    expect(spawned.children).toHaveLength(2);
  });

  it("releases the spawn lock when the child exits before it became observable", async () => {
    const { pool } = wire();
    const paths = getDaemonPaths(storageDir);
    await pool.acquireWrite(fixturePhysicalCollectionName("code_flight_dead_v1"));

    spawned.children[0].emit("exit", 1, null); // startup crash

    expect(existsSync(paths.lockFile)).toBe(false);
    await pool.acquireWrite(fixturePhysicalCollectionName("code_flight_dead_v1"));
    expect(spawned.children).toHaveLength(2);
  });
});

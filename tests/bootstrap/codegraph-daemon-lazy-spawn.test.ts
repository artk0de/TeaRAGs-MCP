/**
 * The lazy daemon spawn re-checks liveness on every acquire (bd tea-rags-mcp-f924y).
 *
 * `wireCodegraph` spawns the codegraph daemon from the first write/read acquire.
 * It used to do that ONCE per process: a daemon that idle-exited — or was
 * drained by another session's build handshake — after that first spawn was
 * never brought back by a later acquire on a collection the pool had not cached
 * yet. That acquire connected to a socket that no longer existed, gave up after
 * the 5s connect window, and the run's keep-alive logged its failure. The spawn
 * itself is alive-checked and single-flighted, so calling it per acquire costs a
 * pid-file probe while the daemon runs.
 *
 * Observed at the process-spawn boundary: `spawn` is recorded, never executed.
 */

import type * as ChildProcessModule from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { AppConfig, getZodConfig } from "../../src/bootstrap/config/index.js";
import { wireCodegraph } from "../../src/bootstrap/factory.js";
import { GraphDbClientPool } from "../../src/core/adapters/duckdb/index.js";
import type { CollectionGraphHandle } from "../../src/core/adapters/duckdb/pool.js";
import type { CollectionRegistry } from "../../src/core/domains/maintenance/registry/index.js";
import { fixturePhysicalCollectionName } from "../core/__helpers__/collection-identity.js";

const spawned = vi.hoisted(() => ({ count: 0 }));

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof ChildProcessModule>();
  return {
    ...actual,
    spawn: vi.fn(() => {
      spawned.count++;
      return { unref: () => undefined };
    }),
  };
});

let rootDir: string;
let storageDir: string;

beforeEach(() => {
  spawned.count = 0;
  rootDir = mkdtempSync(join(tmpdir(), "cg-lazy-spawn-"));
  storageDir = join(rootDir, "codegraph");
  vi.stubEnv("TEA_RAGS_CODEGRAPH_DAEMON_DIR", storageDir);
});

afterEach(() => {
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

describe("wireCodegraph — lazy daemon spawn (f924y)", () => {
  it("spawns again on a later acquire when the daemon it spawned first is gone", async () => {
    // The wrapped acquire runs its lazy spawn first; the pool call behind it is
    // stubbed so nothing tries to connect to a daemon that was never started.
    vi.spyOn(GraphDbClientPool.prototype, "acquireWrite").mockResolvedValue({} as CollectionGraphHandle);
    const { pool } = wire();

    await pool.acquireWrite(fixturePhysicalCollectionName("code_lazy_a_v1"));
    // No pid file was ever written — the daemon never came up, or already left.
    await pool.acquireWrite(fixturePhysicalCollectionName("code_lazy_b_v1"));

    expect(spawned.count).toBe(2);
  });

  it("spawns nothing while a live daemon owns the pid file", async () => {
    vi.spyOn(GraphDbClientPool.prototype, "acquireReader").mockResolvedValue({} as CollectionGraphHandle);
    const { pool } = wire();
    mkdirSync(storageDir, { recursive: true });
    // This test process stands in for the running daemon: its pid answers signal 0.
    writeFileSync(join(storageDir, "codegraph-daemon.pid"), String(process.pid));

    await pool.acquireReader(fixturePhysicalCollectionName("code_lazy_live_v1"));
    await pool.acquireReader(fixturePhysicalCollectionName("code_lazy_live_v1"));

    expect(spawned.count).toBe(0);
  });
});

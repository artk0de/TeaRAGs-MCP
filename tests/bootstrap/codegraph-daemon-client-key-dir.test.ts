/**
 * The lazy spawner addresses the key dir a daemon spawned from this tree will
 * use (bd tea-rags-mcp-llrja).
 *
 * A long-lived server that outlived `npm run build` loaded the OLD build, but
 * `entry.js` is spawned from DISK — the NEW build, keyed under the new
 * fingerprint. Alive-checking (and locking) the loaded build's key dir made the
 * spawner launch a daemon into a dir nobody then connected to, or launch a twin
 * that exited "owned by live daemon" while the client waited out its connect
 * window. The spawner and the pool now resolve the key dir through one rule.
 *
 * Observed at the process-spawn boundary: `spawn` is recorded, never executed.
 * This process's build views are pinned through the fingerprint module.
 */

import type * as ChildProcessModule from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { AppConfig, getZodConfig } from "../../src/bootstrap/config/index.js";
import { wireCodegraph } from "../../src/bootstrap/factory.js";
import type * as BuildFingerprintModule from "../../src/core/adapters/duckdb/daemon/build-fingerprint.js";
import { getDaemonPathsForBuild } from "../../src/core/adapters/duckdb/daemon/lifecycle.js";
import { GraphDbClientPool } from "../../src/core/adapters/duckdb/index.js";
import type { CollectionGraphHandle } from "../../src/core/adapters/duckdb/pool.js";
import type { CollectionRegistry } from "../../src/core/domains/maintenance/registry/index.js";
import { fixturePhysicalCollectionName } from "../core/__helpers__/collection-identity.js";

const spawned = vi.hoisted(() => ({ count: 0 }));
const builds = vi.hoisted((): { loaded: string; onDisk: string | undefined } => ({
  loaded: "LOADED-BUILD-A",
  onDisk: "LOADED-BUILD-A",
}));

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

vi.mock("../../src/core/adapters/duckdb/daemon/build-fingerprint.js", async (importOriginal) => {
  const actual = await importOriginal<typeof BuildFingerprintModule>();
  return {
    ...actual,
    getBuildFingerprint: () => builds.loaded,
    readOnDiskBuildFingerprint: () => builds.onDisk,
  };
});

let rootDir: string;
let storageDir: string;

beforeEach(() => {
  spawned.count = 0;
  builds.loaded = "LOADED-BUILD-A";
  builds.onDisk = "LOADED-BUILD-A";
  rootDir = mkdtempSync(join(tmpdir(), "cg-llrja-spawn-"));
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

/** This test process stands in for a live daemon owning `fingerprint`'s key dir. */
function liveDaemonOf(fingerprint: string): void {
  const paths = getDaemonPathsForBuild(storageDir, fingerprint);
  mkdirSync(paths.buildDir, { recursive: true });
  writeFileSync(paths.pidFile, String(process.pid));
}

describe("wireCodegraph — the spawner addresses the on-disk build's key dir (bd tea-rags-mcp-llrja)", () => {
  it("a stale process spawns nothing while a live daemon of the ON-DISK build owns its key dir", async () => {
    vi.spyOn(GraphDbClientPool.prototype, "acquireWrite").mockResolvedValue({} as CollectionGraphHandle);
    const { pool } = wire();
    // `npm run build` under the running server; a fresh process spawned the new daemon.
    builds.onDisk = "REBUILT-B";
    liveDaemonOf("REBUILT-B");

    await pool.acquireWrite(fixturePhysicalCollectionName("code_llrja_spawn_v1"));

    expect(spawned.count).toBe(0);
  });

  it("a stale process with no daemon of the on-disk build spawns one", async () => {
    vi.spyOn(GraphDbClientPool.prototype, "acquireWrite").mockResolvedValue({} as CollectionGraphHandle);
    const { pool } = wire();
    builds.onDisk = "REBUILT-B";
    // Only the loaded build's daemon is around — not the one this tree spawns.
    liveDaemonOf("LOADED-BUILD-A");

    await pool.acquireWrite(fixturePhysicalCollectionName("code_llrja_spawn_new_v1"));

    expect(spawned.count).toBe(1);
  });

  it("a process whose build tree is gone spawns nothing — there is no entry to launch", async () => {
    vi.spyOn(GraphDbClientPool.prototype, "acquireWrite").mockResolvedValue({} as CollectionGraphHandle);
    const { pool } = wire();
    builds.onDisk = undefined;

    await pool.acquireWrite(fixturePhysicalCollectionName("code_llrja_spawn_gone_v1"));

    expect(spawned.count).toBe(0);
  });

  it("the pool resolves the same key dir the spawner checks", () => {
    const { pool } = wire();
    builds.onDisk = "REBUILT-B";

    const resolve = (pool as unknown as { options: { daemonClientTarget?: () => { paths: { socketPath: string } } } })
      .options.daemonClientTarget;

    expect(resolve?.().paths.socketPath).toBe(getDaemonPathsForBuild(storageDir, "REBUILT-B").socketPath);
  });
});

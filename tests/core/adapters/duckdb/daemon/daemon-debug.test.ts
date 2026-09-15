/**
 * Debug flag inheritance into the codegraph daemon process (bd tea-rags-mcp-gnig6).
 *
 * `isDebug()` reads a module flag only `setDebug` writes. The spawner resolves
 * `core.debug` and calls `setDebug` in ITS process; the detached daemon is a
 * separate process with its own module registry, so the flag started false
 * there no matter how the spawner was launched. Live: with DEBUG=1 the
 * daemon's `codegraph-daemon.log` stayed 0 bytes while the pool retired a
 * stale client — every `isDebug()`-gated line inside the daemon was dead.
 *
 * The spawner now carries its resolved flag in
 * `TEA_RAGS_CODEGRAPH_DAEMON_DEBUG`; this pins the daemon half — the env is
 * parsed into the runtime options, a malformed value is ignored rather than
 * crashing startup, and `runDaemon` adopts the flag before it serves anything.
 */

import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { daemonRuntimeOptionsFromEnv, runDaemon } from "../../../../../src/core/adapters/duckdb/daemon/entry.js";
import { getDaemonPaths } from "../../../../../src/core/adapters/duckdb/daemon/lifecycle.js";
import { DATABASE_MIGRATIONS_MODULE_URL } from "../../../../../src/core/domains/maintenance/migration/database/index.js";
import { isDebug, setDebug } from "../../../../../src/core/infra/runtime.js";

const BASE_ENV = {
  TEA_RAGS_CODEGRAPH_DAEMON_ROOT: "/data/root",
  TEA_RAGS_CODEGRAPH_DAEMON_DIR: "/data/root/codegraph",
  TEA_RAGS_CODEGRAPH_DAEMON_MIGRATIONS: DATABASE_MIGRATIONS_MODULE_URL,
};

describe("daemonRuntimeOptionsFromEnv — debug flag (gnig6)", () => {
  it("reads an enabled flag", () => {
    expect(daemonRuntimeOptionsFromEnv({ ...BASE_ENV, TEA_RAGS_CODEGRAPH_DAEMON_DEBUG: "1" }).debug).toBe(true);
  });

  it("reads a disabled flag", () => {
    expect(daemonRuntimeOptionsFromEnv({ ...BASE_ENV, TEA_RAGS_CODEGRAPH_DAEMON_DEBUG: "0" }).debug).toBe(false);
  });

  it("leaves the flag unset when the spawner passed none", () => {
    expect(daemonRuntimeOptionsFromEnv(BASE_ENV).debug).toBeUndefined();
  });

  it.each([[""], ["yes"], ["true"], ["2"], [" 1"]])("ignores a malformed value (%j) instead of throwing", (value) => {
    expect(daemonRuntimeOptionsFromEnv({ ...BASE_ENV, TEA_RAGS_CODEGRAPH_DAEMON_DEBUG: value }).debug).toBeUndefined();
  });

  it("does not adopt the raw DEBUG variable — the spawner's resolved flag is the only source", () => {
    expect(daemonRuntimeOptionsFromEnv({ ...BASE_ENV, DEBUG: "1" }).debug).toBeUndefined();
  });

  it("resolves the lifecycle paths from the given env, not the ambient one", () => {
    const options = daemonRuntimeOptionsFromEnv(BASE_ENV);
    expect(options.rootDir).toBe("/data/root");
    expect(options.paths.storageDir).toBe("/data/root/codegraph");
  });
});

describe("runDaemon — adopts the spawner's debug flag at startup (gnig6)", () => {
  let root: string | undefined;
  let stopDaemon: (() => Promise<void>) | undefined;

  afterEach(async () => {
    await stopDaemon?.().catch(() => undefined);
    stopDaemon = undefined;
    if (root) rmSync(root, { recursive: true, force: true });
    root = undefined;
    setDebug(true);
  });

  async function startDaemon(debug: boolean | undefined): Promise<void> {
    root = mkdtempSync(join(tmpdir(), "cg-gnig6-"));
    const paths = getDaemonPaths(join(root, "d"));
    mkdirSync(paths.storageDir, { recursive: true });
    const daemon = await runDaemon({
      rootDir: join(root, "data"),
      paths,
      buildFingerprint: "gnig6-daemon",
      migrationsModulePath: DATABASE_MIGRATIONS_MODULE_URL,
      exit: () => undefined,
      debug,
    });
    stopDaemon = daemon.shutdown;
  }

  it("turns debug off when the spawner ran without it", async () => {
    setDebug(true);

    await startDaemon(false);

    expect(isDebug()).toBe(false);
  });

  it("turns debug on when the spawner ran with it", async () => {
    setDebug(false);

    await startDaemon(true);

    expect(isDebug()).toBe(true);
  });

  it("leaves the flag untouched when no debug setting reached the daemon", async () => {
    setDebug(true);

    await startDaemon(undefined);

    expect(isDebug()).toBe(true);
  });
});

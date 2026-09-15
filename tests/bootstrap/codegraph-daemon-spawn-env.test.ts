/**
 * The codegraph daemon's spawn env carries the spawner's resolved debug flag
 * (bd tea-rags-mcp-gnig6).
 *
 * The daemon is a detached process: `setDebug(core.debug)` in the spawner never
 * reaches it, so every `isDebug()`-gated diagnostic inside the daemon was dead.
 * The flag now rides the spawn env like the daemon's other settings. It is
 * written for BOTH values, so a stale `TEA_RAGS_CODEGRAPH_DAEMON_DEBUG`
 * inherited from the spawner's own environment can never override the
 * resolved config — and the daemon's parser reads back exactly what was written.
 */

import { describe, expect, it } from "vitest";

import { buildCodegraphDaemonSpawnEnv } from "../../src/bootstrap/factory.js";
import { daemonRuntimeOptionsFromEnv } from "../../src/core/adapters/duckdb/daemon/entry.js";

const SETTINGS = {
  rootDir: "/data/root",
  storageDir: "/data/root/codegraph",
  resources: { memoryLimit: "2GB", memoryLimitMax: "8GB", threads: 4 },
};

describe("buildCodegraphDaemonSpawnEnv — debug flag (gnig6)", () => {
  it.each([[true], [false]])("round-trips the spawner's resolved debug=%s into the daemon's options", (debug) => {
    const env = buildCodegraphDaemonSpawnEnv({ ...SETTINGS, debug }, {});

    expect(daemonRuntimeOptionsFromEnv(env).debug).toBe(debug);
  });

  it("overrides a debug value inherited from the spawner's own environment", () => {
    const env = buildCodegraphDaemonSpawnEnv(
      { ...SETTINGS, debug: false },
      { TEA_RAGS_CODEGRAPH_DAEMON_DEBUG: "1", DEBUG: "1" },
    );

    expect(daemonRuntimeOptionsFromEnv(env).debug).toBe(false);
  });

  it("keeps carrying the daemon's other settings next to the flag", () => {
    const env = buildCodegraphDaemonSpawnEnv({ ...SETTINGS, debug: true }, { PATH: "/usr/bin" });
    const options = daemonRuntimeOptionsFromEnv(env);

    expect(env.PATH).toBe("/usr/bin");
    expect(options.rootDir).toBe("/data/root");
    expect(options.paths.storageDir).toBe("/data/root/codegraph");
    expect(options.resources).toMatchObject({ memoryLimit: "2GB", memoryLimitMax: "8GB", threads: 4 });
  });
});

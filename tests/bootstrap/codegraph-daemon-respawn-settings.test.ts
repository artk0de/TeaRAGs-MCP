/**
 * A daemon respawned after a build change gets the same spawn settings as the
 * first lazy spawn (bd tea-rags-mcp-8qzyb).
 *
 * `wireCodegraph` spawns the codegraph daemon from two places: the lazy
 * `ensure` on the first write/read, and the pool's `daemonRestart.respawn`
 * after a stale-build handshake. The respawn path used to drop
 * `memoryLimitMax`, so a replaced daemon ran its memory governor with the
 * built-in default ceiling instead of `CODEGRAPH_DB_MEMORY_LIMIT_MAX`.
 *
 * Observed at the process-spawn boundary: the env each spawn carries is read
 * back with the daemon's own parser, `daemonRuntimeOptionsFromEnv`.
 */

import type * as ChildProcessModule from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { AppConfig, getZodConfig } from "../../src/bootstrap/config/index.js";
import { wireCodegraph } from "../../src/bootstrap/factory.js";
import { daemonRuntimeOptionsFromEnv } from "../../src/core/adapters/duckdb/daemon/entry.js";
import { GraphDbClientPool } from "../../src/core/adapters/duckdb/index.js";
import type { CollectionGraphHandle } from "../../src/core/adapters/duckdb/pool.js";
import type { CollectionRegistry } from "../../src/core/domains/maintenance/registry/index.js";
import { fixturePhysicalCollectionName } from "../core/__helpers__/collection-identity.js";

const spawned = vi.hoisted(() => ({ envs: [] as NodeJS.ProcessEnv[] }));

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof ChildProcessModule>();
  return {
    ...actual,
    spawn: vi.fn((_command: string, _args: readonly string[], options: { env?: NodeJS.ProcessEnv }) => {
      spawned.envs.push(options.env ?? {});
      return { unref: () => undefined };
    }),
  };
});

let rootDir: string;

beforeEach(() => {
  spawned.envs = [];
  rootDir = mkdtempSync(join(tmpdir(), "cg-respawn-settings-"));
  vi.stubEnv("TEA_RAGS_CODEGRAPH_DAEMON_DIR", join(rootDir, "codegraph"));
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  rmSync(rootDir, { recursive: true, force: true });
});

function wireWithConfiguredCeiling() {
  const zodConfig = {
    core: { debug: true },
    codegraph: {
      enabled: true,
      dbPath: rootDir,
      dbMemoryLimit: "2GB",
      dbMemoryLimitMax: "4GB",
      dbThreads: 2,
      customExcludePatterns: [],
      ambiguousResolveMode: "strict",
    },
  } as unknown as ReturnType<typeof getZodConfig>;
  const config = { paths: { appData: rootDir } } as unknown as AppConfig;
  return wireCodegraph(config, zodConfig, {} as CollectionRegistry);
}

describe("wireCodegraph — daemon spawn settings (8qzyb)", () => {
  it("respawns a stale-build daemon with the same settings as the first lazy spawn, ceiling included", async () => {
    // Keep the read from connecting to a daemon that is never really spawned;
    // the wired `acquireReader` wrap still runs its lazy `ensure` first.
    vi.spyOn(GraphDbClientPool.prototype, "acquireReader").mockResolvedValue({} as CollectionGraphHandle);
    const ctx = wireWithConfiguredCeiling();
    expect(ctx).toBeDefined();

    await ctx!.pool.acquireReader(fixturePhysicalCollectionName("code_respawn_v1"));
    const { daemonRestart } = (ctx!.pool as unknown as { options: { daemonRestart: { respawn: () => void } } }).options;
    daemonRestart.respawn();

    expect(spawned.envs).toHaveLength(2);
    const [lazySpawn, respawn] = spawned.envs.map((env) => daemonRuntimeOptionsFromEnv(env));
    expect(lazySpawn.resources).toMatchObject({ memoryLimit: "2GB", memoryLimitMax: "4GB", threads: 2 });
    expect(respawn.resources).toEqual(lazySpawn.resources);
    expect(respawn.debug).toBe(lazySpawn.debug);
    expect(respawn.rootDir).toBe(lazySpawn.rootDir);
    expect(respawn.paths.storageDir).toBe(lazySpawn.paths.storageDir);
  });
});

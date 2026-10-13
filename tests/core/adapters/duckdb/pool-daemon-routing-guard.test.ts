/**
 * Daemon mode requires an injected `daemonRouting` (bd tea-rags-mcp-89k7k.35,
 * H4a2). The pool constructs no daemon class itself, so a pool wired for the
 * daemon (`daemonSocketPath` or `daemonClientTarget`) without a way to reach it
 * is a construction bug that must fail at once — not on the first acquire.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { CodegraphDaemonClientTarget } from "../../../../src/core/adapters/duckdb/daemon-ports.js";
import { createDaemonRouting } from "../../../../src/core/adapters/duckdb/daemon/index.js";
import { GraphDbClientPool } from "../../../../src/core/adapters/duckdb/pool.js";
import { createDatabaseMigrationApplier } from "../../../../src/core/domains/maintenance/migration/database/index.js";
import { InMemoryGlobalSymbolTable } from "../../../../src/core/domains/trajectory/codegraph/symbols/symbol-table.js";

describe("GraphDbClientPool — daemon mode requires daemonRouting (H4a2)", () => {
  let tmp: string;
  const symbolTableFactory = (): InMemoryGlobalSymbolTable => new InMemoryGlobalSymbolTable();
  const unusedTarget = (): CodegraphDaemonClientTarget => {
    throw new Error("the guard must not resolve the daemon target");
  };

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "pool-daemon-routing-guard-"));
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it("throws at construction when daemonSocketPath is set without daemonRouting", () => {
    expect(
      () =>
        new GraphDbClientPool({
          rootDir: tmp,
          symbolTableFactory,
          applyMigrations: createDatabaseMigrationApplier(),
          daemonSocketPath: join(tmp, "daemon.sock"),
        }),
    ).toThrow(/daemon mode .* requires daemonRouting.*createDaemonRouting/);
  });

  it("throws at construction when daemonClientTarget is set without daemonRouting", () => {
    expect(
      () =>
        new GraphDbClientPool({
          rootDir: tmp,
          symbolTableFactory,
          applyMigrations: createDatabaseMigrationApplier(),
          daemonClientTarget: unusedTarget,
        }),
    ).toThrow(/requires daemonRouting/);
  });

  it("constructs in daemon mode once daemonRouting is injected, and in direct mode without it", async () => {
    const socketPath = join(tmp, "daemon.sock");
    const routed = new GraphDbClientPool({
      rootDir: tmp,
      symbolTableFactory,
      applyMigrations: createDatabaseMigrationApplier(),
      daemonSocketPath: socketPath,
      daemonRouting: createDaemonRouting({ symbolTableFactory, daemonSocketPath: socketPath }),
    });
    const direct = new GraphDbClientPool({
      rootDir: tmp,
      symbolTableFactory,
      applyMigrations: createDatabaseMigrationApplier(),
    });
    await Promise.all([routed.closeAll(), direct.closeAll()]);
  });
});

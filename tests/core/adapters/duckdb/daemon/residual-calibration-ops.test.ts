import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { DAEMON_OP_COMMANDS } from "../../../../../src/core/adapters/duckdb/daemon/op-commands.js";
import { CodegraphDaemonServer } from "../../../../../src/core/adapters/duckdb/daemon/server.js";
import { DaemonResidualCalibrationStoreProxy } from "../../../../../src/core/adapters/duckdb/daemon/store-proxies/residual-calibration-store-proxy.js";
import { GraphDbClientPool } from "../../../../../src/core/adapters/duckdb/pool.js";
import type { ResidualCalibrationRow } from "../../../../../src/core/contracts/types/codegraph.js";
import { createDatabaseMigrationApplier } from "../../../../../src/core/domains/maintenance/migration/database/index.js";
import { InMemoryGlobalSymbolTable } from "../../../../../src/core/domains/trajectory/codegraph/symbols/symbol-table.js";

let root: string | undefined;
afterEach(() => {
  if (root) rmSync(root, { recursive: true, force: true });
  root = undefined;
});

const ROW: ResidualCalibrationRow = {
  language: "ruby",
  stratum: "block1",
  threshold: 0.5,
  lowerBound: 0.96,
  n: 320,
  pi: null,
  noneRates: null,
  model: "kev-1",
  templateHash: "fold-a",
  graphFingerprint: "g1",
  createdAt: 1,
};

describe("residual calibration ops", () => {
  it("the proxy sends each op with its params", async () => {
    const calls: [string, unknown][] = [];
    const proxy = new DaemonResidualCalibrationStoreProxy({
      call: async (op: string, params: unknown) => {
        calls.push([op, params]);
        return op === "readResidualCalibration" ? [ROW] : null;
      },
    } as never);

    await proxy.writeResidualCalibration("ruby", [ROW]);
    expect(await proxy.readResidualCalibration("ruby")).toEqual([ROW]);
    expect(calls).toEqual([
      ["writeResidualCalibration", { language: "ruby", rows: [ROW] }],
      ["readResidualCalibration", { language: "ruby" }],
    ]);
  });

  it("the daemon writes and reads the calibration of a collection", async () => {
    root = mkdtempSync(join(tmpdir(), "cg-daemon-calibration-"));
    const pool = new GraphDbClientPool({
      rootDir: root,
      symbolTableFactory: () => new InMemoryGlobalSymbolTable(),
      applyMigrations: createDatabaseMigrationApplier(),
    });
    const server = new CodegraphDaemonServer(pool);
    const c = "code_calibration_v1";

    const written = await server.handle({
      id: 1,
      op: "writeResidualCalibration",
      params: { collection: c, language: "ruby", rows: [ROW] },
    });
    const read = await server.handle({
      id: 2,
      op: "readResidualCalibration",
      params: { collection: c, language: "ruby" },
    });

    expect(DAEMON_OP_COMMANDS.writeResidualCalibration.access).toBe("write");
    expect(DAEMON_OP_COMMANDS.readResidualCalibration.access).toBe("read");
    expect(written.ok).toBe(true);
    expect((read as { result: unknown }).result).toEqual([ROW]);
    await pool.closeAll();
  });
});

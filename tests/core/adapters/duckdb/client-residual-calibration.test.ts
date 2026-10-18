import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { DuckDbGraphClient } from "../../../../src/core/adapters/duckdb/client.js";
import type { ResidualCalibrationRow } from "../../../../src/core/contracts/types/codegraph-residual.js";
import { DATABASE_MIGRATIONS } from "../../../../src/core/domains/maintenance/migration/database/migrations/index.js";
import { runMigrations } from "../../../../src/core/domains/maintenance/migration/database/runner.js";

function row(over: Partial<ResidualCalibrationRow> = {}): ResidualCalibrationRow {
  return {
    language: "ruby",
    stratum: "fullMenu",
    threshold: 0.8,
    lowerBound: 0.95,
    n: 400,
    pi: 0.733,
    noneRates: { residual: 0.65, onMenu: 0.05, external: 0.869 },
    model: "kev-1",
    templateHash: "fold-a",
    graphFingerprint: "g1",
    createdAt: 1_760_000_000_000,
    ...over,
  };
}

describe("DuckDbGraphClient — residual calibration", () => {
  let tmp: string;
  let client: DuckDbGraphClient;

  beforeEach(async () => {
    tmp = mkdtempSync(join(tmpdir(), "cg-residual-calibration-"));
    client = new DuckDbGraphClient({ path: join(tmp, "g.duckdb") });
    await client.init();
    await runMigrations(client, DATABASE_MIGRATIONS);
  });

  afterEach(async () => {
    await client.close();
    rmSync(tmp, { recursive: true, force: true });
  });

  it("reads back every field it wrote, ordered by stratum", async () => {
    const block1 = row({ stratum: "block1", threshold: 0.5, pi: null, noneRates: null });
    const none = row({ stratum: "none", threshold: null, lowerBound: null });
    await client.writeResidualCalibration("ruby", [row(), none, block1]);

    expect(await client.readResidualCalibration("ruby")).toEqual([block1, row(), none]);
  });

  it("replaces the language's rows and leaves other languages alone", async () => {
    await client.writeResidualCalibration("ruby", [row(), row({ stratum: "none" })]);
    await client.writeResidualCalibration("python", [row({ language: "python" })]);
    await client.writeResidualCalibration("ruby", [row({ stratum: "block1", model: "kev-2" })]);

    expect(await client.readResidualCalibration("ruby")).toEqual([row({ stratum: "block1", model: "kev-2" })]);
    expect(await client.readResidualCalibration("python")).toEqual([row({ language: "python" })]);
  });

  it("an empty write clears the language", async () => {
    await client.writeResidualCalibration("ruby", [row()]);
    await client.writeResidualCalibration("ruby", []);

    expect(await client.readResidualCalibration("ruby")).toEqual([]);
  });
});

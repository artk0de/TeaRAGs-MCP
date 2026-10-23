import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { DuckDbGraphClient } from "../../../../src/core/adapters/duckdb/client.js";
import { DATABASE_MIGRATIONS } from "../../../../src/core/domains/maintenance/migration/database/migrations/index.js";
import { runMigrations } from "../../../../src/core/domains/maintenance/migration/database/runner.js";

// bd s3i8m — the rustc driver's outcome is a fact of the codegraph run that
// produced it, written by the enrichment worker and read later by status and
// prime: one record per collection, replaced by every run that resolved Rust.

describe("DuckDbGraphClient — rustc driver status (s3i8m)", () => {
  let dir: string;
  let db: DuckDbGraphClient;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "cg-rustc-driver-status-"));
    db = new DuckDbGraphClient({ path: join(dir, "g.duckdb") });
    await db.init();
    await runMigrations(db, DATABASE_MIGRATIONS);
  });

  afterEach(async () => {
    await db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("reads null before any run recorded one", async () => {
    expect(await db.getRustcDriverStatus()).toBeNull();
  });

  it("round-trips the status and the time it was recorded", async () => {
    await db.recordRustcDriverStatus({
      status: { outcome: "indexed", cacheHit: false, units: 412, failedCrates: ["capi"], wallMs: 648_000 },
      recordedAtMs: 1_790_000_000_000,
    });

    expect(await db.getRustcDriverStatus()).toEqual({
      status: { outcome: "indexed", cacheHit: false, units: 412, failedCrates: ["capi"], wallMs: 648_000 },
      recordedAtMs: 1_790_000_000_000,
    });
  });

  it("a later run REPLACES the record — one status per collection", async () => {
    await db.recordRustcDriverStatus({ status: { outcome: "off" }, recordedAtMs: 1 });
    await db.recordRustcDriverStatus({ status: { outcome: "unavailable", hint: "install" }, recordedAtMs: 2 });

    expect(await db.getRustcDriverStatus()).toEqual({
      status: { outcome: "unavailable", hint: "install" },
      recordedAtMs: 2,
    });
  });
});

import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { DuckDbGraphClient } from "../../../../../../src/core/adapters/duckdb/client.js";
import { DuckDbGraphSession } from "../../../../../../src/core/adapters/duckdb/graph-session.js";
import {
  createDatabaseMigrationApplier,
  runMigrations,
} from "../../../../../../src/core/domains/maintenance/migration/database/index.js";
import { DATABASE_MIGRATIONS } from "../../../../../../src/core/domains/maintenance/migration/database/migrations/index.js";

const DROP = "067-cg-drop-edge-file-target-index.sql";
const CREATE = "068-cg-create-edge-file-target-index.sql";
const INDEX = "idx_cg_symbols_edges_file_target";
const REPO = resolve(import.meta.dirname, "../../../../../..");

/**
 * bd tea-rags-mcp-m7png — taxdome's `idx_cg_symbols_edges_file_target` missed 26
 * model rows its table held, and the next walk's DELETE over them invalidated
 * the database. 067 + 068 rebuild that index once on every existing database.
 * The drift itself is not reproducible on demand, so the suite pins that the
 * index is a fresh one and that lookups through it agree with a scan — and that
 * the rebuild survives a CHECKPOINTED index, which a single-transaction
 * DROP + CREATE does not (it aborts the process at COMMIT on DuckDB 1.5.3).
 */
describe("067 + 068 rebuild the file edge target index", () => {
  let dir: string;
  let path: string;
  let db: DuckDbGraphClient;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "cg-edge-target-index-mig-"));
    path = join(dir, "g.duckdb");
    db = new DuckDbGraphClient({ path });
    await db.init();
    await runMigrations(
      db,
      DATABASE_MIGRATIONS.filter((m) => m.filename < DROP),
    );
    await db.exec(
      "INSERT INTO cg_symbols_edges_file (source_rel_path, target_rel_path, origin) VALUES " +
        "('a.rb', 'x.rb', NULL), ('b.rb', 'x.rb', 'model'), ('c.rb', 'y.rb', 'model')",
    );
  });

  afterEach(async () => {
    await db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const indexOf = async (): Promise<{ index_oid: unknown; sql: string }[]> =>
    db.queryAll<{ index_oid: unknown; sql: string }>(
      "SELECT index_oid, sql FROM duckdb_indexes() WHERE index_name = ?",
      [INDEX],
    );

  it("registers the drop after 066 and the create right after it", () => {
    const names = DATABASE_MIGRATIONS.map((m) => m.filename);
    expect(names.indexOf(DROP)).toBe(names.indexOf("066-cg-rustc-driver-status.sql") + 1);
    expect(names.indexOf(CREATE)).toBe(names.indexOf(DROP) + 1);
  });

  it("recreates the index over the same column, and lookups match a scan", async () => {
    const [before] = await indexOf();

    const outcome = await runMigrations(db, DATABASE_MIGRATIONS);

    expect(outcome.applied).toEqual([DROP, CREATE, "069-cg-storage-format-2.ts"]);
    const after = await indexOf();
    expect(after).toHaveLength(1);
    expect(after[0].index_oid).not.toEqual(before.index_oid);
    expect(after[0].sql).toContain("(target_rel_path)");
    const lookup = await db.queryAll(
      "SELECT source_rel_path FROM cg_symbols_edges_file WHERE target_rel_path = 'x.rb' ORDER BY 1",
    );
    const scan = await db.queryAll(
      "SELECT source_rel_path FROM cg_symbols_edges_file WHERE target_rel_path || '' = 'x.rb' ORDER BY 1",
    );
    expect(lookup).toEqual(scan);
    expect(lookup).toHaveLength(2);
  });

  it("is recorded once, so a later open does not rebuild again", async () => {
    await runMigrations(db, DATABASE_MIGRATIONS);
    const [first] = await indexOf();

    const outcome = await runMigrations(db, DATABASE_MIGRATIONS);

    expect(outcome.applied).toEqual([]);
    expect((await indexOf())[0].index_oid).toEqual(first.index_oid);
  });

  // The session closes without a shutdown checkpoint, so a rebuilt index left in
  // the WAL is replayed by the next opener — and a READ_ONLY opener cannot
  // replay a CREATE INDEX over a populated table ("Could not write file").
  it("the production applier leaves no index rebuild in the WAL for a READ_ONLY opener to replay", async () => {
    await db.exec("CHECKPOINT");

    await createDatabaseMigrationApplier()(db);
    await db.close();

    const reader = new DuckDbGraphSession({ path, accessMode: "READ_ONLY" });
    await reader.open();
    try {
      expect(
        await reader.queryAll("SELECT source_rel_path FROM cg_symbols_edges_file WHERE target_rel_path = 'x.rb'"),
      ).toHaveLength(2);
    } finally {
      await reader.close();
    }
    db = new DuckDbGraphClient({ path });
    await db.init();
  });

  // A native abort cannot be caught in-process, so the migrations run in a
  // child: a regression shows up as a non-zero exit / SIGABRT, not as a dead
  // vitest worker.
  it("rebuilds a checkpointed index without aborting the process that opened the database", async () => {
    await db.exec("CHECKPOINT");
    await db.close();
    const module = (rel: string): string => pathToFileURL(join(REPO, rel)).href;
    const script = `
      const { DuckDbGraphClient } = await import(${JSON.stringify(module("src/core/adapters/duckdb/client.ts"))});
      const { DATABASE_MIGRATIONS } = await import(${JSON.stringify(module("src/core/domains/maintenance/migration/database/migrations/index.ts"))});
      const { runMigrations } = await import(${JSON.stringify(module("src/core/domains/maintenance/migration/database/runner.ts"))});
      const client = new DuckDbGraphClient({ path: ${JSON.stringify(path)} });
      await client.init();
      const outcome = await runMigrations(client, DATABASE_MIGRATIONS);
      await client.close();
      process.stdout.write(JSON.stringify(outcome.applied));
    `;

    const child = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], {
      cwd: REPO,
      encoding: "utf8",
      timeout: 60_000,
    });

    expect({ status: child.status, signal: child.signal, stderr: child.stderr.slice(-300) }).toEqual({
      status: 0,
      signal: null,
      stderr: "",
    });
    expect(JSON.parse(child.stdout)).toEqual([DROP, CREATE, "069-cg-storage-format-2.ts"]);
    db = new DuckDbGraphClient({ path });
    await db.init();
    expect(await indexOf()).toHaveLength(1);
  });
});

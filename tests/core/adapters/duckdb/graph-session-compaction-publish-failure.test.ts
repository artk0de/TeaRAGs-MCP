/**
 * The publish step of a compaction — the atomic rename of the staged copy over
 * the live file — failing must leave the original database file, its rows and
 * the client exactly as they were (bd tea-rags-mcp-dvzdm). The rename is the
 * commit point: before it nothing the readers see has moved.
 */

import type * as NodeFs from "node:fs";
import { existsSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const renameControl = vi.hoisted(() => ({ fail: false }));

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof NodeFs>();
  return {
    ...actual,
    renameSync: (from: string, to: string) => {
      if (renameControl.fail) throw Object.assign(new Error("EXDEV: injected rename failure"), { code: "EXDEV" });
      actual.renameSync(from, to);
    },
  };
});

const { DuckDbGraphClient } = await import("../../../../src/core/adapters/duckdb/client.js");
const { compactionStagingPath } = await import("../../../../src/core/adapters/duckdb/codegraph-db-files.js");
const { CodegraphStorageCompactionFailedError } = await import("../../../../src/core/adapters/duckdb/errors.js");
const { DATABASE_MIGRATIONS } =
  await import("../../../../src/core/domains/maintenance/migration/database/migrations/index.js");
const { runMigrations } = await import("../../../../src/core/domains/maintenance/migration/database/runner.js");

describe("DuckDbGraphClient#compactStorage — a failed publish", () => {
  let dir: string;
  let path: string;
  let db: InstanceType<typeof DuckDbGraphClient>;

  beforeEach(async () => {
    renameControl.fail = false;
    dir = mkdtempSync(join(tmpdir(), "cg-compaction-publish-"));
    path = join(dir, "g.duckdb");
    db = new DuckDbGraphClient({ path, compactionPolicy: { minFileBytes: 0, minStoredToLiveRatio: 2 } });
    await db.init();
    await runMigrations(db, DATABASE_MIGRATIONS);
    for (let run = 0; run < 4; run++) {
      await db.run("DELETE FROM cg_symbols_files");
      for (let f = 0; f < 30; f++) {
        await db.run("INSERT INTO cg_symbols_files (rel_path, language) VALUES (?, 'ruby')", [`app/f${f}.rb`]);
      }
      await db.checkpoint();
    }
  });

  afterEach(async () => {
    renameControl.fail = false;
    await db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("leaves the original file, its rows and the client untouched, and removes the staged copy", async () => {
    const inode = statSync(path).ino;
    renameControl.fail = true;

    const err = await db.compactStorage().catch((e: unknown) => e);

    expect(err).toBeInstanceOf(CodegraphStorageCompactionFailedError);
    expect(statSync(path).ino).toBe(inode);
    expect(existsSync(compactionStagingPath(path))).toBe(false);
    // Still the same open database, still writable.
    await db.run("INSERT INTO cg_symbols_files (rel_path, language) VALUES ('app/new.rb', 'ruby')");
    const [r] = await db.queryAll<{ n: number | bigint }>("SELECT count(*) AS n FROM cg_symbols_files");
    expect(Number(r.n)).toBe(31);

    // And the next attempt, with the fault gone, goes through.
    renameControl.fail = false;
    expect((await db.compactStorage()).kind).toBe("compacted");
  });
});

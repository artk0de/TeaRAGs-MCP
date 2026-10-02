/**
 * `DuckDbGraphClient#exportSnapshot` — a consistent copy of a live codegraph
 * database at an arbitrary path, taken by the session that owns the file (bd
 * tea-rags-mcp-xi2r9, WTO-7 base snapshot).
 *
 * A raw file copy is unsafe: the owner may write or checkpoint mid-copy, and
 * rows committed since the last checkpoint live only in the WAL. The export
 * goes through the owning connection instead, lands at the target by rename
 * only, and leaves the live database exactly as it was — no checkpoint, no swap.
 */

import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { DuckDbGraphClient } from "../../../../src/core/adapters/duckdb/client.js";
import { snapshotStagingPath, walHoldsData } from "../../../../src/core/adapters/duckdb/database-file-compaction.js";
import { CodegraphSnapshotExportFailedError } from "../../../../src/core/adapters/duckdb/errors.js";
import { DATABASE_MIGRATIONS } from "../../../../src/core/domains/maintenance/migration/database/migrations/index.js";
import { runMigrations } from "../../../../src/core/domains/maintenance/migration/database/runner.js";

describe("DuckDbGraphClient#exportSnapshot", () => {
  let dir: string;
  let path: string;
  let target: string;
  let db: DuckDbGraphClient;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "cg-snapshot-"));
    path = join(dir, "g.duckdb");
    target = join(dir, "wt", "nested", "snapshot.duckdb");
    db = new DuckDbGraphClient({ path });
    await db.init();
    await runMigrations(db, DATABASE_MIGRATIONS);
    await db.checkpoint();
  });

  afterEach(async () => {
    await db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  /** Commit `n` rows WITHOUT a checkpoint, so they live only in the WAL. */
  async function commitToWal(client: DuckDbGraphClient, n: number): Promise<void> {
    for (let f = 0; f < n; f++) {
      await client.run("INSERT INTO cg_symbols_files (rel_path, language) VALUES (?, 'typescript')", [`src/f${f}.ts`]);
    }
  }

  async function relPathsIn(dbPath: string): Promise<string[]> {
    const reader = new DuckDbGraphClient({ path: dbPath, accessMode: "READ_ONLY" });
    await reader.init();
    try {
      const rows = await reader.queryAll<{ rel_path: string }>(
        "SELECT rel_path FROM cg_symbols_files ORDER BY rel_path",
      );
      return rows.map((r) => r.rel_path);
    } finally {
      await reader.close();
    }
  }

  it("carries rows committed only to the WAL, and leaves the live file and its WAL untouched", async () => {
    await commitToWal(db, 5);
    expect(walHoldsData(path)).toBe(true);
    const inode = statSync(path).ino;

    await db.exportSnapshot(target);

    expect(await relPathsIn(target)).toEqual(["src/f0.ts", "src/f1.ts", "src/f2.ts", "src/f3.ts", "src/f4.ts"]);
    // The live database was not checkpointed nor swapped.
    expect(statSync(path).ino).toBe(inode);
    expect(walHoldsData(path)).toBe(true);
    // And it is still the same open, writable client.
    await db.run("INSERT INTO cg_symbols_files (rel_path, language) VALUES ('src/after.ts', 'typescript')");
    const [r] = await db.queryAll<{ n: number | bigint }>("SELECT count(*) AS n FROM cg_symbols_files");
    expect(Number(r.n)).toBe(6);
  });

  it("publishes atomically: no staging file and no WAL is left beside the target", async () => {
    await commitToWal(db, 3);

    await db.exportSnapshot(target);

    expect(existsSync(target)).toBe(true);
    expect(existsSync(snapshotStagingPath(target))).toBe(false);
    expect(existsSync(`${snapshotStagingPath(target)}.wal`)).toBe(false);
    expect(walHoldsData(target)).toBe(false);
  });

  it("replaces an existing target by rename (a fresh inode), clearing stale staging and the old target's WAL", async () => {
    await commitToWal(db, 2);
    mkdirSync(join(dir, "wt", "nested"), { recursive: true });
    writeFileSync(target, "previous snapshot");
    // The previous occupant's log: replayed into the new snapshot, it would corrupt it.
    writeFileSync(`${target}.wal`, "previous snapshot's wal");
    writeFileSync(snapshotStagingPath(target), "interrupted export");
    const previousInode = statSync(target).ino;

    await db.exportSnapshot(target);

    expect(statSync(target).ino).not.toBe(previousInode);
    expect(existsSync(`${target}.wal`)).toBe(false);
    expect(await relPathsIn(target)).toEqual(["src/f0.ts", "src/f1.ts"]);
    expect(existsSync(snapshotStagingPath(target))).toBe(false);
  });

  it("works from a READ_ONLY session — the target is attached read-write explicitly", async () => {
    await commitToWal(db, 4);
    // `close` does not checkpoint: the rows stay in the WAL for the reader to replay.
    await db.close();
    expect(walHoldsData(path)).toBe(true);
    const reader = new DuckDbGraphClient({ path, accessMode: "READ_ONLY" });
    await reader.init();
    try {
      await reader.exportSnapshot(target);
    } finally {
      await reader.close();
    }

    expect(await relPathsIn(target)).toHaveLength(4);
    expect(walHoldsData(path)).toBe(true);
    db = new DuckDbGraphClient({ path });
    await db.init();
  });

  it("a copy that fails throws the typed error, removes nothing it did not create, and keeps the client working", async () => {
    await commitToWal(db, 2);
    // A directory where the staging file must go: ATTACH cannot create it.
    mkdirSync(snapshotStagingPath(target), { recursive: true });

    const err = await db.exportSnapshot(target).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(CodegraphSnapshotExportFailedError);
    expect((err as CodegraphSnapshotExportFailedError).stage).toBe("copy");
    expect(existsSync(target)).toBe(false);
    const [r] = await db.queryAll<{ n: number | bigint }>("SELECT count(*) AS n FROM cg_symbols_files");
    expect(Number(r.n)).toBe(2);
  });
});

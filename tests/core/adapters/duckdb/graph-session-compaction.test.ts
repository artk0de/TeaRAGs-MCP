/**
 * `DuckDbGraphClient#compactStorage` — rewrite a codegraph database whose file
 * is mostly dead row versions into a fresh file, and swap it in under the same
 * client (bd tea-rags-mcp-dvzdm).
 *
 * Per-file churn tables (`cg_symbols`, the edge tables) are diffed per changed
 * file, and DuckDB 1.5.3 never vacuums deletes from a table that has an index,
 * so their dead versions accumulate for good. `COPY FROM DATABASE` into a new
 * file drops them (taxdome: 1.22 GB → 287 MB in 3.8 s); the swap has to keep
 * every row, every key and index, whatever sat in the WAL, and the client the
 * pool and the daemon hand out.
 */

import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { DuckDbGraphClient } from "../../../../src/core/adapters/duckdb/client.js";
import { compactionStagingPath } from "../../../../src/core/adapters/duckdb/codegraph-db-files.js";
import { CodegraphStorageCompactionFailedError } from "../../../../src/core/adapters/duckdb/errors.js";
import { DATABASE_MIGRATIONS } from "../../../../src/core/domains/maintenance/migration/database/migrations/index.js";
import { runMigrations } from "../../../../src/core/domains/maintenance/migration/database/runner.js";

const EAGER = { minFileBytes: 0, minStoredToLiveRatio: 2 };

describe("DuckDbGraphClient#compactStorage", () => {
  let dir: string;
  let path: string;
  let db: DuckDbGraphClient;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "cg-compaction-"));
    path = join(dir, "g.duckdb");
    db = new DuckDbGraphClient({ path, compactionPolicy: EAGER });
    await db.init();
    await runMigrations(db, DATABASE_MIGRATIONS);
  });

  afterEach(async () => {
    await db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  /** One incremental "re-walk" of every file: its symbol slice deleted and re-inserted. */
  async function churnSymbols(files: number, runs: number): Promise<void> {
    for (let run = 0; run < runs; run++) {
      for (let f = 0; f < files; f++) {
        await db.run("DELETE FROM cg_symbols WHERE rel_path = ?", [`src/f${f}.ts`]);
        for (let s = 0; s < 4; s++) {
          await db.run(
            "INSERT INTO cg_symbols (rel_path, symbol_id, fq_name, short_name, scope_json) VALUES (?, ?, ?, ?, '{}')",
            [`src/f${f}.ts`, `S${s}#m`, `S${s}#m${run}`, "m"],
          );
        }
      }
      await db.checkpoint();
    }
  }

  async function snapshot(): Promise<{ rows: Record<string, number>; keys: string[]; indexes: string[] }> {
    const tables = await db.queryAll<{ t: string }>(
      "SELECT table_name AS t FROM duckdb_tables() WHERE database_name = current_database() ORDER BY 1",
    );
    const rows: Record<string, number> = {};
    for (const { t } of tables) {
      const [r] = await db.queryAll<{ n: number | bigint }>(`SELECT count(*) AS n FROM ${t}`);
      rows[t] = Number(r.n);
    }
    const keys = await db.queryAll<{ k: string }>(
      "SELECT table_name || ':' || constraint_text AS k FROM duckdb_constraints() WHERE database_name = current_database() AND constraint_type = 'PRIMARY KEY' ORDER BY 1",
    );
    const indexes = await db.queryAll<{ s: string }>(
      "SELECT sql AS s FROM duckdb_indexes() WHERE database_name = current_database() ORDER BY index_name",
    );
    return { rows, keys: keys.map((k) => k.k), indexes: indexes.map((i) => i.s) };
  }

  async function storedRows(table: string): Promise<number> {
    const [r] = await db.queryAll<{ n: number | bigint }>(
      "SELECT estimated_size AS n FROM duckdb_tables() WHERE table_name = ?",
      [table],
    );
    return Number(r.n);
  }

  it("rewrites a bloated file: every row, key and index survives, the dead versions do not", async () => {
    await churnSymbols(50, 6);
    const before = await snapshot();
    expect(await storedRows("cg_symbols")).toBe(6 * 200);
    const inodeBefore = statSync(path).ino;

    const outcome = await db.compactStorage();

    expect(outcome.kind).toBe("compacted");
    expect(await snapshot()).toEqual(before);
    expect(await storedRows("cg_symbols")).toBe(200);
    expect(statSync(path).ino).not.toBe(inodeBefore);
    expect(existsSync(compactionStagingPath(path))).toBe(false);
    if (outcome.kind === "compacted") {
      expect(outcome.liveRows).toBeLessThan(outcome.storedRows);
      expect(outcome.bytesAfter).toBe(statSync(path).size);
    }
  });

  it("the same client keeps reading and writing after the swap, and identifies the new file", async () => {
    await churnSymbols(20, 4);
    await db.compactStorage();

    await db.upsertFile({ relPath: "src/after.ts", language: "typescript" }, { fileEdges: [], methodEdges: [] });
    const [r] = await db.queryAll<{ n: number | bigint }>(
      "SELECT count(*) AS n FROM cg_symbols_files WHERE rel_path = 'src/after.ts'",
    );
    expect(Number(r.n)).toBe(1);

    const opened = db.openedDatabaseFile();
    const onDisk = statSync(path, { bigint: true });
    expect(opened).toEqual({ dev: onDisk.dev, ino: onDisk.ino });

    // What the next process sees once this one closes.
    await db.close();
    db = new DuckDbGraphClient({ path });
    await db.init();
    const [again] = await db.queryAll<{ n: number | bigint }>(
      "SELECT count(*) AS n FROM cg_symbols_files WHERE rel_path = 'src/after.ts'",
    );
    expect(Number(again.n)).toBe(1);
  });

  it("carries rows that only lived in the WAL into the compacted file", async () => {
    await churnSymbols(20, 4);
    // Written after the last checkpoint — present only in <path>.wal right now.
    await db.run("INSERT INTO cg_symbols_files (rel_path, language) VALUES ('src/wal-only.ts', 'typescript')");
    expect(existsSync(`${path}.wal`)).toBe(true);

    expect((await db.compactStorage()).kind).toBe("compacted");
    await db.close();

    db = new DuckDbGraphClient({ path });
    await db.init();
    const [r] = await db.queryAll<{ n: number | bigint }>(
      "SELECT count(*) AS n FROM cg_symbols_files WHERE rel_path = 'src/wal-only.ts'",
    );
    expect(Number(r.n)).toBe(1);
  });

  it("skips a file below the threshold and leaves it untouched", async () => {
    await db.close();
    db = new DuckDbGraphClient({ path });
    await db.init();
    await churnSymbols(5, 3);
    const inode = statSync(path).ino;

    const outcome = await db.compactStorage();

    expect(outcome).toMatchObject({ kind: "skipped", reason: "belowThreshold" });
    expect(statSync(path).ino).toBe(inode);
  });

  it("skips while a stream holds its own connection on the file", async () => {
    await churnSymbols(10, 4);
    await db.run(
      "INSERT INTO cg_symbols_edges_file (source_rel_path, target_rel_path) VALUES ('src/a.ts', 'src/b.ts')",
    );
    await db.run(
      "INSERT INTO cg_symbols_edges_file (source_rel_path, target_rel_path) VALUES ('src/b.ts', 'src/c.ts')",
    );
    const stream = db.streamAdjacency("file");
    // Suspended mid-drain: the stream's connection is open, no native call runs.
    expect((await stream.next()).done).toBe(false);
    const outcome = await db.compactStorage();
    await stream.return?.(undefined);

    expect(outcome).toMatchObject({ kind: "skipped", reason: "streamOpen" });
  });

  it("a read issued while the swap runs waits for it and answers from the new file", async () => {
    await churnSymbols(30, 4);
    const compacting = db.compactStorage();
    const reading = db.queryAll<{ n: number | bigint }>("SELECT count(*) AS n FROM cg_symbols");

    const [outcome, rows] = await Promise.all([compacting, reading]);

    expect(outcome.kind).toBe("compacted");
    expect(Number(rows[0].n)).toBe(120);
  });

  it("a copy that fails leaves the original file in place and the client working", async () => {
    await churnSymbols(10, 4);
    const before = await snapshot();
    const inode = statSync(path).ino;
    // A directory where the staging file must go: ATTACH cannot create it.
    mkdirSync(compactionStagingPath(path));

    const err = await db.compactStorage().catch((e: unknown) => e);

    expect(err).toBeInstanceOf(CodegraphStorageCompactionFailedError);
    expect(statSync(path).ino).toBe(inode);
    expect(await snapshot()).toEqual(before);
  });

  it("clears a staging file an interrupted compaction left behind", async () => {
    await churnSymbols(10, 4);
    const staging = compactionStagingPath(path);
    const leftover = new DuckDbGraphClient({ path: staging });
    await leftover.init();
    await leftover.exec("CREATE TABLE junk (x INTEGER)");
    await leftover.close();

    expect((await db.compactStorage()).kind).toBe("compacted");
    const [junk] = await db.queryAll<{ n: number | bigint }>(
      "SELECT count(*) AS n FROM duckdb_tables() WHERE table_name = 'junk'",
    );
    expect(Number(junk.n)).toBe(0);
  });
});

/**
 * `DuckDbGraphSession` edges that the happy-path suites do not reach: a
 * read-only session refusing compaction, a snapshot whose publish step cannot
 * land, `recreateEmptyTable` refusing bad input and keeping indexes, and
 * callers racing a compaction's swap gate.
 */

import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { DuckDbGraphClient } from "../../../../src/core/adapters/duckdb/client.js";
import { snapshotStagingPath } from "../../../../src/core/adapters/duckdb/database-file-compaction.js";
import { CodegraphSnapshotExportFailedError } from "../../../../src/core/adapters/duckdb/errors.js";
import { DuckDbGraphSession } from "../../../../src/core/adapters/duckdb/graph-session.js";
import { DATABASE_MIGRATIONS } from "../../../../src/core/domains/maintenance/migration/database/migrations/index.js";
import { runMigrations } from "../../../../src/core/domains/maintenance/migration/database/runner.js";

describe("DuckDbGraphClient fault paths", () => {
  let dir: string;
  let path: string;
  let db: DuckDbGraphClient;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "cg-fault-paths-"));
    path = join(dir, "g.duckdb");
    db = new DuckDbGraphClient({ path, compactionPolicy: { minFileBytes: 0, minStoredToLiveRatio: 2 } });
    await db.init();
    await runMigrations(db, DATABASE_MIGRATIONS);
    await db.checkpoint();
  });

  afterEach(async () => {
    await db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("a READ_ONLY session reports compaction as unsupported and leaves the file alone", async () => {
    await db.close();
    const reader = new DuckDbGraphClient({ path, accessMode: "READ_ONLY" });
    await reader.init();
    try {
      expect(await reader.compactStorage()).toEqual({ kind: "skipped", reason: "unsupported" });
    } finally {
      await reader.close();
    }
    db = new DuckDbGraphClient({ path });
    await db.init();
  });

  it("a snapshot whose target path is an occupied directory fails at publish and leaves no staging file", async () => {
    await db.run("INSERT INTO cg_symbols_files (rel_path, language) VALUES ('src/a.ts', 'typescript')");
    const target = join(dir, "snap.duckdb");
    mkdirSync(join(target, "occupant"), { recursive: true });

    const err = await db.exportSnapshot(target).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(CodegraphSnapshotExportFailedError);
    expect((err as CodegraphSnapshotExportFailedError).stage).toBe("publish");
    expect(existsSync(snapshotStagingPath(target))).toBe(false);
    const [r] = await db.queryAll<{ n: number | bigint }>("SELECT count(*) AS n FROM cg_symbols_files");
    expect(Number(r.n)).toBe(1);
  });

  it("a snapshot whose target directory cannot be created fails at copy with the typed error", async () => {
    const blocker = join(dir, "blocker");
    writeFileSync(blocker, "not a directory");

    const err = await db.exportSnapshot(join(blocker, "nested", "snap.duckdb")).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(CodegraphSnapshotExportFailedError);
    expect((err as CodegraphSnapshotExportFailedError).stage).toBe("copy");
  });

  describe("recreateEmptyTable", () => {
    let session: DuckDbGraphSession;

    beforeEach(async () => {
      session = new DuckDbGraphSession({ path: join(dir, "session.duckdb") });
      await session.open();
    });

    afterEach(async () => {
      await session.close();
    });

    it("refuses a name that is not a plain identifier", async () => {
      await expect(session.recreateEmptyTable("cg_symbols; DROP TABLE cg_symbols")).rejects.toThrow(
        /not a plain table/,
      );
    });

    it("refuses a table the catalog does not hold", async () => {
      await expect(session.recreateEmptyTable("no_such_table")).rejects.toThrow(/no table no_such_table/);
    });

    it("empties the table and keeps its secondary indexes", async () => {
      await session.exec("CREATE TABLE scratch_rows (k VARCHAR, v VARCHAR)");
      await session.exec("CREATE INDEX scratch_rows_k ON scratch_rows (k)");
      await session.run("INSERT INTO scratch_rows VALUES ('a', 'b')");

      await session.recreateEmptyTable("scratch_rows");

      const [rows] = await session.queryAll<{ n: number | bigint }>("SELECT count(*) AS n FROM scratch_rows");
      expect(Number(rows.n)).toBe(0);
      const indexes = await session.queryAll<{ n: string }>(
        "SELECT index_name AS n FROM duckdb_indexes() WHERE table_name = 'scratch_rows'",
      );
      expect(indexes.map((i) => i.n)).toEqual(["scratch_rows_k"]);
    });
  });

  it("a stream and a read issued while a compaction swaps wait for the new file and drain it", async () => {
    for (let run = 0; run < 4; run++) {
      for (let f = 0; f < 30; f++) {
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
    await db.run("INSERT INTO cg_symbols_edges_file (source_rel_path, target_rel_path) VALUES ('a.ts', 'b.ts')");

    const compacting = db.compactStorage();
    const edges: unknown[] = [];
    const draining = (async () => {
      // Land inside the swap window, after the footprint read and before the copy ends.
      await new Promise((resolve) => setTimeout(resolve, 15));
      for await (const edge of db.streamAdjacency("file")) edges.push(edge);
    })();
    const reading = db.queryAll<{ n: number | bigint }>("SELECT count(*) AS n FROM cg_symbols");

    const [outcome, , rows] = await Promise.all([compacting, draining, reading]);

    // Which side of the swap the stream lands on is a race: it either waits out the
    // swap, or opens first and makes the compaction stand down. Either way nothing is lost.
    expect(["compacted", "skipped"]).toContain(outcome.kind);
    expect(Number(rows[0].n)).toBe(120);
    expect(edges).toHaveLength(1);
  });
});

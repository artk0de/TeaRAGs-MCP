/**
 * The per-review file-edge store (bd tea-rags-mcp-89k7k.1.2, F1 slice B): one
 * throwaway `cg_review_file_edges_<reviewId>` table per review, the put/drop
 * envelopes, and the age sweep that guarantees a crashed process's tables die
 * on the next review anywhere.
 *
 * Invariants under test:
 *   - put → read round-trips the edges ordered by (source, target);
 *   - a second put to the SAME reviewId APPENDS (reviews write once, so this
 *     only matters for a retry);
 *   - an empty put still creates the table — "review with no edges" stays
 *     distinguishable from "review never written";
 *   - drop removes the TABLE (information_schema absence), and read after
 *     drop answers [] instead of throwing;
 *   - sweep drops exactly the expired tables plus every malformed-named one,
 *     and returns the dropped names.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { fixturePhysicalCollectionName } from "../../__helpers__/collection-identity.js";
import { DuckDbGraphClient } from "../../../../src/core/adapters/duckdb/client.js";
import { DAEMON_OP_COMMANDS } from "../../../../src/core/adapters/duckdb/daemon/op-commands.js";
import { CodegraphDaemonServer } from "../../../../src/core/adapters/duckdb/daemon/server.js";
import { GraphDbClientPool } from "../../../../src/core/adapters/duckdb/pool.js";
import type { ReviewFileEdge } from "../../../../src/core/contracts/types/codegraph.js";
import { createDatabaseMigrationApplier } from "../../../../src/core/domains/maintenance/migration/database/index.js";
import { DATABASE_MIGRATIONS } from "../../../../src/core/domains/maintenance/migration/database/migrations/index.js";
import { runMigrations } from "../../../../src/core/domains/maintenance/migration/database/runner.js";
import { InMemoryGlobalSymbolTable } from "../../../../src/core/domains/trajectory/codegraph/symbols/symbol-table.js";

const REVIEW_ID = "1700000000-4242-a1b2c3";
const TABLE = `cg_review_file_edges_${REVIEW_ID}`;

function edge(sourceRelPath: string, targetRelPath: string): ReviewFileEdge {
  return { sourceRelPath, targetRelPath };
}

/** Row count of one table straight from the catalog — absent counts as 0. */
async function catalogRows(db: DuckDbGraphClient, table: string): Promise<number> {
  const rows = await db.queryAll<{ n: number }>(
    "SELECT count(*) AS n FROM information_schema.tables WHERE table_schema = 'main' AND table_name = ?",
    [table],
  );
  return Number(rows[0]?.n ?? 0);
}

describe("DuckDbGraphClient — per-review file-edge store (bd tea-rags-mcp-89k7k.1.2)", () => {
  let dir: string;
  let db: DuckDbGraphClient;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "cg-review-edges-"));
    db = new DuckDbGraphClient({ path: join(dir, "g.duckdb") });
    await db.init();
    await runMigrations(db, DATABASE_MIGRATIONS);
  });

  afterEach(async () => {
    await db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("round-trips put → read ordered by (source, target), and a second put to the same review appends", async () => {
    await db.putReviewFileEdges(REVIEW_ID, [edge("src/b.ts", "src/d.ts"), edge("src/a.ts", "src/c.ts")]);
    await db.putReviewFileEdges(REVIEW_ID, [edge("src/a.ts", "src/b.ts")]);

    expect(await db.readReviewFileEdges(REVIEW_ID)).toEqual([
      edge("src/a.ts", "src/b.ts"),
      edge("src/a.ts", "src/c.ts"),
      edge("src/b.ts", "src/d.ts"),
    ]);
  });

  it("an empty put still creates the table; drop removes the table itself and read answers []", async () => {
    await db.putReviewFileEdges(REVIEW_ID, []);
    expect(await catalogRows(db, TABLE)).toBe(1);
    expect(await db.readReviewFileEdges(REVIEW_ID)).toEqual([]);

    await db.dropReviewFileEdges(REVIEW_ID);
    expect(await catalogRows(db, TABLE)).toBe(0);
    expect(await db.readReviewFileEdges(REVIEW_ID)).toEqual([]);
  });

  it("sweeps only the expired tables plus malformed-named ones, and returns the dropped names", async () => {
    const freshId = "1700007200-4242-c3b2a1";
    await db.putReviewFileEdges(REVIEW_ID, [edge("a.ts", "b.ts")]);
    await db.putReviewFileEdges(freshId, [edge("c.ts", "d.ts")]);
    // Garbage in the catalog: created by hand, never by the store — the sweep
    // is what guarantees it cannot linger.
    await db.run("CREATE TABLE cg_review_file_edges_garbage (x INTEGER)");

    const dropped = await db.sweepExpiredReviewFileEdges(1700000000 + 3600, 3600);

    expect(dropped.sort()).toEqual(["cg_review_file_edges_1700000000-4242-a1b2c3", "cg_review_file_edges_garbage"]);
    expect(await catalogRows(db, TABLE)).toBe(0);
    expect(await catalogRows(db, `cg_review_file_edges_garbage`)).toBe(0);
    expect(await catalogRows(db, `cg_review_file_edges_${freshId}`)).toBe(1);
  });
});

/** `(size, mtimeMs, sha256)` of a file, or "none" — what the tree graph's base version reads, plus the bytes. */
function fileState(path: string): string {
  if (!existsSync(path)) return "none";
  const stat = statSync(path);
  return `${String(stat.size)}@${String(stat.mtimeMs)}#${createHash("sha256").update(readFileSync(path)).digest("hex")}`;
}

function databaseState(dbPath: string): string[] {
  return [fileState(dbPath), fileState(`${dbPath}.wal`)];
}

/** One full review lifecycle: sweep-on-create, put, read, finally-drop. */
async function runReview(
  db: Pick<
    DuckDbGraphClient,
    "sweepExpiredReviewFileEdges" | "putReviewFileEdges" | "readReviewFileEdges" | "dropReviewFileEdges"
  >,
  reviewId: string,
): Promise<ReviewFileEdge[]> {
  await db.sweepExpiredReviewFileEdges(Number(reviewId.slice(0, 10)), 3600);
  await db.putReviewFileEdges(reviewId, [edge("src/a.ts", "src/b.ts")]);
  const read = await db.readReviewFileEdges(reviewId);
  await db.dropReviewFileEdges(reviewId);
  return read;
}

describe("review scratch tables never touch the database file (bd tea-rags-mcp-xi2r9 D4)", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "cg-review-scratch-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("a review over a read-write session leaves the .duckdb and its .wal byte- and mtime-identical", async () => {
    const path = join(dir, "g.duckdb");
    const db = new DuckDbGraphClient({ path });
    await db.init();
    try {
      await runMigrations(db, DATABASE_MIGRATIONS);
      await db.checkpoint();
      const before = databaseState(path);
      // mtime resolution: a write inside the same millisecond would hide.
      await new Promise((resolve) => setTimeout(resolve, 20));

      expect(await runReview(db, REVIEW_ID)).toEqual([edge("src/a.ts", "src/b.ts")]);

      expect(databaseState(path)).toEqual(before);
    } finally {
      await db.close();
    }
  });

  it("a review works over a READ_ONLY session — the scratch table lives outside the database", async () => {
    const path = join(dir, "g.duckdb");
    const writer = new DuckDbGraphClient({ path });
    await writer.init();
    await runMigrations(writer, DATABASE_MIGRATIONS);
    await writer.checkpoint();
    await writer.close();
    const before = databaseState(path);

    const reader = new DuckDbGraphClient({ path, accessMode: "READ_ONLY" });
    await reader.init();
    try {
      expect(await runReview(reader, REVIEW_ID)).toEqual([edge("src/a.ts", "src/b.ts")]);
    } finally {
      await reader.close();
    }
    expect(databaseState(path)).toEqual(before);
  });

  it("the sweep still drops a legacy persistent review table left by an older build", async () => {
    const path = join(dir, "g.duckdb");
    const db = new DuckDbGraphClient({ path });
    await db.init();
    try {
      await runMigrations(db, DATABASE_MIGRATIONS);
      await db.run(`CREATE TABLE "${TABLE}" (source_rel_path VARCHAR, target_rel_path VARCHAR)`);

      expect(await db.sweepExpiredReviewFileEdges(1700000000 + 3600, 3600)).toEqual([TABLE]);
      expect(await catalogRows(db, TABLE)).toBe(0);
    } finally {
      await db.close();
    }
  });

  it("concurrent reviews through the daemon's shared connection stay isolated and leave the file untouched", async () => {
    const pool = new GraphDbClientPool({
      rootDir: dir,
      symbolTableFactory: () => new InMemoryGlobalSymbolTable(),
      applyMigrations: createDatabaseMigrationApplier(),
    });
    const server = new CodegraphDaemonServer(pool);
    const c = "code_review_scratch_v1";
    const ids = ["1700000000-4242-aaaaaa", "1700000000-4243-bbbbbb", "1700000000-4244-cccccc"];
    try {
      // Open + migrate the collection, then settle it on disk.
      await server.handle({ id: 0, op: "checkpoint", params: { collection: c } });
      const path = pool.pathFor(fixturePhysicalCollectionName(c));
      const before = databaseState(path);
      await new Promise((resolve) => setTimeout(resolve, 20));

      let nextId = 1;
      const call = async (op: string, params: Record<string, unknown>): Promise<unknown> => {
        const response = await server.handle({
          id: nextId++,
          op: op as never,
          params: { collection: c, ...params },
        });
        expect(response.ok).toBe(true);
        return (response as { result?: unknown }).result;
      };
      const reads = await Promise.all(
        ids.map(async (reviewId, i) => {
          await call("sweepExpiredReviewFileEdges", { nowEpochSeconds: 1700000000, maxAgeSeconds: 3600 });
          await call("putReviewFileEdges", { reviewId, edges: [edge(`src/${String(i)}.ts`, "src/t.ts")] });
          const read = await call("readReviewFileEdges", { reviewId });
          await call("dropReviewFileEdges", { reviewId });
          return read;
        }),
      );

      expect(reads).toEqual(ids.map((_, i) => [edge(`src/${String(i)}.ts`, "src/t.ts")]));
      expect(databaseState(path)).toEqual(before);
    } finally {
      await pool.closeAll();
    }
  });
});

describe("review-edge ops through the daemon (bd tea-rags-mcp-89k7k.1.2)", () => {
  let root: string | undefined;
  afterEach(() => {
    if (root) rmSync(root, { recursive: true, force: true });
    root = undefined;
  });

  it("put writes and read answers through the server's pooled collection", async () => {
    root = mkdtempSync(join(tmpdir(), "cg-daemon-review-edges-"));
    const pool = new GraphDbClientPool({
      rootDir: root,
      symbolTableFactory: () => new InMemoryGlobalSymbolTable(),
      applyMigrations: createDatabaseMigrationApplier(),
    });
    const server = new CodegraphDaemonServer(pool);
    const c = "code_review_edges_v1";
    try {
      expect(DAEMON_OP_COMMANDS.putReviewFileEdges.access).toBe("write");
      expect(DAEMON_OP_COMMANDS.dropReviewFileEdges.access).toBe("write");
      expect(DAEMON_OP_COMMANDS.sweepExpiredReviewFileEdges.access).toBe("write");
      expect(DAEMON_OP_COMMANDS.readReviewFileEdges.access).toBe("read");

      const put = await server.handle({
        id: 1,
        op: "putReviewFileEdges",
        params: { collection: c, reviewId: REVIEW_ID, edges: [edge("src/a.ts", "src/b.ts")] },
      });
      const read = await server.handle({
        id: 2,
        op: "readReviewFileEdges",
        params: { collection: c, reviewId: REVIEW_ID },
      });
      const sweep = await server.handle({
        id: 3,
        op: "sweepExpiredReviewFileEdges",
        params: { collection: c, nowEpochSeconds: 1700000000 + 3600, maxAgeSeconds: 3600 },
      });

      expect(put.ok).toBe(true);
      expect((read as { result: unknown }).result).toEqual([edge("src/a.ts", "src/b.ts")]);
      // Age is read off the id's EMBEDDED epoch, not the wall clock: an id
      // minted 3600s before `now` is expired exactly here, daemon or not.
      expect((sweep as { result: unknown }).result).toEqual([TABLE]);
      const after = await server.handle({
        id: 4,
        op: "readReviewFileEdges",
        params: { collection: c, reviewId: REVIEW_ID },
      });
      expect((after as { result: unknown }).result).toEqual([]);
    } finally {
      await pool.closeAll();
    }
  });
});

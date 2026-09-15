/**
 * A cached codegraph client is valid only while its path still names the
 * database file it opened (bd tea-rags-mcp-amh78).
 *
 * Every holder of a `GraphDbClientPool` — the daemon above all — caches one
 * read-write client per collection. Another process can unlink that file (clear,
 * purge, the orphan sweep) or put a different database at the same path (a
 * reindex reclaiming the name, a footprint clone). DuckDB keeps writing through
 * the old inode and addresses its WAL by path, so the cached client kept
 * answering while the rebuilt graph went into a deleted file, and the graph
 * was gone once the process exited. These tests pin the replacement: a stale
 * client is closed first, without a checkpoint that could delete the WAL now at
 * its path, and only then is the file opened again.
 */

import { copyFileSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { fixturePhysicalCollectionName } from "../../__helpers__/collection-identity.js";
import { DuckDbGraphClient } from "../../../../src/core/adapters/duckdb/client.js";
import { CodegraphDbFiles } from "../../../../src/core/adapters/duckdb/codegraph-db-files.js";
import { GraphDbClientPool, type GraphDbClientPoolOptions } from "../../../../src/core/adapters/duckdb/pool.js";
import type { GraphDbClient } from "../../../../src/core/contracts/types/codegraph.js";
import { createDatabaseMigrationApplier } from "../../../../src/core/domains/maintenance/migration/database/index.js";
import { InMemoryGlobalSymbolTable } from "../../../../src/core/domains/trajectory/codegraph/symbols/symbol-table.js";

const NAME = fixturePhysicalCollectionName("code_amh78_v1");

let tmp: string;
const pools: GraphDbClientPool[] = [];

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "pool-stale-file-"));
});

afterEach(async () => {
  vi.restoreAllMocks();
  for (const pool of pools.splice(0)) await pool.closeAll();
  rmSync(tmp, { recursive: true, force: true });
});

function makePool(extra: Partial<GraphDbClientPoolOptions> = {}): GraphDbClientPool {
  const pool = new GraphDbClientPool({
    rootDir: tmp,
    symbolTableFactory: () => new InMemoryGlobalSymbolTable(),
    applyMigrations: createDatabaseMigrationApplier(),
    ...extra,
  });
  pools.push(pool);
  return pool;
}

async function writeMarker(graphDb: GraphDbClient, relPath: string): Promise<void> {
  await graphDb.upsertFile({ relPath, language: "typescript" }, { fileEdges: [], methodEdges: [] });
}

async function relPaths(graphDb: GraphDbClient): Promise<string[]> {
  const rows = await (graphDb as DuckDbGraphClient).queryAll<{ rel_path: string }>(
    "SELECT rel_path FROM cg_symbols_files ORDER BY rel_path",
  );
  return rows.map((row) => row.rel_path);
}

/** What the next process sees: a pool of its own over the same data directory. */
async function relPathsOnDisk(): Promise<string[]> {
  const { graphDb } = await makePool().acquire(NAME);
  return relPaths(graphDb);
}

/** Record the moment the driver opens a database, and whether a WAL sat at `walPath` then. */
function recordDriverOpens(onOpen: () => void): void {
  const realInit = DuckDbGraphClient.prototype.init;
  vi.spyOn(DuckDbGraphClient.prototype, "init").mockImplementation(async function (this: DuckDbGraphClient) {
    onOpen();
    return realInit.call(this);
  });
}

describe("GraphDbClientPool — a cached client whose database file is gone (amh78)", () => {
  it("replaces it, so a write after another holder unlinked the file lands in a real database file", async () => {
    const pool = makePool();
    const first = await pool.acquire(NAME);
    await writeMarker(first.graphDb, "before.ts");

    await new CodegraphDbFiles(tmp).removeFiles(NAME);

    const second = await pool.acquire(NAME);
    await writeMarker(second.graphDb, "after.ts");
    expect(second.graphDb).not.toBe(first.graphDb);

    await pool.closeAll();
    expect(existsSync(pool.pathFor(NAME))).toBe(true);
    expect(await relPathsOnDisk()).toEqual(["after.ts"]);
  });

  it("replaces it when the path now holds a different database, and closing it leaves that database's WAL intact", async () => {
    const pool = makePool();
    const ghost = await pool.acquire(NAME);
    await writeMarker(ghost.graphDb, "ghost.ts");

    // A daemon-held source whose latest write lives only in its WAL.
    const sourceName = fixturePhysicalCollectionName("code_amh78_source_v1");
    const source = new DuckDbGraphClient({ path: pool.pathFor(sourceName) });
    await source.init();
    await createDatabaseMigrationApplier()(source);
    await source.checkpoint();
    await writeMarker(source, "cloned.ts");
    expect(existsSync(`${pool.pathFor(sourceName)}.wal`)).toBe(true);

    // Purge the name, then provision it again as a clone of the source.
    const files = new CodegraphDbFiles(tmp);
    await files.removeFiles(NAME);
    await files.cloneDatabase(sourceName, NAME);
    await source.close();

    const fresh = await pool.acquire(NAME);
    expect(fresh.graphDb).not.toBe(ghost.graphDb);
    expect(await relPaths(fresh.graphDb)).toEqual(["cloned.ts"]);
  });

  it("closes the stale client before the replacement database is opened", async () => {
    const pool = makePool();
    const first = await pool.acquire(NAME);
    await new CodegraphDbFiles(tmp).removeFiles(NAME);

    const order: string[] = [];
    const realClose = first.graphDb.close.bind(first.graphDb);
    vi.spyOn(first.graphDb, "close").mockImplementation(async () => {
      order.push("close:start");
      await realClose();
      order.push("close:end");
    });
    recordDriverOpens(() => order.push("open"));

    await pool.acquire(NAME);

    expect(order).toEqual(["close:start", "close:end", "open"]);
  });

  it("still replaces a stale client whose close fails", async () => {
    const pool = makePool();
    const first = await pool.acquire(NAME);
    await new CodegraphDbFiles(tmp).removeFiles(NAME);
    const closeSpy = vi
      .spyOn(first.graphDb, "close")
      .mockRejectedValueOnce(new Error("close failed on an unlinked file"));

    const second = await pool.acquire(NAME);

    expect(closeSpy).toHaveBeenCalledTimes(1);
    expect(second.graphDb).not.toBe(first.graphDb);
    expect(pool.peek(NAME)).toBe(second);
    closeSpy.mockRestore();
    await first.graphDb.close();
  });

  it("shares one replacement between concurrent acquires that find the client stale", async () => {
    const pool = makePool();
    const first = await pool.acquire(NAME);
    await new CodegraphDbFiles(tmp).removeFiles(NAME);
    let opens = 0;
    recordDriverOpens(() => {
      opens += 1;
    });

    const [a, b] = await Promise.all([pool.acquire(NAME), pool.acquire(NAME)]);

    expect(a.graphDb).not.toBe(first.graphDb);
    expect(b).toBe(a);
    expect(opens).toBe(1);
  });

  it("peek reports no handle once the file is gone, without closing the client — the next acquire replaces it", async () => {
    const pool = makePool();
    const first = await pool.acquire(NAME);
    await writeMarker(first.graphDb, "before.ts");
    expect(pool.peek(NAME)).toBe(first);

    await new CodegraphDbFiles(tmp).removeFiles(NAME);

    expect(pool.peek(NAME)).toBeUndefined();
    // peek cannot await a close, so it must not have started one.
    expect(await relPaths(first.graphDb)).toEqual(["before.ts"]);

    const second = await pool.acquire(NAME);
    expect(second.graphDb).not.toBe(first.graphDb);
    expect(pool.peek(NAME)).toBe(second);
  });

  it("discards a WAL left without its database file before the driver opens the collection, never replaying it", async () => {
    const pool = makePool();
    const walPath = `${pool.pathFor(NAME)}.wal`;

    // A WAL with real content, then left beside no database — what a client
    // writing into an unlinked file leaves behind when its process exits.
    const donorPath = join(tmp, "donor.duckdb");
    const donor = new DuckDbGraphClient({ path: donorPath });
    await donor.init();
    await createDatabaseMigrationApplier()(donor);
    await donor.checkpoint();
    await writeMarker(donor, "ghost.ts");
    copyFileSync(`${donorPath}.wal`, walPath);
    await donor.close();
    expect(existsSync(pool.pathFor(NAME))).toBe(false);

    const walPresentAtOpen: boolean[] = [];
    recordDriverOpens(() => walPresentAtOpen.push(existsSync(walPath)));

    const handle = await pool.acquire(NAME);

    expect(walPresentAtOpen).toEqual([false]);
    expect(await relPaths(handle.graphDb)).toEqual([]);
  });

  it("announces every client it closes — stale replacement, release, removeCollection, closeAll", async () => {
    const closed: string[] = [];
    const pool = makePool({
      onCollectionClientClosed: (collectionName) => {
        closed.push(collectionName);
      },
    });
    const other = fixturePhysicalCollectionName("code_amh78_other_v1");

    await pool.acquire(NAME);
    await new CodegraphDbFiles(tmp).removeFiles(NAME);
    await pool.acquire(NAME);
    expect(closed).toEqual([NAME]);

    await pool.release(NAME);
    await pool.acquire(other);
    await pool.removeCollection(other);
    await pool.acquire(NAME);
    await pool.closeAll();

    expect(closed).toEqual([NAME, NAME, other, NAME]);
  });
});

/**
 * Path lease: an in-process replacer of a codegraph database path drains the
 * ops already running on that path's client before it touches the file (bd
 * tea-rags-mcp-r4veq).
 *
 * The amh78 fix retires a cached client whose file is gone or replaced, but only
 * on the NEXT acquire. An op that acquired the client before the replacement
 * kept running on it, and DuckDB addresses the WAL by path: its writes landed in
 * the successor's WAL and replayed into the new database (measured by the amh78
 * probe as a ghost row in a clone). These tests pin the fence: `removeCollection`
 * and `cloneDatabase` wait for every op pinned to the old client, then close it,
 * and only then unlink / publish; an op issued meanwhile waits for the lease and
 * runs on the successor.
 */

import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { fixturePhysicalCollectionName } from "../../__helpers__/collection-identity.js";
import type { DuckDbGraphClient } from "../../../../src/core/adapters/duckdb/client.js";
import { GraphDbClientPool } from "../../../../src/core/adapters/duckdb/pool.js";
import type { GraphDbClient } from "../../../../src/core/contracts/types/codegraph.js";
import { createDatabaseMigrationApplier } from "../../../../src/core/domains/maintenance/migration/database/index.js";
import { InMemoryGlobalSymbolTable } from "../../../../src/core/domains/trajectory/codegraph/symbols/symbol-table.js";

const TARGET = fixturePhysicalCollectionName("code_r4veq_target_v1");
const SOURCE = fixturePhysicalCollectionName("code_r4veq_source_v1");
const OTHER = fixturePhysicalCollectionName("code_r4veq_other_v1");

let tmp: string;
const pools: GraphDbClientPool[] = [];

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "pool-path-lease-"));
});

afterEach(async () => {
  for (const pool of pools.splice(0)) await pool.closeAll();
  rmSync(tmp, { recursive: true, force: true });
});

function makePool(): GraphDbClientPool {
  const pool = new GraphDbClientPool({
    rootDir: tmp,
    symbolTableFactory: () => new InMemoryGlobalSymbolTable(),
    applyMigrations: createDatabaseMigrationApplier(),
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
async function relPathsOnDisk(name: typeof TARGET): Promise<string[]> {
  const { graphDb } = await makePool().acquire(name);
  return relPaths(graphDb);
}

/** Let every pending microtask and a few macrotasks run. */
async function settle(): Promise<void> {
  for (let i = 0; i < 20; i++) await new Promise<void>((resolve) => setImmediate(resolve));
}

interface ParkedOp {
  /** Resolves once the op made its first write and parked. */
  parked: Promise<void>;
  /** Let the op make its second write and finish. */
  resume: () => void;
  /** The op's own settlement. */
  done: Promise<void>;
}

/** An op that writes, parks mid-op holding the client, then writes again. */
function parkOp(pool: GraphDbClientPool, name: typeof TARGET, events: string[]): ParkedOp {
  let markParked!: () => void;
  const parked = new Promise<void>((resolve) => (markParked = resolve));
  let resume!: () => void;
  const gate = new Promise<void>((resolve) => (resume = resolve));
  const done = pool.runCollectionOp(name, async ({ graphDb }) => {
    await writeMarker(graphDb, "before-park.ts");
    markParked();
    await gate;
    await writeMarker(graphDb, "ghost.ts");
    events.push("op:done");
  });
  return { parked, resume, done };
}

describe("GraphDbClientPool — path lease drains in-flight ops before a replacer touches the file (r4veq)", () => {
  it("removeCollection awaits the op running on the client, then unlinks", async () => {
    const pool = makePool();
    const events: string[] = [];
    const op = parkOp(pool, TARGET, events);
    await op.parked;

    const removal = pool.removeCollection(TARGET).then((evicted) => {
      events.push("remove:done");
      return evicted;
    });
    await settle();

    // The op still holds the client: the replacer waits, the file is untouched.
    expect(events).toEqual([]);
    expect(existsSync(pool.pathFor(TARGET))).toBe(true);

    op.resume();
    await expect(op.done).resolves.toBeUndefined();
    await expect(removal).resolves.toBe(true);

    expect(events).toEqual(["op:done", "remove:done"]);
    expect(existsSync(pool.pathFor(TARGET))).toBe(false);
    expect(existsSync(`${pool.pathFor(TARGET)}.wal`)).toBe(false);
  });

  it("an op in flight on the target while a clone replaces it never writes into the successor (amh78 ghost-row probe)", async () => {
    const pool = makePool();
    const seed = await pool.acquire(SOURCE);
    await writeMarker(seed.graphDb, "cloned.ts");

    const events: string[] = [];
    const op = parkOp(pool, TARGET, events);
    await op.parked;

    const clone = pool.cloneDatabase(SOURCE, TARGET).then(() => events.push("clone:done"));
    await settle();
    expect(events).toEqual([]);

    op.resume();
    await op.done;
    await clone;
    expect(events).toEqual(["op:done", "clone:done"]);

    // The successor holds the source's rows and nothing the ghost wrote.
    const successor = await pool.acquire(TARGET);
    expect(await relPaths(successor.graphDb)).toEqual(["cloned.ts"]);
    await pool.closeAll();
    expect(await relPathsOnDisk(TARGET)).toEqual(["cloned.ts"]);
  });

  it("an op issued while a replacer holds the path waits for it and runs on the successor", async () => {
    const pool = makePool();
    const events: string[] = [];
    const parked = parkOp(pool, TARGET, events);
    await parked.parked;

    const removal = pool.removeCollection(TARGET).then(() => events.push("remove:done"));
    await settle();

    const late = pool.runCollectionOp(TARGET, async ({ graphDb }) => {
      events.push("late:start");
      await writeMarker(graphDb, "late.ts");
      return relPaths(graphDb);
    });
    await settle();
    expect(events).toEqual([]);

    parked.resume();
    await removal;
    expect(await late).toEqual(["late.ts"]);
    expect(events).toEqual(["op:done", "remove:done", "late:start"]);
  });

  it("a replacer draining one collection does not hold up ops on another", async () => {
    const pool = makePool();
    const events: string[] = [];
    const parked = parkOp(pool, TARGET, events);
    await parked.parked;
    const removal = pool.removeCollection(TARGET);
    await settle();

    const other = await pool.runCollectionOp(OTHER, async ({ graphDb }) => {
      await writeMarker(graphDb, "other.ts");
      return relPaths(graphDb);
    });
    expect(other).toEqual(["other.ts"]);

    parked.resume();
    await parked.done;
    await removal;
  });

  it("serialises two replacers of one path — the second starts after the first finished", async () => {
    const pool = makePool();
    await pool.runCollectionOp(TARGET, async ({ graphDb }) => writeMarker(graphDb, "a.ts"));
    const seed = await pool.acquire(SOURCE);
    await writeMarker(seed.graphDb, "cloned.ts");

    await Promise.all([pool.removeCollection(TARGET), pool.cloneDatabase(SOURCE, TARGET)]);

    expect(await pool.runCollectionOp(TARGET, async ({ graphDb }) => relPaths(graphDb))).toEqual(["cloned.ts"]);
  });

  it("does not unlink when closing the drained client fails, and releases the path for the next op", async () => {
    const pool = makePool();
    const { graphDb } = await pool.acquire(TARGET);
    const realClose = graphDb.close.bind(graphDb);
    let failed = false;
    (graphDb as { close: () => Promise<void> }).close = async () => {
      if (!failed) {
        failed = true;
        throw new Error("close failed");
      }
      await realClose();
    };

    await expect(pool.removeCollection(TARGET)).rejects.toThrow(/close/i);
    expect(existsSync(pool.pathFor(TARGET))).toBe(true);
    await realClose();

    // The lease is released even though the replacer failed.
    expect(await pool.runCollectionOp(TARGET, async ({ graphDb: fresh }) => relPaths(fresh))).toEqual([]);
  });
});

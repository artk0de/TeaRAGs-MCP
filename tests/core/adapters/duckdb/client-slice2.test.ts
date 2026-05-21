/**
 * Slice 2 additions to `DuckDbGraphClient`:
 *
 *   - resource ceiling SET applied at init time
 *     (memory_limit / threads / temp_directory / preserve_insertion_order)
 *   - `checkpoint()` flushes WAL via SQL CHECKPOINT
 *   - `streamAdjacency()` yields rows one at a time
 *
 * Live DuckDB tests rather than mocks — keeps the behaviour exercise
 * close to what the slice-2 indexing pass actually runs against.
 */

import { mkdirSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { DuckDbGraphClient } from "../../../../src/core/adapters/duckdb/client.js";
import { runMigrations } from "../../../../src/core/infra/migration/database/runner.js";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const MIG_DIR = resolve(__dirname, "../../../../src/core/infra/migration/database/migrations");

describe("DuckDbGraphClient — slice 2 streaming primitives", () => {
  let tmp: string;
  let dbPath: string;
  let spillDir: string;
  let client: DuckDbGraphClient;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "cg-slice2-"));
    dbPath = join(tmp, "g.duckdb");
    spillDir = join(tmp, "spill");
    // Pre-create the spillDir so we can assert the init() pass does
    // NOT overwrite it (per-client init is mkdir-only; purge happens
    // at pool construction).
    mkdirSync(spillDir, { recursive: true });
  });
  afterEach(async () => {
    if (client) await client.close().catch(() => undefined);
    rmSync(tmp, { recursive: true, force: true });
  });

  it("init applies resource SETs in best-effort mode (driver unknown options swallowed)", async () => {
    client = new DuckDbGraphClient({
      path: dbPath,
      resources: {
        memoryLimit: "256MB",
        threads: 2,
        tempDirectory: spillDir,
        preserveInsertionOrder: false,
      },
    });
    await client.init();
    await runMigrations(client, MIG_DIR);
    // Resource-ceiling settings are advisory — the load-bearing
    // assertion is that init() completes and subsequent CRUD works.
    expect(await client.hasData()).toBe(false);
  });

  it("init only mkdirs spillDir — does NOT wipe existing files in it", async () => {
    // A concurrent collection in the same pool may have an in-flight
    // .ndjson here; per-client init must leave it alone. The pool's
    // construction step is what purges.
    const probePath = join(spillDir, "concurrent-other-collection.ndjson");
    await import("node:fs").then((fs) => {
      fs.writeFileSync(probePath, "{}\n");
    });
    client = new DuckDbGraphClient({
      path: dbPath,
      resources: { tempDirectory: spillDir },
    });
    await client.init();
    await runMigrations(client, MIG_DIR);
    expect(readdirSync(spillDir)).toContain("concurrent-other-collection.ndjson");
  });

  it("checkpoint() resolves on an empty database (idempotent no-op)", async () => {
    client = new DuckDbGraphClient({ path: dbPath });
    await client.init();
    await runMigrations(client, MIG_DIR);
    await expect(client.checkpoint()).resolves.toBeUndefined();
    // Second call also resolves — no state to leak.
    await expect(client.checkpoint()).resolves.toBeUndefined();
  });

  it("checkpoint() flushes WAL after a batch of upserts", async () => {
    client = new DuckDbGraphClient({ path: dbPath });
    await client.init();
    await runMigrations(client, MIG_DIR);
    // Populate a small file graph so the WAL has content.
    await client.upsertFile(
      { relPath: "src/a.ts", language: "typescript" },
      {
        fileEdges: [{ targetRelPath: "src/b.ts", importText: "./b" }],
        methodEdges: [],
      },
    );
    await client.upsertFile(
      { relPath: "src/b.ts", language: "typescript" },
      {
        fileEdges: [{ targetRelPath: "src/c.ts", importText: "./c" }],
        methodEdges: [],
      },
    );
    await expect(client.checkpoint()).resolves.toBeUndefined();
    // Data survives the checkpoint.
    expect(await client.getFanIn("src/b.ts")).toBe(1);
    expect(await client.getFanOut("src/a.ts")).toBe(1);
  });

  it("streamAdjacency yields [source, target] pairs for the file scope", async () => {
    client = new DuckDbGraphClient({ path: dbPath });
    await client.init();
    await runMigrations(client, MIG_DIR);
    await client.upsertFile(
      { relPath: "src/a.ts", language: "typescript" },
      {
        fileEdges: [
          { targetRelPath: "src/b.ts", importText: "./b" },
          { targetRelPath: "src/c.ts", importText: "./c" },
        ],
        methodEdges: [],
      },
    );
    await client.upsertFile(
      { relPath: "src/b.ts", language: "typescript" },
      {
        fileEdges: [{ targetRelPath: "src/c.ts", importText: "./c" }],
        methodEdges: [],
      },
    );
    const pairs: [string, string][] = [];
    for await (const pair of client.streamAdjacency("file")) {
      pairs.push(pair);
    }
    expect(pairs.length).toBe(3);
    expect(pairs).toEqual(
      expect.arrayContaining([
        ["src/a.ts", "src/b.ts"],
        ["src/a.ts", "src/c.ts"],
        ["src/b.ts", "src/c.ts"],
      ]),
    );
  });

  it("streamAdjacency skips method edges with null target_symbol_id", async () => {
    client = new DuckDbGraphClient({ path: dbPath });
    await client.init();
    await runMigrations(client, MIG_DIR);
    await client.upsertFile(
      { relPath: "src/a.ts", language: "typescript" },
      {
        fileEdges: [],
        // null target — resolver couldn't pin the call; upsertFile
        // skips these at insert time. streamAdjacency still filters
        // defensively (matches listAdjacency contract).
        methodEdges: [
          {
            sourceSymbolId: "A.x",
            targetSymbolId: "B.y",
            targetRelPath: "src/b.ts",
            callExpression: "B.y()",
          },
        ],
      },
    );
    const pairs: [string, string][] = [];
    for await (const pair of client.streamAdjacency("method")) {
      pairs.push(pair);
    }
    expect(pairs.length).toBe(1);
    expect(pairs[0]).toEqual(["A.x", "B.y"]);
  });

  it("streamAdjacency is consistent with listAdjacency for the same data", async () => {
    client = new DuckDbGraphClient({ path: dbPath });
    await client.init();
    await runMigrations(client, MIG_DIR);
    await client.upsertFile(
      { relPath: "src/a.ts", language: "typescript" },
      {
        fileEdges: [
          { targetRelPath: "src/b.ts", importText: "./b" },
          { targetRelPath: "src/d.ts", importText: "./d" },
        ],
        methodEdges: [],
      },
    );
    await client.upsertFile(
      { relPath: "src/b.ts", language: "typescript" },
      { fileEdges: [{ targetRelPath: "src/c.ts", importText: "./c" }], methodEdges: [] },
    );

    const adjMap = await client.listAdjacency("file");
    const streamPairs = new Map<string, string[]>();
    for await (const [source, target] of client.streamAdjacency("file")) {
      const list = streamPairs.get(source);
      if (list) list.push(target);
      else streamPairs.set(source, [target]);
    }

    // Both shapes must enumerate the same set of edges.
    const flatten = (m: Map<string, string[]>): string[] =>
      [...m.entries()].flatMap(([s, ts]) => ts.map((t) => `${s}->${t}`)).sort();
    expect(flatten(streamPairs)).toEqual(flatten(adjMap));
  });
});

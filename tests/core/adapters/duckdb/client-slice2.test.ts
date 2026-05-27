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

import { DuckDBPreparedStatement } from "@duckdb/node-api";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { DuckDbGraphClient } from "../../../../src/core/adapters/duckdb/client.js";
import { runMigrations } from "../../../../src/core/infra/migration/database/runner.js";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const MIG_DIR = resolve(__dirname, "../../../../src/core/infra/migration/database/migrations");

/** Parse DuckDB's human-readable memory_limit ("1.8 GiB", "256.0 MiB") to bytes. */
function parseDuckDbBytes(s: string): number {
  const m = /^([\d.]+)\s*(B|KiB|MiB|GiB|TiB)$/.exec(s.trim());
  if (!m) throw new Error(`unparseable memory_limit: ${s}`);
  const mult: Record<string, number> = { B: 1, KiB: 1024, MiB: 1024 ** 2, GiB: 1024 ** 3, TiB: 1024 ** 4 };
  return parseFloat(m[1]) * mult[m[2]];
}

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

  it("init caps memory_limit on a write connection even when no resources are configured", async () => {
    // Regression (OOM): an unconfigured write connection used to SKIP
    // `SET memory_limit`, so DuckDB inherited its ~80%-of-system-RAM
    // default (measured 14.3 GiB on an 18 GB host) and could OOM the
    // machine natively during codegraph ingest. A write (READ_WRITE)
    // connection must NEVER be left uncapped — init() applies a built-in
    // conservative default when no memoryLimit is configured.
    client = new DuckDbGraphClient({ path: dbPath }); // no resources at all
    await client.init();
    const [{ m }] = await client.queryAll<{ m: string }>("SELECT current_setting('memory_limit') AS m");
    // Capped well below any machine's ~80%-of-RAM default (>=5 GB hosts).
    expect(parseDuckDbBytes(m)).toBeLessThanOrEqual(2 * 1024 ** 3);
  });

  it("warns loudly when the memory_limit cap silently fails to apply", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    // An invalid memory_limit makes DuckDB reject the SET; execSilent swallows
    // the parse error, leaving the connection at its uncapped ~80%-of-RAM
    // default. init() must DETECT the cap did not take (current_setting
    // unchanged before/after) and warn — that silent failure is exactly what
    // hid the codegraph native OOM.
    client = new DuckDbGraphClient({ path: dbPath, resources: { memoryLimit: "not-a-valid-size" } });
    await client.init();
    expect(errSpy).toHaveBeenCalledWith(expect.stringContaining("memory_limit"));
    errSpy.mockRestore();
  });

  // Native-memory leak guard. Every `run`/`queryAll` prepares a DuckDB
  // statement; @duckdb/node-api statements hold NATIVE resources that V8's GC
  // does not account for, so failing to `destroySync()` them leaks native
  // memory. pass-2 issues millions of per-edge INSERTs via `run` — undisposed
  // statements ballooned the indexer to 32 GB on taxdome. Both primitives MUST
  // dispose the statement they create.
  it("run() disposes its prepared statement (native-leak guard)", async () => {
    client = new DuckDbGraphClient({ path: dbPath });
    await client.init();
    await runMigrations(client, MIG_DIR);
    const destroySpy = vi.spyOn(DuckDBPreparedStatement.prototype, "destroySync");
    await client.run("INSERT OR IGNORE INTO cg_symbols_files (rel_path, language) VALUES (?, ?)", [
      "a.ts",
      "typescript",
    ]);
    expect(destroySpy).toHaveBeenCalledTimes(1);
    destroySpy.mockRestore();
  });

  it("queryAll() disposes its prepared statement (native-leak guard)", async () => {
    client = new DuckDbGraphClient({ path: dbPath });
    await client.init();
    await runMigrations(client, MIG_DIR);
    const destroySpy = vi.spyOn(DuckDBPreparedStatement.prototype, "destroySync");
    await client.queryAll("SELECT 1 AS x");
    expect(destroySpy).toHaveBeenCalledTimes(1);
    destroySpy.mockRestore();
  });

  // streamAdjacency must be a TRUE chunked stream (connection.stream +
  // fetchChunk), not a fake one that materialises the whole edge table via
  // runAndReadAll().getRowObjectsJson(). This guards the chunk-boundary loop:
  // seed > DuckDB's 2048-row vector so the result spans multiple fetched
  // chunks, and assert every row is yielded exactly once (no dropped tail,
  // no infinite loop).
  it("streamAdjacency streams a multi-chunk method graph (>2048 rows) without dropping rows", async () => {
    client = new DuckDbGraphClient({ path: dbPath });
    await client.init();
    await runMigrations(client, MIG_DIR);
    const N = 5000; // spans ~3 DuckDB chunks (2048 rows each)
    await client.exec(
      "INSERT INTO cg_symbols_edges_method (source_symbol_id, source_rel_path, target_symbol_id, target_rel_path, call_expression) " +
        `SELECT 'S' || i, 'a.ts', 'T' || i, 'b.ts', 'c()' FROM range(${N}) AS t(i)`,
    );
    const seen = new Set<string>();
    for await (const [source, target] of client.streamAdjacency("method")) {
      seen.add(`${source}->${target}`);
    }
    expect(seen.size).toBe(N);
    expect(seen.has("S0->T0")).toBe(true);
    expect(seen.has(`S${N - 1}->T${N - 1}`)).toBe(true);
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

  describe("getFanInP95 — collection-wide fan-in percentile (isHub support)", () => {
    it("computes p95 of per-file fanIn over the full file universe including zero-fanIn files", async () => {
      client = new DuckDbGraphClient({ path: dbPath });
      await client.init();
      await runMigrations(client, MIG_DIR);
      // Five files. Edges arranged so the per-file fanIn distribution is
      // [a=0, b=3, c=0, d=0, e=1] → sorted [0,0,0,1,3].
      // PERCENTILE_CONT(0.95) over n=5: idx 0.95*(5-1)=3.8 →
      // interp(sorted[3]=1, sorted[4]=3, 0.8) = 1 + 0.8*(3-1) = 2.6.
      // The zero-fanIn files (a,c,d) MUST be in the distribution — a hub
      // is relative to ALL files, so they come from cg_symbols_files via
      // LEFT JOIN, not only the rows that appear as edge targets.
      await client.upsertFile(
        { relPath: "src/a.ts", language: "typescript" },
        { fileEdges: [{ targetRelPath: "src/b.ts", importText: "./b" }], methodEdges: [] },
      );
      await client.upsertFile(
        { relPath: "src/c.ts", language: "typescript" },
        { fileEdges: [{ targetRelPath: "src/b.ts", importText: "./b" }], methodEdges: [] },
      );
      await client.upsertFile(
        { relPath: "src/d.ts", language: "typescript" },
        {
          fileEdges: [
            { targetRelPath: "src/b.ts", importText: "./b" },
            { targetRelPath: "src/e.ts", importText: "./e" },
          ],
          methodEdges: [],
        },
      );
      // b and e exist as edge targets above, but also register them as
      // file rows so they're in the universe with their own (zero) fanOut.
      await client.upsertFile({ relPath: "src/b.ts", language: "typescript" }, { fileEdges: [], methodEdges: [] });
      await client.upsertFile({ relPath: "src/e.ts", language: "typescript" }, { fileEdges: [], methodEdges: [] });

      // Sanity: per-file fanIn matches the intended distribution.
      expect(await client.getFanIn("src/b.ts")).toBe(3);
      expect(await client.getFanIn("src/e.ts")).toBe(1);
      expect(await client.getFanIn("src/a.ts")).toBe(0);

      expect(await client.getFanInP95()).toBeCloseTo(2.6, 5);
    });

    it("returns 0 on an empty graph (no files) so fanIn > p95 degenerates sanely", async () => {
      client = new DuckDbGraphClient({ path: dbPath });
      await client.init();
      await runMigrations(client, MIG_DIR);
      expect(await client.getFanInP95()).toBe(0);
    });

    it("returns 0 for a single-file repo with no edges", async () => {
      client = new DuckDbGraphClient({ path: dbPath });
      await client.init();
      await runMigrations(client, MIG_DIR);
      await client.upsertFile({ relPath: "src/only.ts", language: "typescript" }, { fileEdges: [], methodEdges: [] });
      expect(await client.getFanInP95()).toBe(0);
    });
  });
});

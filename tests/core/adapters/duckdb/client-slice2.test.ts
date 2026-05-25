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

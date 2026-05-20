import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { DuckDbGraphClient } from "../../../../src/core/adapters/duckdb/client.js";
import { runMigrations } from "../../../../src/core/infra/migration/database/runner.js";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const MIG_DIR = resolve(__dirname, "../../../../src/core/infra/migration/database/migrations");

describe("DuckDbGraphClient", () => {
  let tmp: string;
  let dbPath: string;
  let client: DuckDbGraphClient;
  beforeEach(async () => {
    tmp = mkdtempSync(join(tmpdir(), "cg-db-"));
    dbPath = join(tmp, "g.duckdb");
    client = new DuckDbGraphClient({ path: dbPath });
    await client.init();
    await runMigrations(client, MIG_DIR);
  });
  afterEach(async () => {
    await client.close();
    rmSync(tmp, { recursive: true, force: true });
  });

  it("hasData() returns false on a freshly migrated DB", async () => {
    expect(await client.hasData()).toBe(false);
  });

  it("upsertFile inserts file row and outgoing edges atomically", async () => {
    await client.upsertFile({ relPath: "src/b.ts", language: "typescript" }, { fileEdges: [], methodEdges: [] });
    await client.upsertFile(
      { relPath: "src/a.ts", language: "typescript" },
      {
        fileEdges: [{ targetRelPath: "src/b.ts", importText: "./b" }],
        methodEdges: [],
      },
    );
    expect(await client.getFanOut("src/a.ts")).toBe(1);
    expect(await client.getFanIn("src/b.ts")).toBe(1);
    expect(await client.hasData()).toBe(true);
  });

  // Slice 2 / A4b — incremental modify semantics. When a file is
  // re-extracted (modified between indexes), upsertFile must clear all
  // edges sourced from that file before inserting new ones. Otherwise
  // edges from previous versions accumulate and fanIn/fanOut drift
  // permanently. The DELETE+INSERT pass at the head of upsertFile
  // already enforces this; this test pins it as a regression guard.
  it("upsertFile clears old edges before inserting new ones (incremental modify)", async () => {
    // Initial extraction: src/main.ts has one import + one call edge.
    await client.upsertFile({ relPath: "src/foo.ts", language: "typescript" }, { fileEdges: [], methodEdges: [] });
    await client.upsertFile({ relPath: "src/bar.ts", language: "typescript" }, { fileEdges: [], methodEdges: [] });
    await client.upsertFile(
      { relPath: "src/main.ts", language: "typescript" },
      {
        fileEdges: [{ targetRelPath: "src/foo.ts", importText: "./foo" }],
        methodEdges: [
          {
            sourceSymbolId: "main",
            targetSymbolId: "Foo.bar",
            targetRelPath: "src/foo.ts",
            callExpression: "Foo.bar()",
          },
        ],
      },
    );
    expect(await client.getFanOut("src/main.ts")).toBe(1);
    expect(await client.getCallSiteCount("main")).toBe(1);

    // Re-extract: now imports src/bar.ts instead, calls Bar.baz()
    // instead. Old edges (foo, Foo.bar) must be gone.
    await client.upsertFile(
      { relPath: "src/main.ts", language: "typescript" },
      {
        fileEdges: [{ targetRelPath: "src/bar.ts", importText: "./bar" }],
        methodEdges: [
          {
            sourceSymbolId: "main",
            targetSymbolId: "Bar.baz",
            targetRelPath: "src/bar.ts",
            callExpression: "Bar.baz()",
          },
        ],
      },
    );

    // fanOut stable at 1 (not doubled to 2), and old targets gone.
    expect(await client.getFanOut("src/main.ts")).toBe(1);
    expect(await client.getCallSiteCount("main")).toBe(1);
    expect(await client.getFanIn("src/foo.ts")).toBe(0); // old import edge gone
    expect(await client.getCalledByCount("Foo.bar")).toBe(0); // old call edge gone
    expect(await client.getFanIn("src/bar.ts")).toBe(1);
    expect(await client.getCalledByCount("Bar.baz")).toBe(1);
  });

  // Slice 2 / A4c — persisted symbol table. The in-memory
  // GlobalSymbolTable hydrates from this table on cold start; partial
  // reindex relies on it for cross-file resolution.
  it("upsertSymbols + listAllSymbols round-trip preserves scope arrays", async () => {
    await client.upsertSymbols("src/foo.ts", [
      { symbolId: "Foo.bar", fqName: "Foo.bar", shortName: "bar", relPath: "src/foo.ts", scope: ["Foo"] },
      { symbolId: "Foo.baz", fqName: "Foo.baz", shortName: "baz", relPath: "src/foo.ts", scope: ["Foo"] },
    ]);
    const rows = await client.listAllSymbols();
    expect(rows).toHaveLength(2);
    const bar = rows.find((r) => r.symbolId === "Foo.bar");
    expect(bar?.scope).toEqual(["Foo"]);
    expect(bar?.fqName).toBe("Foo.bar");
  });

  it("upsertSymbols replaces previous definitions for the same file (DELETE+INSERT)", async () => {
    await client.upsertSymbols("src/foo.ts", [
      { symbolId: "Foo.bar", fqName: "Foo.bar", shortName: "bar", relPath: "src/foo.ts", scope: ["Foo"] },
    ]);
    await client.upsertSymbols("src/foo.ts", [
      { symbolId: "Foo.baz", fqName: "Foo.baz", shortName: "baz", relPath: "src/foo.ts", scope: ["Foo"] },
    ]);
    const rows = await client.listAllSymbols();
    expect(rows.map((r) => r.symbolId)).toEqual(["Foo.baz"]);
  });

  it("removeSymbolsForFile drops the file's entries without touching others", async () => {
    await client.upsertSymbols("src/a.ts", [
      { symbolId: "A.x", fqName: "A.x", shortName: "x", relPath: "src/a.ts", scope: ["A"] },
    ]);
    await client.upsertSymbols("src/b.ts", [
      { symbolId: "B.y", fqName: "B.y", shortName: "y", relPath: "src/b.ts", scope: ["B"] },
    ]);
    await client.removeSymbolsForFile("src/a.ts");
    const rows = await client.listAllSymbols();
    expect(rows.map((r) => r.relPath)).toEqual(["src/b.ts"]);
  });

  // Slice 2 / B1 — transitive blast radius. Reverse BFS via DuckDB
  // recursive CTE. Cycle-safe (UNION deduplicates).
  describe("getTransitiveImpact (B1)", () => {
    it("returns zero for an isolated file with no incoming edges", async () => {
      await client.upsertFile({ relPath: "src/orphan.ts", language: "typescript" }, { fileEdges: [], methodEdges: [] });
      expect(await client.getTransitiveImpact("src/orphan.ts")).toBe(0);
    });

    it("counts direct importers at depth 1", async () => {
      await client.upsertFile({ relPath: "src/core.ts", language: "typescript" }, { fileEdges: [], methodEdges: [] });
      await client.upsertFile(
        { relPath: "src/a.ts", language: "typescript" },
        { fileEdges: [{ targetRelPath: "src/core.ts", importText: "./core" }], methodEdges: [] },
      );
      await client.upsertFile(
        { relPath: "src/b.ts", language: "typescript" },
        { fileEdges: [{ targetRelPath: "src/core.ts", importText: "./core" }], methodEdges: [] },
      );
      expect(await client.getTransitiveImpact("src/core.ts")).toBe(2);
    });

    it("walks multi-hop dependencies and dedupes diamond paths", async () => {
      // graph: core <- mid1, core <- mid2, mid1 <- leaf, mid2 <- leaf
      // transitive impact of core = {mid1, mid2, leaf} = 3 (leaf counted once)
      await client.upsertFile({ relPath: "src/core.ts", language: "typescript" }, { fileEdges: [], methodEdges: [] });
      await client.upsertFile(
        { relPath: "src/mid1.ts", language: "typescript" },
        { fileEdges: [{ targetRelPath: "src/core.ts", importText: "./core" }], methodEdges: [] },
      );
      await client.upsertFile(
        { relPath: "src/mid2.ts", language: "typescript" },
        { fileEdges: [{ targetRelPath: "src/core.ts", importText: "./core" }], methodEdges: [] },
      );
      await client.upsertFile(
        { relPath: "src/leaf.ts", language: "typescript" },
        {
          fileEdges: [
            { targetRelPath: "src/mid1.ts", importText: "./mid1" },
            { targetRelPath: "src/mid2.ts", importText: "./mid2" },
          ],
          methodEdges: [],
        },
      );
      expect(await client.getTransitiveImpact("src/core.ts")).toBe(3);
    });

    it("respects maxDepth cap", async () => {
      // chain: a -> b -> c -> d -> e -> f (each file imports the next)
      const chain = ["a", "b", "c", "d", "e", "f"].map((n) => `src/${n}.ts`);
      for (let i = 0; i < chain.length; i++) {
        await client.upsertFile(
          { relPath: chain[i], language: "typescript" },
          {
            fileEdges: i + 1 < chain.length ? [{ targetRelPath: chain[i + 1], importText: `./${chain[i + 1]}` }] : [],
            methodEdges: [],
          },
        );
      }
      // From f, ancestors via reverse BFS: e (d=1), d (d=2), c (d=3), b (d=4), a (d=5).
      // maxDepth=2 limits to {e, d} = 2.
      expect(await client.getTransitiveImpact("src/f.ts", 2)).toBe(2);
      // maxDepth=5 captures all five ancestors.
      expect(await client.getTransitiveImpact("src/f.ts", 5)).toBe(5);
    });

    it("is cycle-safe (UNION dedup terminates A↔B import loop)", async () => {
      await client.upsertFile(
        { relPath: "src/a.ts", language: "typescript" },
        { fileEdges: [{ targetRelPath: "src/b.ts", importText: "./b" }], methodEdges: [] },
      );
      await client.upsertFile(
        { relPath: "src/b.ts", language: "typescript" },
        { fileEdges: [{ targetRelPath: "src/a.ts", importText: "./a" }], methodEdges: [] },
      );
      // Each file's transitive impact == 1 (the cycle partner). UNION
      // deduplicates so the recursion terminates even though the graph
      // is strongly connected.
      expect(await client.getTransitiveImpact("src/a.ts")).toBe(1);
      expect(await client.getTransitiveImpact("src/b.ts")).toBe(1);
    });
  });

  // Slice 2 / B2 — Tarjan SCC over file/method graph persisted to
  // cg_symbols_cycles. Recompute is debounced by sink.finish; readers
  // hit a sub-ms SELECT.
  describe("findCycles + recomputeCycles (B2)", () => {
    it("file scope: detects circular imports A↔B and persists them", async () => {
      await client.upsertFile(
        { relPath: "src/a.ts", language: "typescript" },
        { fileEdges: [{ targetRelPath: "src/b.ts", importText: "./b" }], methodEdges: [] },
      );
      await client.upsertFile(
        { relPath: "src/b.ts", language: "typescript" },
        { fileEdges: [{ targetRelPath: "src/a.ts", importText: "./a" }], methodEdges: [] },
      );
      await client.recomputeCycles("file");
      const cycles = await client.findCycles("file");
      expect(cycles).toHaveLength(1);
      expect(cycles[0].scope).toBe("file");
      expect(cycles[0].members.slice().sort()).toEqual(["src/a.ts", "src/b.ts"]);
    });

    it("recompute is idempotent — re-running with same graph yields same cycles", async () => {
      await client.upsertFile(
        { relPath: "src/a.ts", language: "typescript" },
        { fileEdges: [{ targetRelPath: "src/b.ts", importText: "./b" }], methodEdges: [] },
      );
      await client.upsertFile(
        { relPath: "src/b.ts", language: "typescript" },
        { fileEdges: [{ targetRelPath: "src/a.ts", importText: "./a" }], methodEdges: [] },
      );
      await client.recomputeCycles("file");
      await client.recomputeCycles("file");
      const cycles = await client.findCycles("file");
      expect(cycles).toHaveLength(1);
    });

    it("file scope: DAG yields zero cycles", async () => {
      await client.upsertFile({ relPath: "src/sink.ts", language: "typescript" }, { fileEdges: [], methodEdges: [] });
      await client.upsertFile(
        { relPath: "src/source.ts", language: "typescript" },
        { fileEdges: [{ targetRelPath: "src/sink.ts", importText: "./sink" }], methodEdges: [] },
      );
      await client.recomputeCycles("file");
      expect(await client.findCycles("file")).toEqual([]);
    });

    it("method scope: detects circular method calls Foo.bar ↔ Baz.qux", async () => {
      await client.upsertFile(
        { relPath: "src/foo.ts", language: "typescript" },
        {
          fileEdges: [],
          methodEdges: [
            {
              sourceSymbolId: "Foo.bar",
              targetSymbolId: "Baz.qux",
              targetRelPath: "src/baz.ts",
              callExpression: "Baz.qux()",
            },
          ],
        },
      );
      await client.upsertFile(
        { relPath: "src/baz.ts", language: "typescript" },
        {
          fileEdges: [],
          methodEdges: [
            {
              sourceSymbolId: "Baz.qux",
              targetSymbolId: "Foo.bar",
              targetRelPath: "src/foo.ts",
              callExpression: "Foo.bar()",
            },
          ],
        },
      );
      await client.recomputeCycles("method");
      const cycles = await client.findCycles("method");
      expect(cycles).toHaveLength(1);
      expect(cycles[0].scope).toBe("method");
      expect(cycles[0].members.slice().sort()).toEqual(["Baz.qux", "Foo.bar"]);
    });

    it("file and method scopes are independent — file recompute leaves method cycles intact", async () => {
      // Seed both scopes with a cycle.
      await client.upsertFile(
        { relPath: "src/a.ts", language: "typescript" },
        {
          fileEdges: [{ targetRelPath: "src/b.ts", importText: "./b" }],
          methodEdges: [
            {
              sourceSymbolId: "A.foo",
              targetSymbolId: "B.bar",
              targetRelPath: "src/b.ts",
              callExpression: "B.bar()",
            },
          ],
        },
      );
      await client.upsertFile(
        { relPath: "src/b.ts", language: "typescript" },
        {
          fileEdges: [{ targetRelPath: "src/a.ts", importText: "./a" }],
          methodEdges: [
            {
              sourceSymbolId: "B.bar",
              targetSymbolId: "A.foo",
              targetRelPath: "src/a.ts",
              callExpression: "A.foo()",
            },
          ],
        },
      );
      await client.recomputeCycles("file");
      await client.recomputeCycles("method");
      // Now recompute file scope alone — method cycles must remain.
      await client.recomputeCycles("file");
      expect(await client.findCycles("file")).toHaveLength(1);
      expect(await client.findCycles("method")).toHaveLength(1);
    });
  });

  // Slice 2 / B3 — PageRank persisted per symbol via Tarjan-shared adjacency.
  describe("recomputePageRank + getPageRank (B3)", () => {
    it("getPageRank returns 0 when the metrics table is empty (no recompute yet)", async () => {
      expect(await client.getPageRank("Foo.bar")).toBe(0);
    });

    it("symmetric triangle yields equal ranks summing to ~1", async () => {
      await client.upsertFile(
        { relPath: "src/a.ts", language: "typescript" },
        {
          fileEdges: [],
          methodEdges: [
            { sourceSymbolId: "A.foo", targetSymbolId: "B.bar", targetRelPath: "src/b.ts", callExpression: "B.bar()" },
          ],
        },
      );
      await client.upsertFile(
        { relPath: "src/b.ts", language: "typescript" },
        {
          fileEdges: [],
          methodEdges: [
            { sourceSymbolId: "B.bar", targetSymbolId: "C.baz", targetRelPath: "src/c.ts", callExpression: "C.baz()" },
          ],
        },
      );
      await client.upsertFile(
        { relPath: "src/c.ts", language: "typescript" },
        {
          fileEdges: [],
          methodEdges: [
            { sourceSymbolId: "C.baz", targetSymbolId: "A.foo", targetRelPath: "src/a.ts", callExpression: "A.foo()" },
          ],
        },
      );
      await client.recomputePageRank();
      const rFoo = await client.getPageRank("A.foo");
      const rBar = await client.getPageRank("B.bar");
      const rBaz = await client.getPageRank("C.baz");
      expect(rFoo).toBeGreaterThan(0);
      expect(rFoo).toBeCloseTo(rBar, 3);
      expect(rBar).toBeCloseTo(rBaz, 3);
      expect(rFoo + rBar + rBaz).toBeCloseTo(1, 2);
    });

    it("recompute is idempotent across runs", async () => {
      await client.upsertFile(
        { relPath: "src/a.ts", language: "typescript" },
        {
          fileEdges: [],
          methodEdges: [
            { sourceSymbolId: "A.foo", targetSymbolId: "B.bar", targetRelPath: "src/b.ts", callExpression: "B.bar()" },
          ],
        },
      );
      await client.upsertFile(
        { relPath: "src/b.ts", language: "typescript" },
        {
          fileEdges: [],
          methodEdges: [
            { sourceSymbolId: "B.bar", targetSymbolId: "A.foo", targetRelPath: "src/a.ts", callExpression: "A.foo()" },
          ],
        },
      );
      await client.recomputePageRank();
      const first = await client.getPageRank("A.foo");
      await client.recomputePageRank();
      const second = await client.getPageRank("A.foo");
      expect(first).toBeCloseTo(second, 6);
    });

    it("recompute on empty graph yields no rows (getPageRank stays 0)", async () => {
      await client.recomputePageRank();
      expect(await client.getPageRank("anything")).toBe(0);
    });
  });

  it("removeFile cascades into cg_symbols as well as the edge tables", async () => {
    await client.upsertFile({ relPath: "src/foo.ts", language: "typescript" }, { fileEdges: [], methodEdges: [] });
    await client.upsertSymbols("src/foo.ts", [
      { symbolId: "Foo.bar", fqName: "Foo.bar", shortName: "bar", relPath: "src/foo.ts", scope: ["Foo"] },
    ]);
    await client.removeFile("src/foo.ts");
    expect(await client.listAllSymbols()).toEqual([]);
  });

  it("removeFile cascades incoming + outgoing edges via ON DELETE CASCADE", async () => {
    await client.upsertFile({ relPath: "src/a.ts", language: "typescript" }, { fileEdges: [], methodEdges: [] });
    await client.upsertFile(
      { relPath: "src/b.ts", language: "typescript" },
      {
        fileEdges: [{ targetRelPath: "src/a.ts", importText: "./a" }],
        methodEdges: [],
      },
    );
    await client.removeFile("src/a.ts");
    expect(await client.getFanOut("src/b.ts")).toBe(0);
  });

  it("getCallers returns method-edges in stable order", async () => {
    await client.upsertFile({ relPath: "src/a.ts", language: "typescript" }, { fileEdges: [], methodEdges: [] });
    await client.upsertFile(
      { relPath: "src/c.ts", language: "typescript" },
      {
        fileEdges: [],
        methodEdges: [
          {
            sourceSymbolId: "C.f",
            targetSymbolId: "A.x",
            targetRelPath: "src/a.ts",
            callExpression: "A.x()",
          },
        ],
      },
    );
    await client.upsertFile(
      { relPath: "src/d.ts", language: "typescript" },
      {
        fileEdges: [],
        methodEdges: [
          {
            sourceSymbolId: "D.g",
            targetSymbolId: "A.x",
            targetRelPath: "src/a.ts",
            callExpression: "A.x()",
          },
        ],
      },
    );
    const callers = await client.getCallers("A.x");
    expect(callers.map((c) => c.sourceSymbolId).sort()).toEqual(["C.f", "D.g"]);
  });

  // Slice 1 — defensive guards. The client must fail loudly on misuse
  // rather than emit silent SQL with undefined connection state or
  // unsupported bind types. These are public surface contracts that
  // the migration runner + facades rely on.
  describe("defensive guards", () => {
    it("operations throw when init() has not been called", async () => {
      // Construct without init — the connection is still undefined.
      // requireConn() must surface a clear error instead of letting a
      // null-deref through into the @duckdb/node-api binding.
      const uninit = new DuckDbGraphClient({ path: join(tmp, "uninit.duckdb") });
      await expect(uninit.exec("SELECT 1")).rejects.toThrow(/init\(\) must be called/);
    });

    it("run() rejects unsupported bind param types (asBindable guard)", async () => {
      // asBindable accepts string|number|boolean|null|undefined only.
      // Passing an object/array would otherwise reach bindVarchar with
      // a value that stringifies to "[object Object]" — silently wrong.
      // The guard throws synchronously inside the helper.
      await expect(client.run("SELECT ?", [{ unsupported: true } as unknown as string])).rejects.toThrow(
        /unsupported bind param type/,
      );
    });

    it("upsertSymbols tolerates a malformed scope_json round-trip via parseScope catch", async () => {
      // parseScope catches JSON.parse failures and returns []. Write a
      // row whose scope_json column is not valid JSON via the generic
      // run() helper, then listAllSymbols must hydrate it as scope=[]
      // rather than crashing the read path.
      await client.run(
        "INSERT INTO cg_symbols (rel_path, symbol_id, fq_name, short_name, scope_json) VALUES (?, ?, ?, ?, ?)",
        ["src/raw.ts", "Raw.x", "Raw.x", "x", "not-json{{"],
      );
      const rows = await client.listAllSymbols();
      const raw = rows.find((r) => r.symbolId === "Raw.x");
      expect(raw?.scope).toEqual([]);
    });

    it("bind path handles null params via bindNull (nullable import_text column)", async () => {
      // bindParams routes null/undefined to bindNull(i+1). The
      // cg_symbols_edges_file.import_text column is nullable; binding
      // null there must reach the bindNull branch without crashing.
      await client.run(
        "INSERT INTO cg_symbols_edges_file (source_rel_path, target_rel_path, import_text) VALUES (?, ?, ?)",
        ["src/a.ts", "src/b.ts", null],
      );
      const rows = await client.queryAll<{ n: number | bigint }>(
        "SELECT COUNT(*) AS n FROM cg_symbols_edges_file WHERE import_text IS NULL",
      );
      expect(Number(rows[0]?.n ?? 0)).toBe(1);
    });
  });

  // Slice 2 / B2 — method-scope adjacency loader. Method edges may have
  // null target_symbol_id (resolver couldn't pin the call). The loader
  // must filter those out so they don't pollute SCC detection with
  // phantom edges, AND the empty-method-graph path must yield zero
  // cycles (loadAdjacencyFor returns an empty Map, tarjanScc returns []).
  it("recomputeCycles('method') succeeds on an empty method graph", async () => {
    // No method edges yet — recomputeCycles must walk the empty
    // adjacency and DELETE+INSERT a zero-row result.
    await client.recomputeCycles("method");
    expect(await client.findCycles("method")).toEqual([]);
  });

  it("getCallees + getCalledByCount + getCallSiteCount track method edges", async () => {
    await client.upsertFile({ relPath: "src/a.ts", language: "typescript" }, { fileEdges: [], methodEdges: [] });
    await client.upsertFile({ relPath: "src/b.ts", language: "typescript" }, { fileEdges: [], methodEdges: [] });
    await client.upsertFile(
      { relPath: "src/main.ts", language: "typescript" },
      {
        fileEdges: [],
        methodEdges: [
          {
            sourceSymbolId: "main",
            targetSymbolId: "A.x",
            targetRelPath: "src/a.ts",
            callExpression: "A.x()",
          },
          {
            sourceSymbolId: "main",
            targetSymbolId: "B.y",
            targetRelPath: "src/b.ts",
            callExpression: "B.y()",
          },
        ],
      },
    );
    expect((await client.getCallees("main")).length).toBe(2);
    expect(await client.getCallSiteCount("main")).toBe(2);
    expect(await client.getCalledByCount("A.x")).toBe(1);
  });
});

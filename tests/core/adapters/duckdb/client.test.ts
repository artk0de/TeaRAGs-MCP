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

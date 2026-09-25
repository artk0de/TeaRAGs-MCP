/**
 * `getFileImporters` / `getFileImports` — the per-file reads behind file-scope
 * `get_callers` / `get_callees` (bd tea-rags-mcp-gfvr8).
 *
 * Invariants under test:
 *   - the edge set is `cg_symbols_edges_file`: importers are rows whose TARGET
 *     is the file, imports are rows whose SOURCE is the file;
 *   - each edge carries its `import_text` and the same confidence-weighted call
 *     weight `readFileDependencyGraph` reports for that pair;
 *   - `fileKnown` says whether the walk extracted the file, so "no importers"
 *     and "no such file" stay distinguishable;
 *   - a file the walk never extracted but that some edge still targets is
 *     answered with its edges (it is what the source's fanOut counts).
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { DuckDbGraphClient } from "../../../../src/core/adapters/duckdb/client.js";
import { DATABASE_MIGRATIONS } from "../../../../src/core/domains/maintenance/migration/database/migrations/index.js";
import { runMigrations } from "../../../../src/core/domains/maintenance/migration/database/runner.js";

describe("DuckDbGraphClient — getFileImporters / getFileImports", () => {
  let dir: string;
  let db: DuckDbGraphClient;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "cg-file-import-edges-"));
    db = new DuckDbGraphClient({ path: join(dir, "g.duckdb") });
    await db.init();
    await runMigrations(db, DATABASE_MIGRATIONS);

    await db.upsertFile(
      { relPath: "src/a.ts", language: "typescript" },
      {
        fileEdges: [
          { targetRelPath: "src/b.ts", importText: "./b.js" },
          { targetRelPath: "gen/ghost.ts", importText: "../gen/ghost.js" },
        ],
        methodEdges: [
          { sourceSymbolId: "A#run", targetSymbolId: "B#x", targetRelPath: "src/b.ts", callExpression: "b.x()" },
          {
            sourceSymbolId: "A#run",
            targetSymbolId: "B#y",
            targetRelPath: "src/b.ts",
            callExpression: "b.y()",
            edgeKind: "cone",
            confidence: 0.5,
          },
        ],
      },
    );
    await db.upsertFile(
      { relPath: "src/c.ts", language: "typescript" },
      { fileEdges: [{ targetRelPath: "src/b.ts", importText: "./b" }], methodEdges: [] },
    );
    await db.upsertFile({ relPath: "src/b.ts", language: "typescript" }, { fileEdges: [], methodEdges: [] });
  });

  afterEach(async () => {
    await db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("returns the files importing a file, with import text and call weight", async () => {
    const lookup = await db.getFileImporters("src/b.ts");

    expect(lookup.fileKnown).toBe(true);
    expect([...lookup.edges].sort((x, y) => x.sourceRelPath.localeCompare(y.sourceRelPath))).toEqual([
      { sourceRelPath: "src/a.ts", targetRelPath: "src/b.ts", importText: "./b.js", callWeight: 1.5 },
      { sourceRelPath: "src/c.ts", targetRelPath: "src/b.ts", importText: "./b", callWeight: 0 },
    ]);
  });

  it("returns the files a file imports, including a target the walk never extracted", async () => {
    const lookup = await db.getFileImports("src/a.ts");

    expect(lookup.fileKnown).toBe(true);
    expect([...lookup.edges].sort((x, y) => x.targetRelPath.localeCompare(y.targetRelPath))).toEqual([
      { sourceRelPath: "src/a.ts", targetRelPath: "gen/ghost.ts", importText: "../gen/ghost.js", callWeight: 0 },
      { sourceRelPath: "src/a.ts", targetRelPath: "src/b.ts", importText: "./b.js", callWeight: 1.5 },
    ]);
  });

  it("answers a walked file with no edges as known and empty", async () => {
    expect(await db.getFileImporters("src/a.ts")).toEqual({ fileKnown: true, edges: [] });
    expect(await db.getFileImports("src/b.ts")).toEqual({ fileKnown: true, edges: [] });
  });

  it("answers an unwalked edge target with its edges, flagged unknown", async () => {
    const lookup = await db.getFileImporters("gen/ghost.ts");
    expect(lookup.fileKnown).toBe(false);
    expect(lookup.edges.map((e) => e.sourceRelPath)).toEqual(["src/a.ts"]);
  });

  it("answers a path the graph has never seen as unknown and empty", async () => {
    expect(await db.getFileImporters("nope.ts")).toEqual({ fileKnown: false, edges: [] });
    expect(await db.getFileImports("nope.ts")).toEqual({ fileKnown: false, edges: [] });
  });
});

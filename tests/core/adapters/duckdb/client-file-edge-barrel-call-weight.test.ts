/**
 * Call weight routed through re-export barrels (bd tea-rags-mcp-r8hme.52.1).
 *
 * An import of a barrel targets `index.ts`, but the resolved calls land on the
 * file the barrel re-exports. The file edge `S → barrel` must carry the weight
 * of `S`'s calls into the definer, or the layering detector reads a heavy
 * dependency as callWeight 0.
 *
 * Invariants under test:
 *   - a barrel import carries the weight of the calls into the file the barrel
 *     re-exports, nested barrels included;
 *   - each `(source, definer)` call weight is credited to EXACTLY ONE file
 *     edge: the direct `S → D` edge when it exists, else the barrel reaching D
 *     through the shortest re-export chain, code-point order breaking a tie;
 *   - routing adds weight, never an edge;
 *   - `getFileImports` / `getFileImporters` report the weights the whole-graph
 *     read does.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { DuckDbGraphClient } from "../../../../src/core/adapters/duckdb/client.js";
import type { FileDependencyEdge, GraphEdges } from "../../../../src/core/contracts/types/codegraph.js";
import { DATABASE_MIGRATIONS } from "../../../../src/core/domains/maintenance/migration/database/migrations/index.js";
import { runMigrations } from "../../../../src/core/domains/maintenance/migration/database/runner.js";

type FileEdgeInput = GraphEdges["fileEdges"][number];
type MethodEdge = GraphEdges["methodEdges"][number];

function call(targetRelPath: string, targetSymbolId: string): MethodEdge {
  return { sourceSymbolId: "S#run", targetSymbolId, targetRelPath, callExpression: `${targetSymbolId}()` };
}

describe("DuckDbGraphClient — call weight routed through re-export barrels", () => {
  let dir: string;
  let db: DuckDbGraphClient;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "cg-barrel-call-weight-"));
    db = new DuckDbGraphClient({ path: join(dir, "g.duckdb") });
    await db.init();
    await runMigrations(db, DATABASE_MIGRATIONS);
  });

  afterEach(async () => {
    await db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  async function file(relPath: string, fileEdges: FileEdgeInput[], methodEdges: MethodEdge[] = []): Promise<void> {
    await db.upsertFile({ relPath, language: "typescript" }, { fileEdges, methodEdges });
  }

  async function weights(): Promise<Record<string, number>> {
    const graph = await db.readFileDependencyGraph();
    return Object.fromEntries(
      graph.edges.map((e: FileDependencyEdge) => [`${e.sourceRelPath} > ${e.targetRelPath}`, e.callWeight]),
    );
  }

  it("credits a barrel import with the calls into the file the barrel re-exports", async () => {
    await file(
      "src/s.ts",
      [{ targetRelPath: "src/b/index.ts", importText: "./b/index.js" }],
      [call("src/b/x.ts", "x"), call("src/b/x.ts", "y")],
    );
    await file("src/b/index.ts", [{ targetRelPath: "src/b/x.ts", importText: "./x.js", reexportedExportNames: ["*"] }]);
    await file("src/b/x.ts", []);

    expect(await weights()).toEqual({
      "src/s.ts > src/b/index.ts": 2,
      "src/b/index.ts > src/b/x.ts": 0,
    });
  });

  it("follows a nested barrel chain to the definer", async () => {
    await file("src/s.ts", [{ targetRelPath: "src/index.ts", importText: "./index.js" }], [call("src/b/x.ts", "x")]);
    await file("src/index.ts", [
      { targetRelPath: "src/b/index.ts", importText: "./b/index.js", reexportedExportNames: ["*"] },
    ]);
    await file("src/b/index.ts", [{ targetRelPath: "src/b/x.ts", importText: "./x.js", reexportedExportNames: ["x"] }]);
    await file("src/b/x.ts", []);

    expect((await weights())["src/s.ts > src/index.ts"]).toBe(1);
  });

  it("credits a definer reachable through two barrels once: the shorter chain, then code-point order", async () => {
    await file(
      "src/s.ts",
      [
        { targetRelPath: "src/index.ts", importText: "./index.js" },
        { targetRelPath: "src/z/index.ts", importText: "./z/index.js" },
        { targetRelPath: "src/a/index.ts", importText: "./a/index.js" },
      ],
      [call("src/b/x.ts", "x"), call("src/c/y.ts", "y")],
    );
    // src/index.ts reaches x in two hops; src/z/index.ts and src/a/index.ts in one.
    await file("src/index.ts", [
      { targetRelPath: "src/a/index.ts", importText: "./a/index.js", reexportedExportNames: ["*"] },
    ]);
    await file("src/a/index.ts", [
      { targetRelPath: "src/b/x.ts", importText: "../b/x.js", reexportedExportNames: ["x"] },
    ]);
    await file("src/z/index.ts", [
      { targetRelPath: "src/b/x.ts", importText: "../b/x.js", reexportedExportNames: ["x"] },
      { targetRelPath: "src/c/y.ts", importText: "../c/y.js", reexportedExportNames: ["y"] },
    ]);
    await file("src/b/x.ts", []);
    await file("src/c/y.ts", []);

    const w = await weights();

    // x: a/index.ts and z/index.ts tie at one hop → "src/a/index.ts" wins on code-point order.
    // y: only z/index.ts reaches it.
    expect(w["src/s.ts > src/a/index.ts"]).toBe(1);
    expect(w["src/s.ts > src/z/index.ts"]).toBe(1);
    expect(w["src/s.ts > src/index.ts"]).toBe(0);
    // Never double-counted: the routed total equals the calls made.
    expect(w["src/s.ts > src/a/index.ts"] + w["src/s.ts > src/z/index.ts"] + w["src/s.ts > src/index.ts"]).toBe(2);
  });

  it("keeps a direct edge's own weight and gives the barrel none for the same definer", async () => {
    await file(
      "src/s.ts",
      [
        { targetRelPath: "src/b/index.ts", importText: "./b/index.js" },
        { targetRelPath: "src/b/x.ts", importText: "./b/x.js" },
      ],
      [call("src/b/x.ts", "x")],
    );
    await file("src/b/index.ts", [{ targetRelPath: "src/b/x.ts", importText: "./x.js", reexportedExportNames: ["*"] }]);
    await file("src/b/x.ts", []);

    const w = await weights();

    expect(w["src/s.ts > src/b/x.ts"]).toBe(1);
    expect(w["src/s.ts > src/b/index.ts"]).toBe(0);
  });

  it("adds no edge for a call no file edge reaches, and terminates on a re-export cycle", async () => {
    await file(
      "src/s.ts",
      [{ targetRelPath: "src/p/index.ts", importText: "./p/index.js" }],
      [call("src/far.ts", "f")],
    );
    await file("src/p/index.ts", [
      { targetRelPath: "src/q/index.ts", importText: "../q/index.js", reexportedExportNames: ["*"] },
    ]);
    await file("src/q/index.ts", [
      { targetRelPath: "src/p/index.ts", importText: "../p/index.js", reexportedExportNames: ["*"] },
    ]);
    await file("src/far.ts", []);

    expect(await weights()).toEqual({
      "src/s.ts > src/p/index.ts": 0,
      "src/p/index.ts > src/q/index.ts": 0,
      "src/q/index.ts > src/p/index.ts": 0,
    });
  });

  it("reports the same routed weights through getFileImports and getFileImporters", async () => {
    await file(
      "src/s.ts",
      [
        { targetRelPath: "src/a/index.ts", importText: "./a/index.js" },
        { targetRelPath: "src/z/index.ts", importText: "./z/index.js" },
      ],
      [call("src/b/x.ts", "x"), call("src/b/x.ts", "x2")],
    );
    await file(
      "src/t.ts",
      [{ targetRelPath: "src/z/index.ts", importText: "./z/index.js" }],
      [{ sourceSymbolId: "T#run", targetSymbolId: "x", targetRelPath: "src/b/x.ts", callExpression: "x()" }],
    );
    await file("src/a/index.ts", [
      { targetRelPath: "src/b/x.ts", importText: "../b/x.js", reexportedExportNames: ["x"] },
    ]);
    await file("src/z/index.ts", [
      { targetRelPath: "src/b/x.ts", importText: "../b/x.js", reexportedExportNames: ["x"] },
    ]);
    await file("src/b/x.ts", []);

    const graph = await weights();
    const imports = await db.getFileImports("src/s.ts");
    const importers = await db.getFileImporters("src/z/index.ts");

    expect(
      Object.fromEntries(imports.edges.map((e) => [`${e.sourceRelPath} > ${e.targetRelPath}`, e.callWeight])),
    ).toEqual({
      "src/s.ts > src/a/index.ts": graph["src/s.ts > src/a/index.ts"],
      "src/s.ts > src/z/index.ts": graph["src/s.ts > src/z/index.ts"],
    });
    expect(
      Object.fromEntries(importers.edges.map((e) => [`${e.sourceRelPath} > ${e.targetRelPath}`, e.callWeight])),
    ).toEqual({
      "src/s.ts > src/z/index.ts": graph["src/s.ts > src/z/index.ts"],
      "src/t.ts > src/z/index.ts": graph["src/t.ts > src/z/index.ts"],
    });
    // s's calls go to a/index.ts (code-point order), so z/index.ts gets only t's.
    expect(graph["src/s.ts > src/a/index.ts"]).toBe(2);
    expect(graph["src/s.ts > src/z/index.ts"]).toBe(0);
    expect(graph["src/t.ts > src/z/index.ts"]).toBe(1);
  });
});

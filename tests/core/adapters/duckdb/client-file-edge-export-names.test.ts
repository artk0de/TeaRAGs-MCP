/**
 * Export names on persisted file edges (bd tea-rags-mcp-r8hme.2, migration 030).
 *
 * Invariants under test:
 *   - the names a file edge carries survive the write and come back on
 *     `readFileDependencyGraph`, imported and re-exported separately;
 *   - an edge written without names reads back with neither field — "not
 *     recorded" is never collapsed into "imports nothing";
 *   - a re-walk that changes only the names rewrites them (the row diff treats
 *     them as values, not as part of the key).
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { DuckDbGraphClient } from "../../../../src/core/adapters/duckdb/client.js";
import { DATABASE_MIGRATIONS } from "../../../../src/core/domains/maintenance/migration/database/migrations/index.js";
import { runMigrations } from "../../../../src/core/domains/maintenance/migration/database/runner.js";

describe("DuckDbGraphClient — file edge export names", () => {
  let dir: string;
  let db: DuckDbGraphClient;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "cg-file-edge-names-"));
    db = new DuckDbGraphClient({ path: join(dir, "g.duckdb") });
    await db.init();
    await runMigrations(db, DATABASE_MIGRATIONS);
  });

  afterEach(async () => {
    await db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("round-trips imported and re-exported names, and leaves unnamed edges without either", async () => {
    await db.upsertFile(
      { relPath: "src/lib/index.ts", language: "typescript" },
      {
        fileEdges: [
          { targetRelPath: "src/lib/a.ts", importText: "./a.js", reexportedExportNames: ["*"] },
          { targetRelPath: "src/lib/b.ts", importText: "./b.js", importedExportNames: ["default", "b"] },
          { targetRelPath: "src/lib/c.ts", importText: "./c.js" },
        ],
        methodEdges: [],
      },
    );

    const { edges } = await db.readFileDependencyGraph();
    const byTarget = new Map(edges.map((e) => [e.targetRelPath, e]));
    expect(byTarget.get("src/lib/a.ts")?.reexportedExportNames).toEqual(["*"]);
    expect(byTarget.get("src/lib/a.ts")?.importedExportNames).toBeUndefined();
    expect(byTarget.get("src/lib/b.ts")?.importedExportNames).toEqual(["default", "b"]);
    expect(byTarget.get("src/lib/b.ts")?.reexportedExportNames).toBeUndefined();
    const plain = byTarget.get("src/lib/c.ts");
    expect(plain && "importedExportNames" in plain).toBe(false);
    expect(plain && "reexportedExportNames" in plain).toBe(false);
  });

  it("rewrites the names when a re-walk changes only them", async () => {
    const write = async (names: string[]) =>
      db.upsertFile(
        { relPath: "app/page.ts", language: "typescript" },
        {
          fileEdges: [{ targetRelPath: "src/lib/b.ts", importText: "../src/lib/b.js", importedExportNames: names }],
          methodEdges: [],
        },
      );
    await write(["b"]);
    await write(["b", "c"]);

    const { edges } = await db.readFileDependencyGraph();
    expect(edges).toHaveLength(1);
    expect(edges[0]?.importedExportNames).toEqual(["b", "c"]);
  });
});

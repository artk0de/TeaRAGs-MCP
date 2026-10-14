/**
 * `readFileReexportEdges` (bd tea-rags-mcp-lnor0, n415l lever 5): the file
 * edges that forward export names, projected straight from
 * `cg_symbols_edges_file` — what naming's re-export twin suppression reads
 * instead of pulling the whole dependency graph.
 *
 * Invariants under test:
 *   - only edges with re-exported names come back, names decoded;
 *   - the twins built from them are the twins built from the whole graph's
 *     edges, for every pair and name of the fixture.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { DuckDbGraphClient } from "../../../../src/core/adapters/duckdb/client.js";
import { reexportTwins } from "../../../../src/core/domains/explore/naming-lexicon/verdicts.js";
import { DATABASE_MIGRATIONS } from "../../../../src/core/domains/maintenance/migration/database/migrations/index.js";
import { runMigrations } from "../../../../src/core/domains/maintenance/migration/database/runner.js";

describe("DuckDbGraphClient#readFileReexportEdges (bd tea-rags-mcp-lnor0)", () => {
  let dir: string;
  let db: DuckDbGraphClient;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "cg-file-reexport-edges-"));
    db = new DuckDbGraphClient({ path: join(dir, "g.duckdb") });
    await db.init();
    await runMigrations(db, DATABASE_MIGRATIONS);
    await db.upsertFile(
      { relPath: "src/lib/index.ts", language: "typescript" },
      {
        fileEdges: [
          { targetRelPath: "src/lib/a.ts", importText: "./a.js", reexportedExportNames: ["A", "AOptions"] },
          { targetRelPath: "src/lib/b.ts", importText: "./b.js", importedExportNames: ["b"] },
          { targetRelPath: "src/lib/c.ts", importText: "./c.js", reexportedExportNames: ["*"] },
        ],
        methodEdges: [],
      },
    );
    await db.upsertFile(
      { relPath: "src/api/dto.ts", language: "typescript" },
      {
        fileEdges: [
          { targetRelPath: "src/lib/index.ts", importText: "../lib/index.js", reexportedExportNames: ["A"] },
          { targetRelPath: "src/lib/c.ts", importText: "../lib/c.js" },
        ],
        methodEdges: [],
      },
    );
  });

  afterEach(async () => {
    await db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("answers only the edges that forward names, the names decoded", async () => {
    const edges = await db.readFileReexportEdges();

    expect([...edges].sort((x, y) => x.targetRelPath.localeCompare(y.targetRelPath))).toEqual([
      { sourceRelPath: "src/lib/index.ts", targetRelPath: "src/lib/a.ts", reexportedExportNames: ["A", "AOptions"] },
      { sourceRelPath: "src/lib/index.ts", targetRelPath: "src/lib/c.ts", reexportedExportNames: ["*"] },
      { sourceRelPath: "src/api/dto.ts", targetRelPath: "src/lib/index.ts", reexportedExportNames: ["A"] },
    ]);
  });

  it("builds the same re-export twins as the whole dependency graph's edges", async () => {
    const projected = reexportTwins(await db.readFileReexportEdges());
    const whole = reexportTwins((await db.readFileDependencyGraph()).edges);
    const files = ["src/lib/index.ts", "src/lib/a.ts", "src/lib/b.ts", "src/lib/c.ts", "src/api/dto.ts"];
    const names = ["A", "AOptions", "b", "*", "Missing"];

    for (const a of files) {
      for (const b of files) {
        for (const name of names) expect(projected.joins(a, b, name)).toBe(whole.joins(a, b, name));
      }
    }
    expect(projected.joins("src/lib/a.ts", "src/lib/index.ts", "AOptions")).toBe(true);
  });
});

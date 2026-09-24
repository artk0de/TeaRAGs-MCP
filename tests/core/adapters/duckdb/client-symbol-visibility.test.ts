/**
 * `getSymbolVisibilities` — the batched read behind the declared-visibility
 * decoration of get_callers / get_callees / trace_path and the find_symbol
 * outline (bd tea-rags-mcp-sqqkz).
 *
 * Invariants under test:
 *   - one row per `cg_symbols` definition whose symbolId is in the IN-list,
 *     namesakes in other files included (the caller picks by relPath);
 *   - a NULL `visibility` column comes back as `null` — "unknown", never a
 *     default;
 *   - ids with no definition are absent; an empty list reads nothing.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { DuckDbGraphClient } from "../../../../src/core/adapters/duckdb/client.js";
import { DATABASE_MIGRATIONS } from "../../../../src/core/domains/maintenance/migration/database/migrations/index.js";
import { runMigrations } from "../../../../src/core/domains/maintenance/migration/database/runner.js";

describe("DuckDbGraphClient — getSymbolVisibilities", () => {
  let dir: string;
  let db: DuckDbGraphClient;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "cg-symbol-visibility-"));
    db = new DuckDbGraphClient({ path: join(dir, "g.duckdb") });
    await db.init();
    await runMigrations(db, DATABASE_MIGRATIONS);
    const def = (relPath: string, symbolId: string, visibility?: "public" | "private" | "protected") => ({
      symbolId,
      fqName: symbolId,
      shortName: symbolId.split(/[#.]/).at(-1) ?? symbolId,
      relPath,
      scope: [],
      ...(visibility ? { visibility } : {}),
    });
    await db.upsertSymbols("src/a.ts", [
      def("src/a.ts", "A#run", "public"),
      def("src/a.ts", "A#helper", "private"),
      def("src/a.ts", "A#hook", "protected"),
      def("src/a.ts", "A#unknown"),
    ]);
    await db.upsertSymbols("src/b.ts", [def("src/b.ts", "A#helper", "public")]);
  });

  afterEach(async () => {
    await db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("returns every definition of the requested ids, with NULL as null", async () => {
    const rows = await db.getSymbolVisibilities(["A#helper", "A#hook", "A#unknown", "Nope#x"]);
    const sorted = [...rows].sort((x, y) => `${x.relPath}${x.symbolId}`.localeCompare(`${y.relPath}${y.symbolId}`));
    expect(sorted).toEqual([
      { relPath: "src/a.ts", symbolId: "A#helper", visibility: "private" },
      { relPath: "src/a.ts", symbolId: "A#hook", visibility: "protected" },
      { relPath: "src/a.ts", symbolId: "A#unknown", visibility: null },
      { relPath: "src/b.ts", symbolId: "A#helper", visibility: "public" },
    ]);
  });

  it("reads nothing for an empty id list", async () => {
    expect(await db.getSymbolVisibilities([])).toEqual([]);
  });
});

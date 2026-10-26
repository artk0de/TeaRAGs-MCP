/**
 * `lookupSymbolIdsByShortName` — the suggestions get_callers / get_callees
 * offer for an id the graph does not hold (agent turn economy N6, bd
 * tea-rags-mcp-wrosj): distinct symbolIds defined under the short name,
 * namesakes in other files collapsed, ordered by symbolId, capped at `limit`.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { DuckDbGraphClient } from "../../../../src/core/adapters/duckdb/client.js";
import { DATABASE_MIGRATIONS } from "../../../../src/core/domains/maintenance/migration/database/migrations/index.js";
import { runMigrations } from "../../../../src/core/domains/maintenance/migration/database/runner.js";

describe("DuckDbGraphClient — lookupSymbolIdsByShortName", () => {
  let dir: string;
  let db: DuckDbGraphClient;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "cg-symbol-short-name-"));
    db = new DuckDbGraphClient({ path: join(dir, "g.duckdb") });
    await db.init();
    await runMigrations(db, DATABASE_MIGRATIONS);
    const def = (relPath: string, symbolId: string) => ({
      symbolId,
      fqName: symbolId,
      shortName: symbolId.split(/[#.]/).at(-1) ?? symbolId,
      relPath,
      scope: [],
    });
    await db.upsertSymbols("src/a.ts", [
      def("src/a.ts", "Zed#run"),
      def("src/a.ts", "Alpha.run"),
      def("src/a.ts", "A#walk"),
    ]);
    await db.upsertSymbols("src/b.ts", [def("src/b.ts", "Zed#run"), def("src/b.ts", "Mid#run")]);
  });

  afterEach(async () => {
    await db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("returns distinct ids defined under the short name, ordered, capped at limit", async () => {
    expect(await db.lookupSymbolIdsByShortName("run", 5)).toEqual(["Alpha.run", "Mid#run", "Zed#run"]);
    expect(await db.lookupSymbolIdsByShortName("run", 2)).toEqual(["Alpha.run", "Mid#run"]);
  });

  it("returns nothing for a short name no definition carries", async () => {
    expect(await db.lookupSymbolIdsByShortName("nope", 5)).toEqual([]);
  });
});

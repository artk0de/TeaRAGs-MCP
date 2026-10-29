/**
 * `getContainerMemberSymbolIds` — the direct members get_callers / get_callees
 * roll up when the queried id is a class or module (bd tea-rags-mcp-znzv3):
 * `C#m` and `C.m` of a container-kind definition, members declared in any file
 * (a reopened Ruby class) collapsed, nested scopes (`C.Inner#m`, `C::Inner`)
 * left out, ordered by symbolId, capped at `limit`. A callable is no container.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { DuckDbGraphClient } from "../../../../src/core/adapters/duckdb/client.js";
import type { SymbolDefinitionKind } from "../../../../src/core/contracts/types/codegraph.js";
import { DATABASE_MIGRATIONS } from "../../../../src/core/domains/maintenance/migration/database/migrations/index.js";
import { runMigrations } from "../../../../src/core/domains/maintenance/migration/database/runner.js";

describe("DuckDbGraphClient — getContainerMemberSymbolIds", () => {
  let dir: string;
  let db: DuckDbGraphClient;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "cg-container-members-"));
    db = new DuckDbGraphClient({ path: join(dir, "g.duckdb") });
    await db.init();
    await runMigrations(db, DATABASE_MIGRATIONS);
    const def = (relPath: string, symbolId: string, symbolKind: SymbolDefinitionKind) => ({
      symbolId,
      fqName: symbolId,
      shortName: symbolId.split(/[#.]|::/).at(-1) ?? symbolId,
      relPath,
      scope: [],
      symbolKind,
    });
    await db.upsertSymbols("lib/shop/basket.rb", [
      def("lib/shop/basket.rb", "Shop::Basket", "class"),
      def("lib/shop/basket.rb", "Shop::Basket#add", "method"),
      def("lib/shop/basket.rb", "Shop::Basket.build", "method"),
      def("lib/shop/basket.rb", "Shop::Basket::Line", "class"),
      def("lib/shop/basket.rb", "Shop::Basket::Line#total", "method"),
      def("lib/shop/basket.rb", "Shop::BasketView#render", "method"),
    ]);
    await db.upsertSymbols("lib/shop/basket_ext.rb", [
      def("lib/shop/basket_ext.rb", "Shop::Basket", "class"),
      def("lib/shop/basket_ext.rb", "Shop::Basket#clear", "method"),
      def("lib/shop/basket_ext.rb", "Shop::Basket#add", "method"),
    ]);
    await db.upsertSymbols("src/parse.ts", [
      def("src/parse.ts", "parse", "function"),
      def("src/parse.ts", "parse.close", "function"),
      def("src/parse.ts", "Panel", "class"),
      def("src/parse.ts", "Panel.Header#draw", "method"),
    ]);
  });

  afterEach(async () => {
    await db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("returns the container's direct members across files, ordered, nested scopes excluded", async () => {
    expect(await db.getContainerMemberSymbolIds("Shop::Basket", 50)).toEqual([
      "Shop::Basket#add",
      "Shop::Basket#clear",
      "Shop::Basket.build",
    ]);
  });

  it("caps at limit", async () => {
    expect(await db.getContainerMemberSymbolIds("Shop::Basket", 2)).toEqual(["Shop::Basket#add", "Shop::Basket#clear"]);
  });

  it("answers nothing for a callable, a container with no direct member, or an unknown id", async () => {
    expect(await db.getContainerMemberSymbolIds("parse", 50)).toEqual([]);
    expect(await db.getContainerMemberSymbolIds("Panel", 50)).toEqual([]);
    expect(await db.getContainerMemberSymbolIds("Nope", 50)).toEqual([]);
  });
});

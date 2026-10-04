/**
 * bd tea-rags-mcp-nfm4h — a `return` row's name is its callable's, and a
 * framework override METHOD's name (`create`) is no convention for a
 * module-level FUNCTION returning the same type. The type aggregate splits each
 * `return` group by its owner's declaration kind (`cg_symbols.symbol_kind`) on
 * request, so the naming verdict can count only the rows of the draft's kind.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { DuckDbGraphClient } from "../../../../src/core/adapters/duckdb/client.js";
import type {
  IdentifierRow,
  SymbolDefinition,
  SymbolDefinitionKind,
} from "../../../../src/core/contracts/types/codegraph.js";
import { DATABASE_MIGRATIONS } from "../../../../src/core/domains/maintenance/migration/database/migrations/index.js";
import { runMigrations } from "../../../../src/core/domains/maintenance/migration/database/runner.js";

function returns(ownerSymbolId: string, name: string, line: number): IdentifierRow {
  return { ownerSymbolId, kind: "return", name, line, typeName: "Response", typeSource: "annotation" };
}

function symbol(relPath: string, symbolId: string, symbolKind: SymbolDefinitionKind): SymbolDefinition {
  const shortName = symbolId.split(/[#.]/).at(-1) ?? symbolId;
  return { symbolId, fqName: symbolId, shortName, relPath, scope: [], symbolKind };
}

describe("DuckDbGraphClient — a return row's owner kind in the type aggregate", () => {
  let dir: string;
  let db: DuckDbGraphClient;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "cg-identifier-owner-kind-"));
    db = new DuckDbGraphClient({ path: join(dir, "g.duckdb") });
    await db.init();
    await runMigrations(db, DATABASE_MIGRATIONS);
    await db.replaceIdentifiersBulk([
      {
        relPath: "geo/views.py",
        rows: [
          returns("CityViewSet#create", "create", 10),
          returns("RegionViewSet#create", "create", 30),
          returns("geo_error_response", "geo_error_response", 50),
          { ...returns("geo_error_response", "payload", 51), kind: "local" },
        ],
      },
      // A file indexed before its symbols carried a kind: the owner's kind is unknown.
      { relPath: "legacy/views.py", rows: [returns("LegacyViewSet#create", "create", 5)] },
    ]);
    await db.upsertSymbols("geo/views.py", [
      symbol("geo/views.py", "CityViewSet#create", "method"),
      symbol("geo/views.py", "RegionViewSet#create", "method"),
      symbol("geo/views.py", "geo_error_response", "function"),
    ]);
  });

  afterEach(async () => {
    await db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("groupByOwnerKind splits each return group by its owner's kind; an unknown owner reads null", async () => {
    const rows = await db.aggregateIdentifiersByType({
      types: ["Response"],
      groupByOwnerKind: true,
      countHolders: true,
    });
    const returnRows = rows
      .filter((r) => r.kind === "return")
      .map((r) => ({ name: r.name, ownerKind: r.ownerKind, n: r.n, holders: r.holders }))
      .sort((a, b) => `${a.name}${a.ownerKind}`.localeCompare(`${b.name}${b.ownerKind}`));
    expect(returnRows).toEqual([
      { name: "create", ownerKind: "method", n: 2, holders: 2 },
      { name: "create", ownerKind: null, n: 1, holders: 1 },
      { name: "geo_error_response", ownerKind: "function", n: 1, holders: 1 },
    ]);
  });

  it("a value row carries no owner kind: only a return row's name is its owner's", async () => {
    const rows = await db.aggregateIdentifiersByType({ types: ["Response"], groupByOwnerKind: true });
    expect(rows.find((r) => r.kind === "local")).not.toHaveProperty("ownerKind");
  });

  it("without groupByOwnerKind no row carries it and a name's return rows stay one group", async () => {
    const rows = await db.aggregateIdentifiersByType({ types: ["Response"] });
    expect(rows.every((r) => !("ownerKind" in r))).toBe(true);
    expect(rows.find((r) => r.name === "create")?.n).toBe(3);
  });
});

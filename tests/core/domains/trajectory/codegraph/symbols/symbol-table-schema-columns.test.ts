/**
 * Schema-column index of `InMemoryGlobalSymbolTable` (bd tea-rags-mcp-8l5fo).
 *
 * THE anti-explosion invariant: a synthesised AR column accessor (`name` on 300
 * models) must never widen a global short-name candidate set. The table keeps
 * those definitions in a SEPARATE index that `lookupByShortName` excludes by
 * default — only a caller that explicitly opts in (the typed-receiver / MRO
 * paths) can see them.
 */
import { describe, expect, it } from "vitest";

import type { SymbolDefinition } from "../../../../../../src/core/contracts/types/codegraph.js";
import { InMemoryGlobalSymbolTable } from "../../../../../../src/core/domains/trajectory/codegraph/symbols/symbol-table.js";

function sym(symbolId: string, shortName: string, relPath: string, scope: string[]): SymbolDefinition {
  return { symbolId, fqName: symbolId, shortName, relPath, scope };
}

function column(symbolId: string, shortName: string, relPath: string, scope: string[]): SymbolDefinition {
  return { ...sym(symbolId, shortName, relPath, scope), isSchemaColumn: true };
}

describe("InMemoryGlobalSymbolTable schema columns (bd tea-rags-mcp-8l5fo)", () => {
  it("hides schema columns from the default short-name lookup", () => {
    const table = new InMemoryGlobalSymbolTable();
    table.setSchemaColumns([column("Firm#name", "name", "app/models/firm.rb", ["Firm"])]);
    expect(table.lookupByShortName("name")).toEqual([]);
  });

  it("returns schema columns only when the caller opts in", () => {
    const table = new InMemoryGlobalSymbolTable();
    table.setSchemaColumns([column("Firm#name", "name", "app/models/firm.rb", ["Firm"])]);
    const opted = table.lookupByShortName("name", { includeSchemaColumns: true });
    expect(opted.map((d) => d.symbolId)).toEqual(["Firm#name"]);
    expect(opted[0]?.isSchemaColumn).toBe(true);
  });

  it("keeps real definitions first when a caller opts in", () => {
    const table = new InMemoryGlobalSymbolTable();
    table.upsertFile("app/models/firm.rb", [sym("Firm#name", "name", "app/models/firm.rb", ["Firm"])]);
    table.setSchemaColumns([column("Other#name", "name", "app/models/other.rb", ["Other"])]);
    expect(table.lookupByShortName("name", { includeSchemaColumns: true }).map((d) => d.symbolId)).toEqual([
      "Firm#name",
      "Other#name",
    ]);
  });

  it("never surfaces a schema column through the fq lookup", () => {
    const table = new InMemoryGlobalSymbolTable();
    table.setSchemaColumns([column("Firm#name", "name", "app/models/firm.rb", ["Firm"])]);
    expect(table.lookup("Firm#name")).toEqual([]);
  });

  it("excludes schema columns from size() and shortNameDefCounts()", () => {
    const table = new InMemoryGlobalSymbolTable();
    table.upsertFile("app/models/firm.rb", [sym("Firm", "Firm", "app/models/firm.rb", [])]);
    table.setSchemaColumns([
      column("Firm#name", "name", "app/models/firm.rb", ["Firm"]),
      column("Firm#name=", "name=", "app/models/firm.rb", ["Firm"]),
    ]);
    expect(table.size()).toBe(1);
    expect(table.shortNameDefCounts().get("name")).toBeUndefined();
  });

  it("replaces the whole schema-column index on each call (run-scoped, idempotent)", () => {
    const table = new InMemoryGlobalSymbolTable();
    table.setSchemaColumns([column("Firm#name", "name", "app/models/firm.rb", ["Firm"])]);
    table.setSchemaColumns([column("User#email", "email", "app/models/user.rb", ["User"])]);
    expect(table.lookupByShortName("name", { includeSchemaColumns: true })).toEqual([]);
    expect(table.lookupByShortName("email", { includeSchemaColumns: true })).toHaveLength(1);
  });

  it("leaves the schema-column index untouched when a file is re-upserted or removed", () => {
    const table = new InMemoryGlobalSymbolTable();
    table.setSchemaColumns([column("Firm#name", "name", "app/models/firm.rb", ["Firm"])]);
    table.upsertFile("app/models/firm.rb", [sym("Firm", "Firm", "app/models/firm.rb", [])]);
    table.removeFile("app/models/firm.rb");
    expect(table.lookupByShortName("name", { includeSchemaColumns: true })).toHaveLength(1);
  });
});

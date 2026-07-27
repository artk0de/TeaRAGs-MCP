/**
 * Schema-column resolution (bd tea-rags-mcp-8l5fo) — the consumption half of the
 * `db/schema.rb` column-declares pre-pass. Synthesised AR column accessors are
 * reachable through the TYPED-receiver path and the enclosing-class MRO, and
 * through NOTHING else: an untyped receiver and an unrelated caller must see
 * exactly the pre-existing (empty) candidate set.
 */
import { describe, expect, it } from "vitest";

import type {
  CallContext,
  CallRef,
  SymbolDefinition,
} from "../../../../../../../src/core/contracts/types/codegraph.js";
import { RubyCallResolver } from "../../../../../../../src/core/domains/language/ruby/resolver/ruby-resolver.js";
import { InMemoryGlobalSymbolTable } from "../../../../../../../src/core/domains/trajectory/codegraph/symbols/symbol-table.js";

function sym(symbolId: string, shortName: string, relPath: string, scope: string[]): SymbolDefinition {
  return { symbolId, fqName: symbolId, shortName, relPath, scope };
}

function column(symbolId: string, shortName: string, relPath: string, scope: string[]): SymbolDefinition {
  return { ...sym(symbolId, shortName, relPath, scope), isSchemaColumn: true };
}

/** Symbol table holding the `Firm` model plus its synthesised `name` column triple. */
function firmTable(): InMemoryGlobalSymbolTable {
  const table = new InMemoryGlobalSymbolTable();
  table.upsertFile("app/models/firm.rb", [
    sym("Firm", "Firm", "app/models/firm.rb", []),
    sym("Firm#full_name", "full_name", "app/models/firm.rb", ["Firm"]),
  ]);
  table.setSchemaColumns([
    column("Firm#name", "name", "app/models/firm.rb", ["Firm"]),
    column("Firm#name=", "name=", "app/models/firm.rb", ["Firm"]),
    column("Firm#name?", "name?", "app/models/firm.rb", ["Firm"]),
  ]);
  return table;
}

function ctx(overrides: Partial<CallContext> & Pick<CallContext, "symbolTable">): CallContext {
  return { callerFile: "app/models/firm.rb", callerScope: [], imports: [], ...overrides };
}

const call = (receiver: string | null, member: string): CallRef => ({
  callText: receiver === null ? member : `${receiver}.${member}`,
  receiver,
  member,
  startLine: 5,
});

describe("RubyCallResolver — schema-column receivers (bd tea-rags-mcp-8l5fo)", () => {
  it("resolves a typed receiver's column read to the model's synthesised accessor", () => {
    const target = new RubyCallResolver().resolve(
      call("firm", "name"),
      ctx({
        symbolTable: firmTable(),
        callerFile: "app/controllers/firms_controller.rb",
        localBindings: { firm: [{ line: 1, type: "Firm" }] },
      }),
    );
    expect(target).toEqual({ targetRelPath: "app/models/firm.rb", targetSymbolId: "Firm#name" });
  });

  it("resolves a typed receiver's column write to the writer accessor", () => {
    const target = new RubyCallResolver().resolve(
      call("firm", "name="),
      ctx({
        symbolTable: firmTable(),
        callerFile: "app/controllers/firms_controller.rb",
        localBindings: { firm: [{ line: 1, type: "Firm" }] },
      }),
    );
    expect(target?.targetSymbolId).toBe("Firm#name=");
  });

  it("resolves a bare column call inside the model's own method through the MRO", () => {
    const target = new RubyCallResolver().resolve(
      call(null, "name"),
      ctx({ symbolTable: firmTable(), callerScope: ["Firm"], callerSymbolId: "Firm#full_name" }),
    );
    expect(target).toEqual({ targetRelPath: "app/models/firm.rb", targetSymbolId: "Firm#name" });
  });

  it("resolves a bare column call inherited from an ancestor model", () => {
    const table = firmTable();
    const target = new RubyCallResolver().resolve(
      call(null, "name"),
      ctx({
        symbolTable: table,
        callerFile: "app/models/agency.rb",
        callerScope: ["Agency"],
        callerSymbolId: "Agency#label",
        classAncestors: { Agency: ["Firm"] },
      }),
    );
    expect(target?.targetSymbolId).toBe("Firm#name");
  });

  it("prefers a real definition over the synthesised column of the same name", () => {
    const table = new InMemoryGlobalSymbolTable();
    table.upsertFile("app/models/firm.rb", [
      sym("Firm", "Firm", "app/models/firm.rb", []),
      sym("Firm#name", "name", "app/models/firm.rb", ["Firm"]),
    ]);
    table.setSchemaColumns([column("Firm#name", "name", "app/models/firm.rb", ["Firm"])]);
    const target = new RubyCallResolver().resolve(
      call("firm", "name"),
      ctx({
        symbolTable: table,
        callerFile: "app/controllers/firms_controller.rb",
        localBindings: { firm: [{ line: 1, type: "Firm" }] },
      }),
    );
    // Method-level pin survives — the duplicate must not make the pair ambiguous.
    expect(target).toEqual({ targetRelPath: "app/models/firm.rb", targetSymbolId: "Firm#name" });
  });
});

describe("RubyCallResolver — schema columns never fan out (bd tea-rags-mcp-8l5fo)", () => {
  /** Three models all carrying a `name` column — the explosion shape the flag exists to prevent. */
  function threeModelTable(): InMemoryGlobalSymbolTable {
    const table = new InMemoryGlobalSymbolTable();
    const columns: SymbolDefinition[] = [];
    for (const name of ["Firm", "User", "Agency"]) {
      const relPath = `app/models/${name.toLowerCase()}.rb`;
      table.upsertFile(relPath, [sym(name, name, relPath, [])]);
      columns.push(column(`${name}#name`, "name", relPath, [name]));
    }
    table.setSchemaColumns(columns);
    return table;
  }

  it("leaves the global short-name candidate set empty for a column name", () => {
    expect(threeModelTable().lookupByShortName("name")).toEqual([]);
  });

  it("does not resolve an untyped receiver's column call", () => {
    const target = new RubyCallResolver().resolve(
      call("thing", "name"),
      ctx({ symbolTable: threeModelTable(), callerFile: "app/services/report.rb" }),
    );
    expect(target).toBeNull();
  });

  it("does not resolve a bare column call from an unrelated class", () => {
    const target = new RubyCallResolver().resolve(
      call(null, "name"),
      ctx({
        symbolTable: threeModelTable(),
        callerFile: "app/services/report.rb",
        callerScope: ["Report"],
        callerSymbolId: "Report#run",
      }),
    );
    expect(target).toBeNull();
  });

  it("does not resolve a bare column call at file top level (no enclosing model)", () => {
    const target = new RubyCallResolver().resolve(
      call(null, "name"),
      ctx({ symbolTable: threeModelTable(), callerFile: "config/boot.rb" }),
    );
    expect(target).toBeNull();
  });

  it("keeps a dynamic send over a column name out of the dispatch fan-out", () => {
    // `ruby-dynamic-dispatch` is the ONLY feeder of the run's ambiguous-fanout
    // aggregate; its candidate set must not grow by one entry per model.
    const outcome = new RubyCallResolver().resolveDispatch(
      { ...call(null, "name"), dynamicSend: true },
      ctx({ symbolTable: threeModelTable(), callerFile: "app/services/report.rb", callerScope: ["Report"] }),
    );
    expect(outcome.kind === "edges" ? outcome.edges : []).toEqual([]);
  });
});

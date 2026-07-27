/**
 * Project-scope schema-column pre-pass (bd tea-rags-mcp-8l5fo) — the pass-1→pass-2
 * barrier helper that maps `db/schema.rb` tables onto their owning models and
 * synthesises the column accessor definitions ActiveRecord generates at runtime.
 *
 * Pure over injected data (the language facet supplies the parsed tables + the
 * table→model naming convention + the model base classes), mirroring
 * `self-dispatch-discovery.ts`.
 */
import { describe, expect, it } from "vitest";

import type { SymbolDefinition } from "../../../../../../src/core/contracts/types/codegraph.js";
import type { SchemaTableColumns } from "../../../../../../src/core/contracts/types/language.js";
import {
  collectSchemaColumnModels,
  synthesizeSchemaColumnDefs,
  type SchemaColumnModel,
} from "../../../../../../src/core/domains/trajectory/codegraph/symbols/schema-column-synthesis.js";
import { InMemoryGlobalSymbolTable } from "../../../../../../src/core/domains/trajectory/codegraph/symbols/symbol-table.js";

const AR_BASES = ["ApplicationRecord", "ActiveRecord::Base"] as const;

/** `firms` table carrying one real column plus the implicit id. */
const firmsTable: SchemaTableColumns = { table: "firms", accessors: ["id", "id=", "id?", "name", "name=", "name?"] };

/** Rails convention: `firms` → `Firm`, `firm_settings` → `FirmSetting`. */
function modelNameForTable(table: string): string {
  const singular = table.endsWith("s") ? table.slice(0, -1) : table;
  return singular
    .split("_")
    .map((s) => s.charAt(0).toUpperCase() + s.slice(1))
    .join("");
}

function classDef(fqName: string, relPath: string, scope: string[]): SymbolDefinition {
  return { symbolId: fqName, fqName, shortName: fqName.split("::").pop() ?? fqName, relPath, scope };
}

function model(fqName: string, relPath: string, scope: string[], declaredTable?: string): SchemaColumnModel {
  return declaredTable === undefined ? { fqName, relPath, scope } : { fqName, relPath, scope, declaredTable };
}

describe("synthesizeSchemaColumnDefs (bd tea-rags-mcp-8l5fo)", () => {
  it("synthesises every column accessor onto the model the table inflects to", () => {
    const { definitions } = synthesizeSchemaColumnDefs(
      [firmsTable],
      [model("Firm", "app/models/firm.rb", ["Firm"])],
      modelNameForTable,
    );
    expect(definitions.map((d) => d.symbolId).sort()).toEqual([
      "Firm#id",
      "Firm#id=",
      "Firm#id?",
      "Firm#name",
      "Firm#name=",
      "Firm#name?",
    ]);
  });

  it("marks every synthesised definition as a schema column on the model's own file and scope", () => {
    const { definitions } = synthesizeSchemaColumnDefs(
      [{ table: "firms", accessors: ["name"] }],
      [model("Firm", "app/models/firm.rb", ["Firm"])],
      modelNameForTable,
    );
    expect(definitions).toEqual([
      {
        symbolId: "Firm#name",
        fqName: "Firm#name",
        shortName: "name",
        relPath: "app/models/firm.rb",
        scope: ["Firm"],
        isSchemaColumn: true,
      },
    ]);
  });

  it("honours an explicit self.table_name over the inflection guess", () => {
    const { definitions, stats } = synthesizeSchemaColumnDefs(
      [{ table: "companies", accessors: ["name"] }],
      [model("Firm", "app/models/firm.rb", ["Firm"], "companies")],
      modelNameForTable,
    );
    expect(definitions.map((d) => d.symbolId)).toEqual(["Firm#name"]);
    expect(stats.mappedExplicit).toBe(1);
    expect(stats.mappedInflection).toBe(0);
  });

  it("does not let inflection steal a table an explicit declaration already claimed", () => {
    // `Firm` declares `companies`; a `Company` model must NOT also receive them.
    const { definitions } = synthesizeSchemaColumnDefs(
      [{ table: "companies", accessors: ["name"] }],
      [
        model("Firm", "app/models/firm.rb", ["Firm"], "companies"),
        model("Company", "app/models/company.rb", ["Company"]),
      ],
      modelNameForTable,
    );
    expect(definitions.map((d) => d.symbolId)).toEqual(["Firm#name"]);
  });

  it("synthesises onto a nested model with its multi-segment scope", () => {
    const { definitions } = synthesizeSchemaColumnDefs(
      [{ table: "firms", accessors: ["name"] }],
      [model("Admin::Firm", "app/models/admin/firm.rb", ["Admin", "Firm"], "firms")],
      modelNameForTable,
    );
    expect(definitions[0]).toMatchObject({ symbolId: "Admin::Firm#name", scope: ["Admin", "Firm"] });
  });

  it("synthesises onto a compact-declared model with its single-segment scope", () => {
    const { definitions } = synthesizeSchemaColumnDefs(
      [{ table: "firms", accessors: ["name"] }],
      [model("Admin::Firm", "app/models/admin/firm.rb", ["Admin::Firm"], "firms")],
      modelNameForTable,
    );
    expect(definitions[0]).toMatchObject({ symbolId: "Admin::Firm#name", scope: ["Admin::Firm"] });
  });

  it("stays silent when two models share the inflected name (ambiguous, never a guess)", () => {
    const { definitions, stats } = synthesizeSchemaColumnDefs(
      [{ table: "firms", accessors: ["name"] }],
      [
        model("Firm", "app/models/firm.rb", ["Firm"]),
        model("Admin::Firm", "app/models/admin/firm.rb", ["Admin", "Firm"]),
      ],
      modelNameForTable,
    );
    expect(definitions).toEqual([]);
    expect(stats.ambiguous).toBe(1);
  });

  it("stays silent for a table no model claims", () => {
    const { definitions, stats } = synthesizeSchemaColumnDefs(
      [{ table: "ar_internal_metadata", accessors: ["key"] }],
      [model("Firm", "app/models/firm.rb", ["Firm"])],
      modelNameForTable,
    );
    expect(definitions).toEqual([]);
    expect(stats.unmapped).toBe(1);
  });

  it("produces nothing when the schema holds no tables", () => {
    const { definitions } = synthesizeSchemaColumnDefs(
      [],
      [model("Firm", "app/models/firm.rb", ["Firm"])],
      modelNameForTable,
    );
    expect(definitions).toEqual([]);
  });
});

describe("synthesizeSchemaColumnDefs column value types (bd tea-rags-mcp-2a5oo)", () => {
  /** `firms` carrying a typed reader plus the untyped accessors around it. */
  const typedFirms: SchemaTableColumns = {
    table: "firms",
    accessors: ["name", "name=", "name?"],
    accessorReturnTypes: { name: { form: "instance", name: "String" } },
  };

  it("keys each typed accessor by the owning model's method coordinate", () => {
    const { returnTypes } = synthesizeSchemaColumnDefs(
      [typedFirms],
      [model("Firm", "app/models/firm.rb", ["Firm"])],
      modelNameForTable,
    );
    expect(returnTypes).toEqual({ "Firm#name": { form: "instance", name: "String" } });
  });

  it("types the columns of an explicitly declared table onto its declaring model", () => {
    const { returnTypes } = synthesizeSchemaColumnDefs(
      [{ ...typedFirms, table: "companies" }],
      [model("Firm", "app/models/firm.rb", ["Firm"], "companies")],
      modelNameForTable,
    );
    expect(returnTypes).toEqual({ "Firm#name": { form: "instance", name: "String" } });
  });

  it("types a nested model's columns under its fully-qualified name", () => {
    const { returnTypes } = synthesizeSchemaColumnDefs(
      [typedFirms],
      [model("Admin::Firm", "app/models/admin/firm.rb", ["Admin", "Firm"], "firms")],
      modelNameForTable,
    );
    expect(Object.keys(returnTypes)).toEqual(["Admin::Firm#name"]);
  });

  it("preserves a container value type verbatim", () => {
    const { returnTypes } = synthesizeSchemaColumnDefs(
      [
        {
          table: "firms",
          accessors: ["tags", "tags=", "tags?"],
          accessorReturnTypes: { tags: { form: "container", element: { form: "instance", name: "String" } } },
        },
      ],
      [model("Firm", "app/models/firm.rb", ["Firm"])],
      modelNameForTable,
    );
    expect(returnTypes["Firm#tags"]).toEqual({ form: "container", element: { form: "instance", name: "String" } });
  });

  it("types nothing for a table no model claims", () => {
    const { returnTypes } = synthesizeSchemaColumnDefs(
      [{ ...typedFirms, table: "ar_internal_metadata" }],
      [model("Firm", "app/models/firm.rb", ["Firm"])],
      modelNameForTable,
    );
    expect(returnTypes).toEqual({});
  });

  it("types nothing for an ambiguous table (two models share the inflected name)", () => {
    const { returnTypes } = synthesizeSchemaColumnDefs(
      [typedFirms],
      [
        model("Firm", "app/models/firm.rb", ["Firm"]),
        model("Admin::Firm", "app/models/admin/firm.rb", ["Admin", "Firm"]),
      ],
      modelNameForTable,
    );
    expect(returnTypes).toEqual({});
  });

  it("types nothing for a table whose columns carry no value types", () => {
    const { returnTypes } = synthesizeSchemaColumnDefs(
      [{ table: "firms", accessors: ["name", "name=", "name?"] }],
      [model("Firm", "app/models/firm.rb", ["Firm"])],
      modelNameForTable,
    );
    expect(returnTypes).toEqual({});
  });

  it("counts the typed columns in the run stats", () => {
    const { stats } = synthesizeSchemaColumnDefs(
      [typedFirms],
      [model("Firm", "app/models/firm.rb", ["Firm"])],
      modelNameForTable,
    );
    expect(stats.typedColumns).toBe(1);
  });

  // ANTI-EXPLOSION (8l5fo pin, re-asserted): value types are a SEPARATE output.
  // The definitions a typed table synthesises are byte-identical to the untyped
  // run's, so nothing about the short-name indexes can move.
  it("synthesises exactly the same definitions with and without value types", () => {
    const withTypes = synthesizeSchemaColumnDefs(
      [typedFirms],
      [model("Firm", "app/models/firm.rb", ["Firm"])],
      modelNameForTable,
    );
    const withoutTypes = synthesizeSchemaColumnDefs(
      [{ table: "firms", accessors: ["name", "name=", "name?"] }],
      [model("Firm", "app/models/firm.rb", ["Firm"])],
      modelNameForTable,
    );
    expect(withTypes.definitions).toEqual(withoutTypes.definitions);
    expect(withTypes.stats.definitions).toBe(withoutTypes.stats.definitions);
  });
});

describe("collectSchemaColumnModels (bd tea-rags-mcp-8l5fo)", () => {
  it("collects a class whose ancestry reaches an ActiveRecord base", () => {
    const symbolTable = new InMemoryGlobalSymbolTable();
    symbolTable.upsertFile("app/models/firm.rb", [classDef("Firm", "app/models/firm.rb", [])]);
    expect(
      collectSchemaColumnModels({
        classAncestors: { Firm: ["ApplicationRecord"] },
        declaredTables: {},
        modelBaseClasses: AR_BASES,
        symbolTable,
      }),
    ).toEqual([{ fqName: "Firm", relPath: "app/models/firm.rb", scope: ["Firm"] }]);
  });

  it("follows the ancestry transitively through an intermediate base", () => {
    const symbolTable = new InMemoryGlobalSymbolTable();
    symbolTable.upsertFile("app/models/firm.rb", [classDef("Firm", "app/models/firm.rb", [])]);
    symbolTable.upsertFile("app/models/base_model.rb", [classDef("BaseModel", "app/models/base_model.rb", [])]);
    const models = collectSchemaColumnModels({
      classAncestors: { Firm: ["BaseModel"], BaseModel: ["ApplicationRecord"] },
      declaredTables: {},
      modelBaseClasses: AR_BASES,
      symbolTable,
    });
    expect(models.map((m) => m.fqName).sort()).toEqual(["BaseModel", "Firm"]);
  });

  it("skips a class whose ancestry never reaches an ActiveRecord base", () => {
    const symbolTable = new InMemoryGlobalSymbolTable();
    symbolTable.upsertFile("app/services/importer.rb", [classDef("Importer", "app/services/importer.rb", [])]);
    expect(
      collectSchemaColumnModels({
        classAncestors: { Importer: ["ApplicationService"] },
        declaredTables: {},
        modelBaseClasses: AR_BASES,
        symbolTable,
      }),
    ).toEqual([]);
  });

  it("derives a nested model's member scope from its class-body definition", () => {
    const symbolTable = new InMemoryGlobalSymbolTable();
    symbolTable.upsertFile("app/models/admin/firm.rb", [
      classDef("Admin::Firm", "app/models/admin/firm.rb", ["Admin"]),
    ]);
    expect(
      collectSchemaColumnModels({
        classAncestors: { "Admin::Firm": ["ApplicationRecord"] },
        declaredTables: {},
        modelBaseClasses: AR_BASES,
        symbolTable,
      })[0]?.scope,
    ).toEqual(["Admin", "Firm"]);
  });

  it("derives a compact-declared model's member scope as one segment", () => {
    const symbolTable = new InMemoryGlobalSymbolTable();
    symbolTable.upsertFile("app/models/admin/firm.rb", [classDef("Admin::Firm", "app/models/admin/firm.rb", [])]);
    expect(
      collectSchemaColumnModels({
        classAncestors: { "Admin::Firm": ["ApplicationRecord"] },
        declaredTables: {},
        modelBaseClasses: AR_BASES,
        symbolTable,
      })[0]?.scope,
    ).toEqual(["Admin::Firm"]);
  });

  it("carries the explicit table declaration onto the collected model", () => {
    const symbolTable = new InMemoryGlobalSymbolTable();
    symbolTable.upsertFile("app/models/firm.rb", [classDef("Firm", "app/models/firm.rb", [])]);
    expect(
      collectSchemaColumnModels({
        classAncestors: { Firm: ["ApplicationRecord"] },
        declaredTables: { Firm: "companies" },
        modelBaseClasses: AR_BASES,
        symbolTable,
      })[0]?.declaredTable,
    ).toBe("companies");
  });

  it("skips a model whose declaring file the symbol table does not know", () => {
    expect(
      collectSchemaColumnModels({
        classAncestors: { Firm: ["ApplicationRecord"] },
        declaredTables: {},
        modelBaseClasses: AR_BASES,
        symbolTable: new InMemoryGlobalSymbolTable(),
      }),
    ).toEqual([]);
  });

  it("terminates on a cyclic ancestry chain", () => {
    const symbolTable = new InMemoryGlobalSymbolTable();
    symbolTable.upsertFile("a.rb", [classDef("A", "a.rb", [])]);
    expect(
      collectSchemaColumnModels({
        classAncestors: { A: ["B"], B: ["A"] },
        declaredTables: {},
        modelBaseClasses: AR_BASES,
        symbolTable,
      }),
    ).toEqual([]);
  });
});

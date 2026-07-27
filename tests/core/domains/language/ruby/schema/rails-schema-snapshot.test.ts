import { describe, expect, it } from "vitest";

import {
  parseRailsSchemaSnapshot,
  railsModelNameForTable,
  RAILS_SCHEMA_COLUMN_ACCESSORS,
} from "../../../../../../src/core/domains/language/ruby/schema/index.js";

/** Accessors of one table, sorted — the reader's order is not part of the contract. */
function accessorsOf(source: string, table: string): string[] {
  const found = parseRailsSchemaSnapshot(source).find((t) => t.table === table);
  return [...(found?.accessors ?? [])].sort();
}

describe("parseRailsSchemaSnapshot (bd tea-rags-mcp-8l5fo)", () => {
  it("expands every column into the reader / writer / query accessor triple", () => {
    const source = [
      'create_table "firms", force: :cascade do |t|',
      '  t.string "name"',
      "end",
      "",
    ].join("\n");
    expect(accessorsOf(source, "firms")).toEqual(["id", "id=", "id?", "name", "name=", "name?"]);
  });

  it("synthesises the implicit `id` primary key", () => {
    const source = ['create_table "firms", force: :cascade do |t|', "end", ""].join("\n");
    expect(accessorsOf(source, "firms")).toEqual(["id", "id=", "id?"]);
  });

  it("omits `id` when the table declares `id: false`", () => {
    const source = ['create_table "joins", id: false, force: :cascade do |t|', '  t.integer "firm_id"', "end", ""].join(
      "\n",
    );
    expect(accessorsOf(source, "joins")).toEqual(["firm_id", "firm_id=", "firm_id?"]);
  });

  it("uses the declared `primary_key:` name instead of `id`", () => {
    const source = ['create_table "legacy", primary_key: "uuid", force: :cascade do |t|', "end", ""].join("\n");
    expect(accessorsOf(source, "legacy")).toEqual(["uuid", "uuid=", "uuid?"]);
  });

  it("expands `t.timestamps` into created_at / updated_at", () => {
    const source = ['create_table "firms", id: false, force: :cascade do |t|', "  t.timestamps", "end", ""].join("\n");
    expect(accessorsOf(source, "firms")).toEqual([
      "created_at",
      "created_at=",
      "created_at?",
      "updated_at",
      "updated_at=",
      "updated_at?",
    ]);
  });

  it("ignores index / constraint statements — they declare no column", () => {
    const source = [
      'create_table "firms", id: false, force: :cascade do |t|',
      '  t.string "name"',
      '  t.index ["name"], name: "index_firms_on_name"',
      '  t.check_constraint "name IS NOT NULL"',
      "end",
      "",
    ].join("\n");
    expect(accessorsOf(source, "firms")).toEqual(["name", "name=", "name?"]);
  });

  it("keeps consecutive tables separate", () => {
    const source = [
      'create_table "firms", id: false, force: :cascade do |t|',
      '  t.string "name"',
      "end",
      "",
      'create_table "users", id: false, force: :cascade do |t|',
      '  t.string "email"',
      "end",
      "",
    ].join("\n");
    expect(parseRailsSchemaSnapshot(source).map((t) => t.table)).toEqual(["firms", "users"]);
    expect(accessorsOf(source, "users")).toEqual(["email", "email=", "email?"]);
  });

  it("returns nothing for a snapshot with no create_table blocks", () => {
    expect(parseRailsSchemaSnapshot('enable_extension "plpgsql"\n')).toEqual([]);
  });
});

describe("railsModelNameForTable (bd tea-rags-mcp-8l5fo)", () => {
  it("singularizes and camelizes a snake_case table name", () => {
    expect(railsModelNameForTable("firms")).toBe("Firm");
    expect(railsModelNameForTable("firm_settings")).toBe("FirmSetting");
    expect(railsModelNameForTable("categories")).toBe("Category");
  });
});

describe("RAILS_SCHEMA_COLUMN_ACCESSORS facet (bd tea-rags-mcp-8l5fo)", () => {
  it("declares the Rails schema snapshot path and the ActiveRecord model base classes", () => {
    expect(RAILS_SCHEMA_COLUMN_ACCESSORS.schemaRelPath).toBe("db/schema.rb");
    expect([...RAILS_SCHEMA_COLUMN_ACCESSORS.modelBaseClasses].sort()).toEqual([
      "ActiveRecord::Base",
      "ApplicationRecord",
    ]);
  });

  it("exposes the reader + naming convention through the language-agnostic facet", () => {
    // The parse output also carries the readers' value types (bd tea-rags-mcp-2a5oo);
    // the implicit `id` key is a bigint, hence Integer.
    expect(RAILS_SCHEMA_COLUMN_ACCESSORS.parseSchema('create_table "firms" do |t|\nend\n')).toEqual([
      {
        table: "firms",
        accessors: ["id", "id=", "id?"],
        accessorReturnTypes: { id: { form: "instance", name: "Integer" } },
      },
    ]);
    expect(RAILS_SCHEMA_COLUMN_ACCESSORS.modelNameForTable("firms")).toBe("Firm");
  });
});
